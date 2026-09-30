// Platformer — Co-op Climb, Platform Race, Brawl and Tag share this page.
// Everybody moves their own character and tells the others where it is (30 times a second).
// The host decides the shared things: switches and doors, who carries the key, finishing order, knock-outs.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const T = PF.T;
  const VW = 960;
  const VH = 544;
  const RACE_GRACE = 30000; // how long the others get after the first finish
  const TAG_SAFE = 1500; // after a tag, nobody can be tagged straight back
  const MAPS_KEY = "pf:maps";

  const MODES = {
    coop: {
      title: "Co-op Climb",
      blurb: "A platformer you can only beat together: stand on each other's heads, hold switches for each other and bring the key to the exit. 2–4 players.",
      min: 2,
      controls: "<kbd>←</kbd> <kbd>→</kbd> move · <kbd>↑</kbd>/<kbd>Space</kbd> jump · <kbd>↑</kbd> at the exit to go in · <kbd>Esc</kbd> menu",
    },
    race: {
      title: "Platform Race",
      blurb: "Everybody runs the same level at once. First to the chequered flag scores the most. 1–4 players.",
      min: 1,
      controls: "<kbd>←</kbd> <kbd>→</kbd> move · <kbd>↑</kbd>/<kbd>Space</kbd> jump · <kbd>↓</kbd> drop through · <kbd>Esc</kbd> menu",
    },
    brawl: {
      title: "Brawl",
      blurb: "Knock everybody else off the stage. The more damage they have, the further they fly. 2–4 players.",
      min: 1,
      controls: "<kbd>←</kbd> <kbd>→</kbd> move · <kbd>↑</kbd>/<kbd>Space</kbd> jump · <kbd>J</kbd>/<kbd>X</kbd> hit · <kbd>Esc</kbd> menu",
    },
    tag: {
      title: "Tag",
      blurb: "Whoever is it has to touch somebody else to pass it on. The least time spent as it wins. 2–4 players.",
      min: 2,
      controls: "<kbd>←</kbd> <kbd>→</kbd> move · <kbd>↑</kbd>/<kbd>Space</kbd> jump · <kbd>↓</kbd> drop through · <kbd>Esc</kbd> menu",
    },
  };
  const urlMode = MODES[WG.params().get("mode")] ? WG.params().get("mode") : "coop";
  // Tag is played on the brawl arenas
  const levelMode = (m) => (m === "tag" ? "brawl" : m);

  const view = ARC.view($("game"), VW, VH);

  let room = null;
  let mode = urlMode;
  let map = null;
  let me = null; // my body while playing
  let st = null; // my extra state: stocks, damage, timers…
  let spawnPoint = null;
  const others = new Map(); // id -> remote player
  let world = { open: {}, unlocked: true, key: null, entered: [], flagsHit: new Set() };
  let phase = "idle"; // idle | countdown | play | done
  let phaseEnd = 0;
  let raceStart = 0;
  let raceEnds = 0;
  let info = { index: 0, count: 1, name: "", scores: {}, lives: 3 };
  const cam = { x: 0, y: 0 };

  // host only
  let match = null;

  /* ---------- Lobby ---------- */

  function myMaps() {
    const list = WG.store.get(MAPS_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function levelOptions(values) {
    const m = levelMode(values.mode || urlMode);
    const builtIn = PLATFORM_LEVELS[m];
    const brawl = m === "brawl";
    const out = [
      { value: "num", label: brawl ? "Arenas 1–" + PFGEN.LEVELS : "Levels 1–" + PFGEN.LEVELS },
      { value: "rnd", label: brawl ? "Random arena" : "Random levels (new every time)" },
    ];
    if (!brawl) out.push({ value: "all", label: "Hand-made levels (" + builtIn.length + ")" });
    builtIn.forEach((lv, i) => out.push({ value: "b" + i, label: "Hand-made: " + lv.name }));
    myMaps()
      .filter((x) => x.mode === m)
      .forEach((x) => out.push({ value: "m" + x.id, label: "★ " + x.name }));
    return out;
  }

  function numberOptions(values) {
    const word = levelMode(values.mode) === "brawl" ? "Arena " : "Level ";
    return Array.from({ length: PFGEN.LEVELS }, (_, i) => ({ value: i + 1, label: word + (i + 1) }));
  }

  // Generated levels are only made when their turn comes (see startLevel).
  function playlist(m, v) {
    const builtIn = PLATFORM_LEVELS[levelMode(m)];
    const count = m === "brawl" ? 1 : v.count || 5;
    if (v.level === "num") {
      const list = [];
      for (let n = v.from || 1; list.length < count && n <= PFGEN.LEVELS; n++) list.push({ num: n });
      return list;
    }
    if (v.level === "rnd") {
      // random levels still get a little harder as the evening goes on
      return Array.from({ length: count }, (_, i) => ({ random: true, d: count > 1 ? 0.2 + (0.6 * i) / (count - 1) : undefined }));
    }
    if (v.level === "all") return builtIn.slice();
    let one;
    if (/^b\d+$/.test(v.level)) {
      one = builtIn[Number(v.level.slice(1))] || builtIn[0];
    } else {
      const mine = myMaps().find((x) => "m" + x.id === v.level);
      one = mine ? { name: mine.name, rows: mine.rows } : builtIn[0];
    }
    // a single tag arena is played for several rounds
    return m === "tag" ? Array.from({ length: count }, () => one) : [one];
  }

  // The Map Maker's "Host a room with it" arrives with ?map=<id>
  function firstLevel() {
    const id = WG.params().get("map");
    if (id && myMaps().some((x) => x.id === id && x.mode === levelMode(urlMode))) return "m" + id;
    return levelMode(urlMode) === "brawl" ? "rnd" : "num";
  }

  function setMode(m) {
    mode = m;
    $("title").textContent = MODES[m].title;
    document.title = MODES[m].title;
    $("controls").innerHTML = MODES[m].controls;
  }
  setMode(urlMode);

  LOBBY.init({
    game: "platformer",
    title: MODES[urlMode].title,
    blurb: MODES[urlMode].blurb,
    minPlayers: (v) => MODES[v.mode].min,
    lateNote: "A level is being played — you drop in any moment.",
    settings: [
      {
        key: "mode",
        label: "Game",
        value: urlMode,
        options: [
          { value: "coop", label: "Co-op Climb" },
          { value: "race", label: "Platform Race" },
          { value: "brawl", label: "Brawl" },
          { value: "tag", label: "Tag" },
        ],
      },
      { key: "level", label: "Levels", value: firstLevel(), options: levelOptions },
      { key: "from", label: "Start at", value: 1, show: (v) => v.level === "num", options: numberOptions },
      {
        key: "count",
        label: "How many",
        value: 5,
        show: (v) => v.mode === "tag" || (v.mode !== "brawl" && (v.level === "num" || v.level === "rnd")),
        options: (v) =>
          [3, 5, 10, 20].map((n) => ({ value: n, label: n + (v.mode === "tag" ? " rounds" : " levels") })),
      },
      {
        key: "time",
        label: "Round length",
        value: 60,
        show: (v) => v.mode === "tag",
        options: [
          { value: 45, label: "45 seconds" },
          { value: 60, label: "1 minute" },
          { value: 90, label: "1½ minutes" },
        ],
      },
      {
        key: "lives",
        label: "Lives",
        value: 3,
        show: (v) => v.mode === "brawl",
        options: [
          { value: 1, label: "1" },
          { value: 3, label: "3" },
          { value: 5, label: "5" },
        ],
      },
    ],
    onRoom,
    onStart: startMatch,
    onLobby: stopAll,
    onSettings: (v) => setMode(v.mode),
  });

  const loop = ARC.loop(update, draw);
  loop.start();

  function onRoom(r) {
    room = r;
    room.on("pf.level", onLevel);
    room.on("pf.p", onRemote);
    room.on("pf.w", onWorld);
    room.on("pf.hit", onHit);
    room.on("pf.clear", () => {
      phase = "done";
      ARC.banner("Level complete!", 2200);
    });
    room.on("pf.round", (d) => {
      phase = "done";
      info.scores = d.scores;
      ARC.banner(d.title, 3000);
      renderHud();
    });
    room.on("players", () => {
      others.forEach((o, id) => {
        if (!room.player(id)) others.delete(id);
      });
      renderHud();
    });

    if (room.isHost) {
      room.on("pf.grab", (d, from) => hostGrab(from));
      room.on("pf.drop", (d, from) => hostDrop(from));
      room.on("pf.unlock", (d, from) => hostUnlock(from));
      room.on("pf.enter", (d, from) => hostEnter(from, true));
      room.on("pf.exit", (d, from) => hostEnter(from, false));
      room.on("pf.fin", (d, from) => hostFinish(from, d));
      room.on("pf.ko", (d, from) => hostKO(from, d));
      room.on("pf.tag", (d, from) => hostTag(from, d));
      room.on("join", (p) => {
        if (!match) return;
        match.scores[p.id] = match.scores[p.id] || 0;
        if (match.mode === "brawl") match.stocks[p.id] = 0; // watches until the next match
        if (match.mode === "tag" && match.itTime[p.id] === undefined) {
          // a late arrival starts with the average so far, not with a clean sheet
          const times = Object.values(match.itTime);
          match.itTime[p.id] = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
        }
        room.to(p.id, "pf.level", levelPayload(p.id));
        room.to(p.id, "pf.w", worldPayload());
      });
      room.on("leave", (p) => {
        if (!match) return;
        hostDrop(p.id);
        match.entered.delete(p.id);
        if (match.mode === "brawl" && match.stocks[p.id] > 0) {
          match.stocks[p.id] = 0;
          match.outOrder.push(p.id);
          checkBrawlEnd();
        }
        if (match.mode === "tag" && match.it === p.id && room.players.length) {
          match.it = WG.pick(room.players).id;
          match.tagSafe = performance.now() + TAG_SAFE;
        }
        sendWorld();
      });
    }
  }

  function stopAll() {
    phase = "idle";
    match = null;
    me = null;
    others.clear();
    ARC.banner("");
    renderHud();
  }

  /* ---------- Host: levels and the shared world ---------- */

  function startMatch(values) {
    match = {
      mode: values.mode,
      list: playlist(values.mode, values),
      index: 0,
      lives: values.lives || 3,
      time: values.time || 60,
      scores: {},
      itTime: {}, // tag: milliseconds each player has spent as "it"
      started: room.players.length,
    };
    room.players.forEach((p) => {
      match.scores[p.id] = 0;
      match.itTime[p.id] = 0;
    });
    startLevel();
  }

  function startLevel() {
    let lv = match.list[match.index];
    if (lv.num) lv = PFGEN.numbered(levelMode(match.mode), lv.num);
    else if (lv.random) lv = PFGEN.random(levelMode(match.mode), lv.d);
    match.level = { name: lv.name, rows: lv.rows };
    match.map = PF.parse({ name: lv.name, rows: lv.rows, mode: levelMode(match.mode) });
    match.open = {};
    match.entered = new Set();
    match.finished = new Map();
    match.firstFinish = 0;
    match.over = false;
    match.stocks = {};
    match.outOrder = [];
    match.startedWith = room.players.map((p) => p.id);
    room.players.forEach((p) => (match.stocks[p.id] = match.lives));
    const k = match.map.keys[0];
    match.key = k ? { home: { x: k.x, y: k.y }, x: k.x, y: k.y, carrier: null } : null;
    match.unlocked = !match.key;
    if (match.mode === "tag") {
      // it starts with somebody random; the clock starts after the 3-second countdown
      const now = performance.now();
      match.it = WG.pick(room.players).id;
      match.tagSafe = 0;
      match.roundStart = now + 3000;
      match.roundEnd = match.roundStart + match.time * 1000;
      match.lastTick = now;
      match.lastSync = now;
    }
    room.players.forEach((p) => room.to(p.id, "pf.level", levelPayload(p.id)));
    sendWorld();
  }

  function levelPayload(forId) {
    return {
      mode: match.mode,
      level: match.level,
      index: match.index,
      count: match.list.length,
      scores: match.scores,
      lives: match.lives,
      spectate: match.mode === "brawl" && !match.startedWith.includes(forId),
    };
  }

  function worldPayload() {
    return {
      open: match.open,
      unlocked: match.unlocked,
      key: match.key ? { x: match.key.x, y: match.key.y, carrier: match.key.carrier } : null,
      entered: [...match.entered],
      finished: [...match.finished.keys()],
      endsIn: match.firstFinish ? Math.max(0, match.firstFinish + RACE_GRACE - performance.now()) : 0,
      it: match.mode === "tag" ? match.it : null,
      itTime: match.mode === "tag" ? roundTimes(match.itTime) : null,
      tagEndsIn: match.mode === "tag" ? Math.max(0, match.roundEnd - performance.now()) : 0,
      safeFor: match.mode === "tag" ? Math.max(0, match.tagSafe - performance.now()) : 0,
    };
  }

  function roundTimes(times) {
    const out = {};
    Object.keys(times).forEach((id) => (out[id] = Math.round(times[id] / 100) * 100));
    return out;
  }

  function sendWorld() {
    if (!match) return;
    const d = worldPayload();
    room.send("pf.w", d);
    onWorld(d);
  }

  function hostGrab(id) {
    if (!match || !match.key || match.key.carrier || match.unlocked) return;
    match.key.carrier = id;
    sendWorld();
  }

  function hostDrop(id) {
    if (!match || !match.key || match.key.carrier !== id) return;
    match.key.carrier = null;
    match.key.x = match.key.home.x;
    match.key.y = match.key.home.y;
    sendWorld();
  }

  function hostUnlock(id) {
    if (!match || !match.key || match.key.carrier !== id) return;
    match.key.carrier = null;
    match.unlocked = true;
    sendWorld();
  }

  function hostEnter(id, inside) {
    if (!match || match.mode !== "coop") return;
    if (inside) match.entered.add(id);
    else match.entered.delete(id);
    sendWorld();
  }

  function hostFinish(id, d) {
    if (!match || match.mode !== "race" || match.finished.has(id) || match.over) return;
    match.finished.set(id, Math.max(0, Number(d.t) || 0));
    if (!match.firstFinish) match.firstFinish = performance.now();
    sendWorld();
  }

  function hostKO(id, d) {
    if (!match || match.mode !== "brawl" || match.over) return;
    const left = Math.max(0, Math.floor(Number(d.stocks) || 0));
    if (match.stocks[id] > 0 && left === 0) match.outOrder.push(id);
    match.stocks[id] = left;
    checkBrawlEnd();
  }

  function hostTag(id, d) {
    if (!match || match.mode !== "tag" || match.over || match.it !== id) return;
    const to = d && d.to;
    const now = performance.now();
    if (to === id || !room.player(to) || now < match.tagSafe || now < match.roundStart) return;
    match.it = to;
    match.tagSafe = now + TAG_SAFE;
    sendWorld();
  }

  function checkBrawlEnd() {
    const inGame = room.players.filter((p) => match.startedWith.includes(p.id));
    const alive = inGame.filter((p) => match.stocks[p.id] > 0);
    const over = match.startedWith.length > 1 ? alive.length <= 1 : alive.length === 0;
    if (!over || match.over) return;
    match.over = true;
    const order = alive.map((p) => p.id).concat(match.outOrder.slice().reverse());
    const rows = order
      .map((id) => room.player(id))
      .filter(Boolean)
      .map((p, i) => ({
        name: p.name,
        color: p.color,
        value: i === 0 && alive.length ? "Winner" : "#" + (i + 1),
        note: match.stocks[p.id] > 0 ? match.stocks[p.id] + " lives left" : "",
      }));
    const title = alive.length ? room.player(order[0]).name + " wins!" : "Game over";
    setTimeout(() => {
      if (!match) return;
      match = null;
      phase = "idle";
      LOBBY.results(rows, title);
    }, 1800);
    room.send("pf.round", { title: title, scores: info.scores });
    phase = "done";
    ARC.banner(title, 1800);
  }

  function hostUpdate() {
    if (!match || match.over) return;
    // switches: held while anybody stands on one
    const boxes = [];
    if (me && !hidden()) boxes.push(me);
    others.forEach((o) => {
      if (o.raw && !(o.raw.flags & 1)) boxes.push({ x: o.raw.x, y: o.raw.y, w: PF.PW, h: PF.PH });
    });
    const open = PF.pressed(match.map, boxes);
    if (Object.keys(open).sort().join() !== Object.keys(match.open).sort().join()) {
      match.open = open;
      sendWorld();
    }

    if (match.mode === "coop") {
      const everyone = room.players.length > 0 && room.players.every((p) => match.entered.has(p.id));
      if (everyone) {
        match.over = true;
        room.send("pf.clear");
        phase = "done";
        ARC.banner("Level complete!", 2200);
        setTimeout(nextLevel, 2600);
      }
    } else if (match.mode === "race") {
      const everyone = room.players.every((p) => match.finished.has(p.id));
      const late = match.firstFinish && performance.now() > match.firstFinish + RACE_GRACE;
      if (everyone || late) {
        match.over = true;
        const order = [...match.finished.entries()].sort((a, b) => a[1] - b[1]);
        const points = [3, 2, 1, 0];
        order.forEach(([id], i) => {
          match.scores[id] = (match.scores[id] || 0) + (points[i] || 0);
        });
        const first = order.length ? room.player(order[0][0]) : null;
        const title = first ? first.name + " wins the race!" : "Nobody made it";
        room.send("pf.round", { title, scores: match.scores });
        info.scores = match.scores;
        phase = "done";
        ARC.banner(title, 3000);
        renderHud();
        setTimeout(nextLevel, 3400);
      }
    } else if (match.mode === "tag") {
      const now = performance.now();
      if (now > match.roundStart && match.itTime[match.it] !== undefined) {
        match.itTime[match.it] += now - Math.max(match.lastTick, match.roundStart);
      }
      match.lastTick = now;
      if (now >= match.roundEnd) {
        match.over = true;
        const it = room.player(match.it);
        const title = it ? "Time's up — " + it.name + " was it!" : "Time's up!";
        sendWorld();
        room.send("pf.round", { title, scores: match.scores });
        phase = "done";
        ARC.banner(title, 3000);
        setTimeout(nextLevel, 3400);
      } else if (now - match.lastSync > 1000) {
        // keeps everybody's clocks and "time as it" in step
        match.lastSync = now;
        sendWorld();
      }
    }
  }

  function nextLevel() {
    if (!match) return;
    match.index++;
    if (match.index < match.list.length) {
      startLevel();
      return;
    }
    // the playlist is done
    if (match.mode === "tag") {
      const ranked = room.players
        .map((p) => ({ p, t: match.itTime[p.id] || 0 }))
        .sort((a, b) => a.t - b.t)
        .map(({ p, t }) => ({ name: p.name, color: p.color, value: (t / 1000).toFixed(1) + " s", note: "time as it" }));
      match = null;
      phase = "idle";
      LOBBY.results(ranked, ranked.length ? ranked[0].name + " wins!" : "Game over");
      return;
    }
    const rows = room.players
      .map((p) => ({ p, s: match.scores[p.id] || 0 }))
      .sort((a, b) => b.s - a.s)
      .map(({ p, s }) => ({ name: p.name, color: p.color, value: match.mode === "race" ? s + " pts" : "✓" }));
    const title =
      match.mode === "race"
        ? rows.length
          ? rows[0].name + " wins!"
          : "Race over"
        : "Every level done — well played, team!";
    match = null;
    phase = "idle";
    LOBBY.results(rows, title);
  }

  /* ---------- Everybody: level, world, the others ---------- */

  function onLevel(d) {
    setMode(d.mode);
    map = PF.parse({ name: d.level.name, rows: d.level.rows, mode: levelMode(d.mode) });
    view.resize(Math.min(VW, map.pw), Math.min(VH, map.ph));
    others.clear();
    world = {
      open: {},
      unlocked: true,
      key: null,
      entered: [],
      finished: [],
      flagsHit: new Set(),
      it: null,
      itTime: {},
      tagEnds: 0,
      safeUntil: 0,
    };
    info = { index: d.index, count: d.count, name: map.name, scores: d.scores || {}, lives: d.lives };
    raceEnds = 0;

    const my = room.player(room.myId);
    const spots = map.spawns;
    spawnPoint = spots[(my ? my.color : 0) % spots.length];
    me = PF.makePlayer(spawnPoint);
    st = {
      stocks: d.spectate ? 0 : d.lives,
      dmg: 0,
      dead: 0,
      entered: false,
      finished: false,
      out: !!d.spectate,
      invuln: 0,
      attack: 0,
      cooldown: 0,
      hits: new Set(),
      askedGrab: 0,
      askedUnlock: 0,
      askedTag: 0,
    };
    if (d.mode === "coop") {
      phase = "play";
      ARC.banner(map.name, 1600);
    } else {
      phase = "countdown";
      phaseEnd = performance.now() + 3000;
    }
    LOBBY.hide();
    renderHud();
  }

  function onWorld(d) {
    world.open = d.open || {};
    world.unlocked = d.unlocked;
    world.key = d.key;
    world.entered = d.entered || [];
    world.finished = d.finished || [];
    if (d.endsIn && !raceEnds) raceEnds = performance.now() + d.endsIn;
    if (d.it !== undefined && d.it !== null) {
      const now = performance.now();
      if (world.it && d.it !== world.it && room) {
        const p = room.player(d.it);
        if (d.it === room.myId) ARC.banner("You're it!", 1200);
        else if (p) WG.toast(p.name + " is it!", 1200);
      }
      world.it = d.it;
      world.itTime = d.itTime || {};
      world.tagEnds = now + d.tagEndsIn;
      world.safeUntil = now + (d.safeFor || 0);
    }
    renderHud();
  }

  function onRemote(a, from) {
    if (from === room.myId) return;
    let o = others.get(from);
    if (!o) {
      o = { buf: ARC.snapshots(), box: { x: a[0], y: a[1], w: PF.PW, h: PF.PH, dx: 0, dy: 0 }, face: 1, flags: 0 };
      others.set(from, o);
    }
    const s = { x: a[0], y: a[1], face: a[2], flags: a[3], dmg: a[4], stocks: a[5] };
    o.buf.push(s, a[6]);
    o.raw = s;
  }

  function onHit(d) {
    if (!me || !st || d.to !== room.myId || hidden() || st.invuln > 0 || phase !== "play") return;
    st.dmg += d.dmg;
    const kb = 280 + st.dmg * 6.5;
    me.vx = d.dir * kb;
    me.vy = -Math.min(kb * 0.55, 950) - 140;
    me.ground = false;
    me.stun = 0.16 + st.dmg / 420;
  }

  function hidden() {
    return !st || st.dead > 0 || st.entered || st.finished || st.out;
  }

  /* ---------- Every tick ---------- */

  function update(dt) {
    if (!room || !map || phase === "idle") return;
    const now = performance.now();

    // glide the others between their updates
    others.forEach((o) => {
      const s = o.buf.sample();
      if (!s) return;
      const x = ARC.lerp(s.a.x, s.b.x, s.t);
      const y = ARC.lerp(s.a.y, s.b.y, s.t);
      o.box.dx = x - o.box.x;
      o.box.dy = y - o.box.y;
      o.box.x = x;
      o.box.y = y;
      o.face = s.b.face;
      o.flags = s.b.flags;
      o.dmg = s.b.dmg;
      o.stocks = s.b.stocks;
    });

    if (phase === "countdown" && now >= phaseEnd) {
      phase = "play";
      raceStart = now;
      ARC.banner("Go!", 700);
    }

    if (me) {
      // where I was before this step, so drawing can blend towards where I am now
      me.px = me.x;
      me.py = me.y;
    }
    if (me && phase === "play") stepMe(dt);
    if (me) {
      // every step, 60 times a second, stamped with the time it was sent
      let flags = 0;
      if (hidden()) flags |= 1;
      if (st.attack > 0) flags |= 2;
      if (st.invuln > 0) flags |= 4;
      room.share("pf.p", [
        Math.round(me.x * 10) / 10,
        Math.round(me.y * 10) / 10,
        me.face,
        flags,
        Math.round(st.dmg),
        st.stocks,
        Math.round(performance.now() * 10) / 10,
      ]);
    }
    if (room.isHost) hostUpdate();
  }

  function stepMe(dt) {
    st.invuln = Math.max(0, st.invuln - dt);
    st.cooldown = Math.max(0, st.cooldown - dt);
    st.attack = Math.max(0, st.attack - dt);

    if (st.dead > 0) {
      st.dead -= dt;
      if (st.dead <= 0) respawn();
      return;
    }
    if (st.entered) {
      if (ARC.input.hit("down")) {
        st.entered = false;
        room.to(room.hostId, "pf.exit");
      }
      return;
    }
    if (st.finished || st.out) return;

    const input = {
      left: ARC.input.held("left"),
      right: ARC.input.held("right"),
      jump: ARC.input.held("jump"),
      jumpHit: ARC.input.hit("jump"),
      down: ARC.input.held("down"),
    };
    const solidOthers = [];
    others.forEach((o) => {
      if (!(o.flags & 1)) solidOthers.push(o.box);
    });
    const ev = PF.step(me, input, map, world, solidOthers, dt, {
      shove: mode === "race",
      bounds: levelMode(mode) === "brawl",
      run: mode === "tag" && world.it === room.myId ? 1.1 : 1,
    });
    if (ev.died) {
      die();
      return;
    }

    if (mode === "coop") coopRules();
    else if (mode === "race") raceRules();
    else if (mode === "tag") tagRules();
    else brawlRules();
  }

  // Whoever is it tags the first player they touch; the host has the final word.
  function tagRules() {
    const now = performance.now();
    if (world.it !== room.myId || now < world.safeUntil || now - st.askedTag < 250) return;
    for (const [id, o] of others) {
      if (o.flags & 1) continue;
      // bodies are solid, so "touching" means within a couple of pixels
      const near = { x: o.box.x - 3, y: o.box.y - 3, w: PF.PW + 6, h: PF.PH + 6 };
      if (!PF.overlap(me, near)) continue;
      st.askedTag = now;
      room.to(room.hostId, "pf.tag", { to: id });
      return;
    }
  }

  function keyBox() {
    return world.key ? { x: world.key.x - 12, y: world.key.y - 12, w: 24, h: 24 } : null;
  }

  function coopRules() {
    const now = performance.now();
    const k = world.key;
    if (k && !k.carrier && !world.unlocked && PF.overlap(me, keyBox()) && now - st.askedGrab > 800) {
      st.askedGrab = now;
      room.to(room.hostId, "pf.grab");
    }
    const atExit = PF.touching(me, map, "G");
    if (atExit && k && k.carrier === room.myId && now - st.askedUnlock > 500) {
      st.askedUnlock = now;
      room.to(room.hostId, "pf.unlock");
    }
    if (atExit && world.unlocked && ARC.input.hit("up")) {
      st.entered = true;
      room.to(room.hostId, "pf.enter");
    }
    checkpoint();
  }

  function raceRules() {
    checkpoint();
    if (PF.touching(me, map, "G")) {
      st.finished = true;
      const t = performance.now() - raceStart;
      room.to(room.hostId, "pf.fin", { t });
      ARC.banner("Finished in " + (t / 1000).toFixed(2) + " s", 2200);
    }
  }

  function checkpoint() {
    const f = PF.touching(me, map, "F");
    if (!f) return;
    const id = f.c + "," + f.r;
    if (world.flagsHit.has(id)) return;
    world.flagsHit.add(id);
    spawnPoint = { x: f.c * T + (T - PF.PW) / 2, y: (f.r + 1) * T - PF.PH };
    WG.toast("Checkpoint!", 1000);
  }

  function brawlRules() {
    if (ARC.input.hit("attack") && st.cooldown <= 0) {
      st.attack = 0.14;
      st.cooldown = 0.34;
      st.hits.clear();
    }
    if (st.attack <= 0) return;
    const reach = { x: me.face > 0 ? me.x + me.w - 4 : me.x - 30, y: me.y + 2, w: 34, h: 24 };
    others.forEach((o, id) => {
      if (st.hits.has(id) || o.flags & 1 || o.flags & 4) return;
      if (!PF.overlap(reach, o.box)) return;
      st.hits.add(id);
      room.share("pf.hit", { to: id, dir: me.face, dmg: 8 + Math.floor(Math.random() * 4) });
    });
  }

  function die() {
    if (mode === "brawl") {
      st.stocks = Math.max(0, st.stocks - 1);
      room.to(room.hostId, "pf.ko", { stocks: st.stocks });
      if (st.stocks === 0) {
        st.out = true;
        ARC.banner("You're out!", 1600);
        return;
      }
      st.dead = 1.2;
      return;
    }
    if (world.key && world.key.carrier === room.myId) room.to(room.hostId, "pf.drop");
    st.dead = 0.7;
  }

  function respawn() {
    const spot =
      levelMode(mode) === "brawl" ? map.spawns[Math.floor(Math.random() * map.spawns.length)] : spawnPoint;
    Object.assign(me, PF.makePlayer(spot));
    me.px = me.x; // no blending from where I fell to the spawn point
    me.py = me.y;
    st.dead = 0;
    if (mode === "brawl") {
      st.dmg = 0;
      st.invuln = 2;
    } else {
      st.invuln = 0.6;
    }
  }

  /* ---------- Drawing ---------- */

  let lastDraw = 0;

  function draw(alpha) {
    const now = performance.now();
    const frames = lastDraw ? Math.min(4, (now - lastDraw) / (1000 / 60)) : 1;
    lastDraw = now;
    const ctx = view.begin();
    const dark = ARC.colors.dark;
    const pal = PF.palette(dark);
    ctx.fillStyle = pal.sky;
    ctx.fillRect(0, 0, view.w, view.h);
    if (!map) return;

    // me: between my last two steps; the others: blended from their updates, every frame
    const mine = me ? { x: ARC.lerp(me.px ?? me.x, me.x, alpha || 0), y: ARC.lerp(me.py ?? me.y, me.y, alpha || 0), face: me.face } : null;
    const shown = new Map();
    others.forEach((o, id) => {
      const s = o.buf.sample();
      if (!s) return;
      shown.set(id, {
        x: ARC.lerp(s.a.x, s.b.x, s.t),
        y: ARC.lerp(s.a.y, s.b.y, s.t),
        face: s.b.face,
        flags: s.b.flags,
        dmg: s.b.dmg,
      });
    });

    // camera follows me (or whoever is still playing once I am in / out)
    let target = mine && !hidden() ? mine : null;
    if (!target) shown.forEach((o) => (target = target || (!(o.flags & 1) ? o : null)));
    if (target) {
      const tx = ARC.clamp(target.x + PF.PW / 2 - view.w / 2, 0, Math.max(0, map.pw - view.w));
      const ty = ARC.clamp(target.y + PF.PH / 2 - view.h / 2, 0, Math.max(0, map.ph - view.h));
      const ease = 1 - Math.pow(0.8, frames); // the same glide at 60 or 144 frames a second
      cam.x += (tx - cam.x) * ease;
      cam.y += (ty - cam.y) * ease;
    }
    ctx.save();
    // snap the camera to whole screen pixels, not whole game pixels: smooth and still crisp
    ctx.translate(-Math.round(cam.x * view.scale) / view.scale, -Math.round(cam.y * view.scale) / view.scale);

    // faint grid for depth
    ctx.fillStyle = pal.grid;
    for (let c = Math.floor(cam.x / T); c <= (cam.x + view.w) / T; c += 2) ctx.fillRect(c * T, cam.y, 1, view.h);

    PF.drawTiles(ctx, map, world, { x: cam.x, y: cam.y, w: view.w, h: view.h }, dark, false);

    const k = world.key;
    if (k && !k.carrier && !world.unlocked) {
      const bob = Math.sin(performance.now() / 300) * 3;
      PF.drawKey(ctx, k.x, k.y + bob);
    }

    shown.forEach((o, id) => {
      if (o.flags & 1) return;
      const p = room && room.player(id);
      if (!p) return;
      const blink = o.flags & 4 && Math.floor(now / 100) % 2;
      if (mode === "tag" && world.it === id) drawIt(ctx, o, now);
      PF.drawPlayer(ctx, o, {
        color: NET.color(p.color),
        label: mode === "brawl" ? p.name + " " + (o.dmg || 0) + "%" : mode === "tag" && world.it === id ? "IT! " + p.name : p.name,
        alpha: blink ? 0.35 : 1,
        attack: o.flags & 2,
        key: k && k.carrier === id,
        dark,
      });
    });

    if (me && st && !hidden()) {
      const my = room && room.player(room.myId);
      const blink = st.invuln > 0 && Math.floor(now / 100) % 2;
      if (mode === "tag" && world.it === room.myId) drawIt(ctx, mine, now);
      PF.drawPlayer(ctx, mine, {
        color: NET.color(my ? my.color : 0),
        label: mode === "brawl" ? Math.round(st.dmg) + "%" : mode === "tag" && world.it === room.myId ? "IT!" : "",
        alpha: blink ? 0.35 : 1,
        attack: st.attack > 0,
        key: k && k.carrier === room.myId,
        dark,
      });
      if (mode === "coop" && world.unlocked && PF.touching(me, map, "G")) {
        ctx.font = "700 13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = pal.ink;
        ctx.fillText("↑ go in", mine.x + PF.PW / 2, mine.y - 10);
      }
    } else if (me && st && st.dead > 0) {
      // a small puff where I fell
      ctx.strokeStyle = pal.ink;
      ctx.globalAlpha = Math.max(0, st.dead);
      ctx.beginPath();
      ctx.arc(me.x + PF.PW / 2, Math.min(me.y, map.ph - 10) + PF.PH / 2, 22 * (1.2 - st.dead), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (phase === "countdown") {
      const left = Math.ceil((phaseEnd - now) / 1000);
      if (left !== draw.lastCount) {
        draw.lastCount = left;
        if (left > 0) ARC.banner(String(left));
      }
    } else {
      draw.lastCount = -1;
    }
    if (mode === "race" && phase === "play") drawClock(ctx, now);
    if (mode === "tag" && phase !== "done" && world.it) drawTagClock(ctx, now);
    if (st && st.entered) overlayText(ctx, "You're in! Waiting for the others… (↓ to come back out)");
    if (st && st.out && mode === "brawl" && phase === "play") overlayText(ctx, "You're out — watching the others");
  }

  // A pulsing ring around whoever is it.
  function drawIt(ctx, p, now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 120);
    ctx.save();
    ctx.strokeStyle = "#f0c419";
    ctx.lineWidth = 2 + pulse * 2;
    ctx.globalAlpha = 0.5 + pulse * 0.5;
    ctx.beginPath();
    ctx.arc(p.x + PF.PW / 2, p.y + PF.PH / 2, 22 + pulse * 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawTagClock(ctx, now) {
    const left = Math.max(0, Math.ceil((world.tagEnds - now) / 1000));
    const it = room && room.player(world.it);
    const who = world.it === room.myId ? "You're it — tag somebody!" : it ? it.name + " is it — run!" : "";
    overlayText(ctx, who + "  ·  " + left + " s", 22);
  }

  function drawClock(ctx, now) {
    const t = st && st.finished ? null : (now - raceStart) / 1000;
    let text = t === null ? "Finished!" : t.toFixed(1) + " s";
    if (raceEnds) text += "  ·  ends in " + Math.max(0, Math.ceil((raceEnds - now) / 1000)) + " s";
    overlayText(ctx, text, 22);
  }

  function overlayText(ctx, text, y) {
    ctx.font = "700 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    const w = ctx.measureText(text).width + 24;
    const yy = y || view.h - 30;
    ctx.fillStyle = ARC.colors.dark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.75)";
    ctx.fillRect(view.w / 2 - w / 2, yy - 17, w, 26);
    ctx.fillStyle = ARC.colors.text;
    ctx.fillText(text, view.w / 2, yy + 1);
  }

  /* ---------- HUD ---------- */

  function renderHud() {
    if (!room || !map || phase === "idle") {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = room.players.map((p) => {
      const o = others.get(p.id);
      const mine = p.id === room.myId;
      let value = "";
      let out = false;
      if (mode === "coop") {
        value = world.entered.includes(p.id) ? "✓ in" : "";
      } else if (mode === "race") {
        value = (info.scores[p.id] || 0) + (world.finished.includes(p.id) ? " ✓" : "");
      } else if (mode === "tag") {
        value = (world.it === p.id ? "IT · " : "") + Math.round((world.itTime[p.id] || 0) / 1000) + " s";
      } else {
        const stocks = mine ? (st ? st.stocks : 0) : o ? o.stocks : info.lives;
        value = "♥".repeat(Math.max(0, stocks || 0));
        out = !stocks;
      }
      return { name: p.name, color: p.color, value, out, me: mine };
    });
    rows.push({ name: info.name, color: -1, value: info.count > 1 ? info.index + 1 + "/" + info.count : "" });
    ARC.scoreboard($("hud"), rows);
  }
  setInterval(() => {
    if (mode === "brawl" && phase !== "idle") renderHud();
  }, 500);
})();
