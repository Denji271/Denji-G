// Curve Fever — steer a line that never stops growing; hit any line or wall and you are out.
// The host runs the whole simulation; guests only send which way they are turning.
(function () {
  "use strict";

  const W = 960;
  const H = 640;
  const TURN = 2.9; // radians per second
  const R = 2.6; // half the line width
  const CELL = 3; // collision grid resolution
  const GW = Math.ceil(W / CELL);
  const GH = Math.ceil(H / CELL);
  const SELF_GRACE = 26; // ticks of your own fresh line you cannot crash into
  const COUNTDOWN = 3;
  const ROUND_PAUSE = 2.6;
  const TRAIL_SCALE = 2;

  const $ = (id) => document.getElementById(id);
  const view = ARC.view($("game"), W, H);

  // All finished lines live on their own canvas, drawn once and never cleared mid-round.
  const trail = document.createElement("canvas");
  trail.width = W * TRAIL_SCALE;
  trail.height = H * TRAIL_SCALE;
  const tctx = trail.getContext("2d");
  tctx.scale(TRAIL_SCALE, TRAIL_SCALE);
  tctx.lineCap = "round";
  tctx.lineWidth = R * 2;

  let room = null;
  let heads = []; // [{ id, name, color, score, x, y, a, alive }] — on the host these carry the sim fields too
  let phase = "idle"; // idle | countdown | run | pause
  let countdownEnd = 0;
  let lastCount = -1;
  let target = 10;
  let roundNo = 0;

  // host only
  let match = null; // { players: [{ id, name, color, score }], per, speed, started }
  let grid = null;
  let stamp = null;
  let tick = 0;
  let timer = 0;
  const turns = {}; // player id -> -1 | 0 | 1
  const snaps = ARC.snapshots(); // guests: the host's updates, played back smoothly

  let myTurn = 0;

  LOBBY.init({
    game: "curve",
    title: "Curve Fever",
    blurb: "Steer your line, dodge everybody else's and be the last one standing. 2–4 players.",
    settings: [
      {
        key: "per",
        label: "Match length",
        value: 10,
        options: [
          { value: 5, label: "Short" },
          { value: 10, label: "Normal" },
          { value: 15, label: "Long" },
        ],
      },
      {
        key: "speed",
        label: "Speed",
        value: 92,
        options: [
          { value: 75, label: "Relaxed" },
          { value: 92, label: "Normal" },
          { value: 120, label: "Fast" },
        ],
      },
    ],
    onRoom,
    onStart: startMatch,
    onLobby: stopAll,
  });

  const loop = ARC.loop(update, draw);
  loop.start();

  function onRoom(r) {
    room = r;
    room.on("cv.round", onRound);
    room.on("cv.go", () => (phase = "run"));
    room.on("cv.s", onSnapshot);
    room.on("cv.dead", onDead);
    room.on("cv.over", onRoundOver);
    room.on("players", renderHud);
    if (room.isHost) {
      room.on("cv.turn", (d, from) => {
        turns[from] = d === 1 ? 1 : d === -1 ? -1 : 0;
      });
      room.on("leave", (p) => {
        if (!match) return;
        match.players = match.players.filter((m) => m.id !== p.id);
        const h = heads.find((x) => x.id === p.id);
        if (h && h.alive && phase !== "idle") kill(h, false);
      });
    }
  }

  function stopAll() {
    phase = "idle";
    match = null;
    ARC.banner("");
  }

  /* ---------- Host: match and rounds ---------- */

  function startMatch(settings) {
    match = {
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: 0 })),
      per: settings.per,
      speed: settings.speed,
      started: room.players.length,
    };
    roundNo = 0;
    startRound();
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function startRound() {
    // Whoever joined the room since the last round comes in now.
    room.players.forEach((p) => {
      if (!match.players.some((m) => m.id === p.id)) {
        match.players.push({ id: p.id, name: p.name, color: p.color, score: 0 });
      }
    });
    const n = match.players.length;
    target = match.per * Math.max(1, n - 1);

    const spots = [];
    match.players.forEach(() => {
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 200; tries++) {
        x = rand(110, W - 110);
        y = rand(110, H - 110);
        if (spots.every((s) => Math.hypot(s.x - x, s.y - y) > 170)) break;
      }
      // point roughly towards the middle so nobody starts facing a wall
      const a = Math.atan2(H / 2 - y, W / 2 - x) + rand(-1.1, 1.1);
      spots.push({ x, y, a });
    });

    grid = new Uint8Array(GW * GH);
    stamp = new Uint32Array(GW * GH);
    tick = 0;
    timer = COUNTDOWN;
    const payload = {
      round: ++roundNo,
      target,
      players: match.players.map((m, i) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        score: m.score,
        x: spots[i].x,
        y: spots[i].y,
        a: spots[i].a,
      })),
    };
    room.send("cv.round", payload);
    onRound(payload);
    heads.forEach((h, i) => {
      h.slot = i + 1;
      h.gap = false;
      h.gapIn = rand(1.4, 3.2);
    });
  }

  function hostUpdate(dt) {
    if (phase === "countdown") {
      timer -= dt;
      if (timer <= 0) {
        phase = "run";
        room.send("cv.go");
      }
      return;
    }
    if (phase === "pause") {
      timer -= dt;
      if (timer <= 0) nextRound();
      return;
    }
    if (phase !== "run") return;

    tick++;
    const speed = match.speed;
    heads.forEach((h) => {
      if (!h.alive) return;
      h.a += (turns[h.id] || 0) * TURN * dt;
      const px = h.x;
      const py = h.y;
      h.px = px; // for drawing the head in between steps
      h.py = py;
      h.x += Math.cos(h.a) * speed * dt;
      h.y += Math.sin(h.a) * speed * dt;
      h.gapIn -= dt;
      if (h.gapIn <= 0) {
        h.gap = !h.gap;
        h.gapIn = h.gap ? 0.2 + 7 / speed : rand(1.5, 3.5);
      }
      if (crashed(h)) {
        kill(h, true);
        return;
      }
      if (!h.gap) {
        mark(h);
        segment(h.color, px, py, h.x, h.y);
      }
    });

    // every step: 60 updates a second, stamped with the time
    room.send("cv.s", {
      ts: Math.round(performance.now() * 10) / 10,
      p: heads.map((h) => [Math.round(h.x * 10) / 10, Math.round(h.y * 10) / 10, h.gap ? 1 : 0]),
    });

    const alive = heads.filter((h) => h.alive).length;
    if (alive <= (heads.length > 1 ? 1 : 0)) endRound();
  }

  function cellAt(x, y) {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) return -1;
    return cy * GW + cx;
  }

  function crashed(h) {
    if (h.x < R || h.y < R || h.x > W - R || h.y > H - R) return true;
    for (const off of [0, -0.7, 0.7]) {
      const i = cellAt(h.x + Math.cos(h.a + off) * (R + 0.8), h.y + Math.sin(h.a + off) * (R + 0.8));
      if (i < 0) return true;
      const owner = grid[i];
      if (owner && !(owner === h.slot && tick - stamp[i] < SELF_GRACE)) return true;
    }
    return false;
  }

  function mark(h) {
    const reach = R + 0.5;
    const x0 = Math.floor((h.x - reach) / CELL);
    const x1 = Math.floor((h.x + reach) / CELL);
    const y0 = Math.floor((h.y - reach) / CELL);
    const y1 = Math.floor((h.y + reach) / CELL);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) continue;
        const mx = (cx + 0.5) * CELL - h.x;
        const my = (cy + 0.5) * CELL - h.y;
        if (mx * mx + my * my > reach * reach) continue;
        const i = cy * GW + cx;
        if (!grid[i]) {
          grid[i] = h.slot;
          stamp[i] = tick;
        }
      }
    }
  }

  function kill(h, score) {
    h.alive = false;
    const m = match.players.find((p) => p.id === h.id);
    if (score) {
      heads.forEach((o) => {
        if (!o.alive) return;
        o.score++;
        const mo = match.players.find((p) => p.id === o.id);
        if (mo) mo.score = o.score;
      });
    }
    if (m) m.score = h.score;
    const d = { i: heads.indexOf(h), x: h.x, y: h.y, scores: heads.map((o) => o.score) };
    room.send("cv.dead", d);
    onDead(d);
  }

  function endRound() {
    phase = "pause";
    heads.forEach((h) => {
      h.px = h.x;
      h.py = h.y;
    });
    timer = ROUND_PAUSE;
    const survivor = heads.find((h) => h.alive);
    const d = { winner: survivor ? heads.indexOf(survivor) : -1 };
    room.send("cv.over", d);
    onRoundOver(d);
  }

  function nextRound() {
    const ranked = match.players.slice().sort((a, b) => b.score - a.score);
    const lonely = match.started > 1 && match.players.length < 2;
    if (ranked.length && (ranked[0].score >= target || lonely)) {
      phase = "idle";
      LOBBY.results(
        ranked.map((p) => ({ name: p.name, color: p.color, value: p.score })),
        ranked[0].name + " wins!"
      );
      match = null;
      return;
    }
    startRound();
  }

  /* ---------- Everybody: showing what the host says ---------- */

  function onRound(d) {
    heads = d.players.map((p) => Object.assign({}, p, { alive: true }));
    target = d.target;
    roundNo = d.round;
    tctx.clearRect(0, 0, W, H);
    snaps.clear();
    phase = "countdown";
    countdownEnd = performance.now() + COUNTDOWN * 1000;
    lastCount = -1;
    if (heads.some((h) => h.id === room.myId)) LOBBY.hide();
    renderHud();
  }

  function onSnapshot(d) {
    if (!room.isHost) snaps.push(d, d.ts);
  }

  // Guests draw the lines a moment behind, in step with the smoothly moving heads.
  function playBack() {
    snaps.drain((d) => {
      d.p.forEach(([x, y, gap], i) => {
        const h = heads[i];
        if (!h || (x === h.x && y === h.y)) return;
        if (!gap) segment(h.color, h.x, h.y, x, y);
        h.a = Math.atan2(y - h.y, x - h.x);
        h.x = x;
        h.y = y;
      });
    });
  }

  // Where to draw each head this frame.
  function headSpots(alpha) {
    if (room && room.isHost) return heads.map((h) => ({ x: ARC.lerp(h.px ?? h.x, h.x, alpha), y: ARC.lerp(h.py ?? h.y, h.y, alpha) }));
    const sm = snaps.sample();
    return heads.map((h, i) => {
      if (!sm || !sm.b.p[i]) return { x: h.x, y: h.y };
      const a = sm.a.p[i] || sm.b.p[i];
      const b = sm.b.p[i];
      return { x: ARC.lerp(a[0], b[0], sm.t), y: ARC.lerp(a[1], b[1], sm.t) };
    });
  }

  function onDead(d) {
    const h = heads[d.i];
    if (!h) return;
    h.alive = false;
    h.cx = d.x;
    h.cy = d.y;
    d.scores.forEach((s, i) => {
      if (heads[i]) heads[i].score = s;
    });
    h.crash = performance.now();
    renderHud();
  }

  function onRoundOver(d) {
    phase = "pause";
    const w = heads[d.winner];
    ARC.banner(w ? w.name + " takes the round" : "Round over", 2200);
    renderHud();
  }

  function renderHud() {
    const rows = heads.length
      ? heads.map((h) => ({
          name: h.name,
          color: h.color,
          value: h.score,
          out: !h.alive && phase === "run",
          me: room && h.id === room.myId,
        }))
      : [];
    if (rows.length) rows.push({ name: "Target", color: -1, value: target });
    ARC.scoreboard($("hud"), rows);
  }

  /* ---------- Loop ---------- */

  function update(dt) {
    if (!room) return;
    const t = (ARC.input.held("right") ? 1 : 0) - (ARC.input.held("left") ? 1 : 0);
    if (room.isHost) turns[room.myId] = t;
    else if (t !== myTurn) room.send("cv.turn", t);
    myTurn = t;
    if (room.isHost && match) hostUpdate(dt);
  }

  function segment(color, x0, y0, x1, y1) {
    tctx.strokeStyle = NET.color(color);
    tctx.beginPath();
    tctx.moveTo(x0, y0);
    tctx.lineTo(x1, y1);
    tctx.stroke();
  }

  function draw(alpha) {
    if (room && !room.isHost) playBack();
    const spots = headSpots(alpha || 0);
    const ctx = view.begin();
    const c = ARC.colors;
    ctx.fillStyle = c.dark ? "#161618" : "#fbfbfc";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = c.strong;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    ctx.drawImage(trail, 0, 0, W, H);

    const now = performance.now();
    if (phase === "countdown") {
      const left = Math.ceil((countdownEnd - now) / 1000);
      if (left !== lastCount) {
        lastCount = left;
        ARC.banner(left > 0 ? String(left) : "Go!", left > 0 ? 0 : 700);
      }
    }

    heads.forEach((h, i) => {
      const col = NET.color(h.color);
      const at = spots[i];
      if (phase === "countdown") {
        // show where everybody will head
        ctx.strokeStyle = col;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(h.x, h.y);
        const ex = h.x + Math.cos(h.a) * 34;
        const ey = h.y + Math.sin(h.a) * 34;
        ctx.lineTo(ex, ey);
        ctx.lineTo(ex - Math.cos(h.a - 0.5) * 10, ey - Math.sin(h.a - 0.5) * 10);
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(h.a + 0.5) * 10, ey - Math.sin(h.a + 0.5) * 10);
        ctx.stroke();
        ctx.fillStyle = c.text;
        ctx.font = "700 14px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(h.id === room.myId ? "You" : h.name, h.x, h.y - 16);
      }
      if (h.alive) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(at.x, at.y, R + 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = c.dark ? "#fff" : "#1a1a1b";
        ctx.beginPath();
        ctx.arc(at.x, at.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (h.crash) {
        // a small burst where the crash happened
        const age = (now - h.crash) / 500;
        if (age < 1) {
          ctx.strokeStyle = col;
          ctx.globalAlpha = 1 - age;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(h.cx, h.cy, 6 + age * 26, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    });
  }
})();
