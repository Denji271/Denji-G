// Sled Race — everybody sleds down the same winding slope; trees stop you, ramps send you flying.
// Everybody drives their own sled; the slope comes from the host's seed, so it is the same for all.
// The host keeps the finishing order and the points.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LENGTH = 420; // start at z = 0, finish at z = -LENGTH
  const HALF_W = 8; // the groomed track either side of the middle
  const EDGE = 5; // how far into the bank you can get
  const SLOPE = 0.24;
  const RAMP_LEN = 7;
  const RAMP_H = 1.6;
  const PULL = 26; // how hard the slope pulls the sled along
  const DRAG = { plain: 0.012, tuck: 0.0085 };
  const ROLL = 0.3;
  const BRAKE = 9;
  const TURN = { plain: 1.7, tuck: 1.0 };
  const MAX_TURN = 1.35; // how far from straight downhill the sled can point
  const GRAVITY = 22;
  const SLED_R = 0.6;
  const CRASH_MS = 900;
  const GRACE_MS = 30000;
  const COUNTDOWN = 3000;
  const SEND_MS = 33;
  const DOWNHILL = Math.PI; // the heading that points straight down the slope (-z)

  let K = null;
  let orbit = null;
  let others = null;
  let room = null;
  let phase = "idle"; // idle | countdown | play | over
  const cd = K3.countdown();
  let players = [];
  let scores = {};
  let finished = [];
  let roundNo = 0;
  let roundCount = 3;
  let raceStart = 0;
  let raceEnds = 0;
  let firstDown = 0;
  let T = null; // the slope: bends, ramps and trees
  let slopeGroup = null;
  let me = null;
  let meObj = null;
  let camHeading = DOWNHILL;
  let lastDrag = 0;
  const sendDue = ARC.every(SEND_MS);

  // host only
  let match = null;

  const ready = K3.load()
    .then(setup)
    .catch((err) => {
      K3.fail($("game"), err.message);
      throw err;
    });
  const when = (fn) => (d, from) => ready.then(() => fn(d, from));

  LOBBY.init({
    game: "sled",
    title: "Sled Race",
    blurb: "Race down a snowy slope: dodge the trees, fly off the ramps, first to the bottom wins. 1–4 players.",
    lateNote: "A race is on — you are in from the next one.",
    settings: [
      {
        key: "rounds",
        label: "Races",
        value: 3,
        options: [
          { value: 1, label: "1" },
          { value: 3, label: "3" },
          { value: 5, label: "5" },
        ],
      },
    ],
    onRoom,
    onStart: (v) => ready.then(() => startMatch(v)),
    onLobby: stopAll,
  });

  /* ---------- The slope ---------- */

  function makeSlope(seed) {
    const rand = WG.rng(seed);
    const t = {
      a1: 8 + rand() * 6,
      f1: (Math.PI * 2) / (120 + rand() * 60),
      p1: rand() * Math.PI * 2,
      a2: 3 + rand() * 4,
      f2: (Math.PI * 2) / (45 + rand() * 25),
      p2: rand() * Math.PI * 2,
      ramps: [],
      trees: [], // in the way: { x, z }
      deco: [], // on the banks
    };
    for (let k = 0; k < 4; k++) t.ramps.push(-(70 + k * 85 + rand() * 30));
    for (let k = 0; k < 26; k++) {
      const z = -(40 + rand() * (LENGTH - 60));
      if (t.ramps.some((zr) => z < zr + 6 && z > zr - RAMP_LEN - 14)) continue; // clear run-up and landing
      t.trees.push({ z, dx: (rand() * 2 - 1) * (HALF_W - 1.5) });
    }
    for (let k = 0; k < 170; k++) {
      const z = 20 - rand() * (LENGTH + 60);
      const side = rand() < 0.5 ? -1 : 1;
      t.deco.push({ z, dx: side * (HALF_W + EDGE + 1.5 + rand() * 14) }); // beyond where a sled can get
    }
    return t;
  }

  // The middle of the track; straight for the first stretch so everybody starts evenly.
  function centerX(z) {
    const k = ARC.clamp(-z / 30, 0, 1);
    return (T.a1 * Math.sin(z * T.f1 + T.p1) + T.a2 * Math.sin(z * T.f2 + T.p2) - (T.a1 * Math.sin(T.p1) + T.a2 * Math.sin(T.p2))) * k * k;
  }

  function rampY(z) {
    let y = 0;
    for (const zr of T.ramps) {
      const u = (zr - z) / RAMP_LEN;
      if (u >= 0 && u <= 1) y += RAMP_H * u * u;
    }
    return y;
  }

  function height(x, z) {
    const over = Math.max(0, Math.abs(x - centerX(z)) - HALF_W);
    return z * SLOPE + 1.2 * Math.sin(z / 23) + rampY(z) + over * over * 0.18;
  }

  function treeX(t) {
    return centerX(t.z) + t.dx;
  }

  // The heading that follows the track down the hill at this point.
  function trackHeading(z) {
    const e = 0.5;
    const drift = (centerX(z - e) - centerX(z + e)) / (2 * e); // sideways per unit downhill
    return Math.atan2(drift, -1);
  }

  function turnFrom(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  function buildSlope(seed) {
    T = makeSlope(seed);
    if (slopeGroup) {
      K.scene.remove(slopeGroup);
      K3.dispose(slopeGroup);
    }
    slopeGroup = new THREE.Group();
    K.scene.add(slopeGroup);

    // the snow: rows across the slope that follow its bends
    const across = 31;
    const zFrom = 30;
    const zTo = -(LENGTH + 50);
    const rows = Math.round(zFrom - zTo);
    const pos = [];
    const col = [];
    const c = new THREE.Color();
    for (let i = 0; i <= rows; i++) {
      const z = zFrom - i;
      const cx = centerX(z);
      for (let j = 0; j < across; j++) {
        const u = -30 + (60 * j) / (across - 1);
        const x = cx + u;
        pos.push(x, height(x, z), z);
        const onTrack = Math.abs(u) <= HALF_W;
        c.setRGB(onTrack ? 0.97 : 0.9, onTrack ? 0.98 : 0.93, 1);
        col.push(c.r, c.g, c.b);
      }
    }
    const idx = [];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < across - 1; j++) {
        const a = i * across + j;
        const b = a + across; // the next row, further down the hill
        idx.push(a, a + 1, b, a + 1, b + 1, b); // wound so the snow faces up
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const snow = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    snow.receiveShadow = true;
    slopeGroup.add(snow);

    // trees: the ones on the track and the ones on the banks look the same
    const all = T.trees.map((t) => ({ x: treeX(t), z: t.z })).concat(T.deco.map((t) => ({ x: centerX(t.z) + t.dx, z: t.z })));
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.24, 1, 7), new THREE.MeshStandardMaterial({ color: 0x6b4a2b }), all.length);
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1.2, 3.2, 8), new THREE.MeshStandardMaterial({ color: 0x2f6b3f, roughness: 0.9 }), all.length);
    const m = new THREE.Matrix4();
    all.forEach((t, i) => {
      const y = height(t.x, t.z);
      m.makeTranslation(t.x, y + 0.5, t.z);
      trunk.setMatrixAt(i, m);
      m.makeTranslation(t.x, y + 2.4, t.z);
      crown.setMatrixAt(i, m);
    });
    crown.castShadow = true;
    slopeGroup.add(trunk, crown);

    // ramps: a red lip so you can see them coming
    const lipMat = new THREE.MeshStandardMaterial({ color: 0xe05c4a, roughness: 0.7 });
    T.ramps.forEach((zr) => {
      const z = zr - RAMP_LEN;
      const lip = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2, 0.12, 0.35), lipMat);
      lip.position.set(centerX(z), height(centerX(z), z) + 0.06, z);
      slopeGroup.add(lip);
    });

    // start and finish gates
    const gate = (z, color) => {
      const g = new THREE.Group();
      const pole = new THREE.MeshStandardMaterial({ color: 0x444a55 });
      const cx = centerX(z);
      const y = height(cx, z);
      [-HALF_W - 0.5, HALF_W + 0.5].forEach((dx) => {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 5, 8), pole);
        p.position.set(cx + dx, y + 2.5, z);
        g.add(p);
      });
      const banner = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 + 1, 0.9, 0.1), new THREE.MeshStandardMaterial({ color }));
      banner.position.set(cx, y + 4.6, z);
      g.add(banner);
      slopeGroup.add(g);
    };
    gate(-2, 0x2f6fde);
    gate(-LENGTH, 0xe05c4a);

    K.sun.position.set(20, 40, 10);
  }

  function makeSled(colorIndex) {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0xa0764a, roughness: 0.8 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 1.7), wood);
    board.position.y = 0.3;
    board.castShadow = true;
    g.add(board);
    const metal = new THREE.MeshStandardMaterial({ color: 0x9aa3b0, metalness: 0.5, roughness: 0.4 });
    [-0.32, 0.32].forEach((x) => {
      const runner = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.9), metal);
      runner.position.set(x, 0.08, 0.05);
      g.add(runner);
    });
    const rider = K3.character(colorIndex);
    rider.scale.setScalar(0.8);
    rider.position.set(0, 0.35, -0.2);
    g.add(rider);
    g.userData.rider = rider;
    return g;
  }

  /* ---------- Setup ---------- */

  function setup() {
    K = K3.stage($("game"), { sky: { light: 0xbcdcf6, dark: 0x141b29 }, fog: [40, 140], shadowBox: 30, far: 600 });
    orbit = K3.orbit($("game"), { yaw: 0, pitch: 0.32, dist: 8, minPitch: 0.05, maxPitch: 1.2, minDist: 4, maxDist: 20 });
    others = K3.crowd(K.scene, { make: (p) => makeSled(p.color), tagY: 2.2 });
    buildSlope(1);
    const loop = ARC.loop(update, draw);
    loop.start();
  }

  function onRoom(r) {
    room = r;
    room.on("sl.round", when(onRound));
    room.on("sl.p", when(onRemote));
    room.on("sl.state", when(onState));
    room.on("sl.over", when(onOver));
    room.on("players", when(() => {
      others.keep((id) => !!room.player(id));
      renderHud();
    }));
    if (room.isHost) {
      room.on("sl.fin", when((d, from) => hostFinish(from)));
      room.on("leave", when(() => hostCheck()));
    }
  }

  function stopAll() {
    phase = "idle";
    match = null;
    me = null;
    cd.stop();
    ARC.banner("");
    renderHud();
  }

  /* ---------- Host ---------- */

  function startMatch(v) {
    match = { races: v.rounds, round: 0, scores: {} };
    room.players.forEach((p) => (match.scores[p.id] = 0));
    startRound();
  }

  function startRound() {
    match.round++;
    match.seed = (Math.random() * 1e9) | 0;
    match.finished = [];
    match.firstDown = 0;
    match.over = false;
    match.racers = room.players.map((p) => p.id);
    match.racers.forEach((id) => (match.scores[id] = match.scores[id] || 0));
    match.limitAt = performance.now() + COUNTDOWN + 150000;
    const d = {
      seed: match.seed,
      round: match.round,
      rounds: match.races,
      limitIn: match.limitAt - performance.now(),
      scores: match.scores,
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    };
    room.send("sl.round", d);
    onRound(d);
  }

  function hostFinish(id) {
    if (!match || match.over || match.finished.includes(id) || !match.racers.includes(id)) return;
    match.finished.push(id);
    if (!match.firstDown) match.firstDown = performance.now();
    const d = {
      finished: match.finished,
      endsIn: Math.max(0, Math.min(match.firstDown + GRACE_MS, match.limitAt) - performance.now()),
    };
    room.send("sl.state", d);
    onState(d);
    hostCheck();
  }

  function hostCheck() {
    if (!match || match.over) return;
    const racing = match.racers.filter((id) => room.player(id));
    const everyone = racing.every((id) => match.finished.includes(id));
    const now = performance.now();
    const late = (match.firstDown && now > match.firstDown + GRACE_MS) || now > match.limitAt;
    if (!everyone && !late) return;
    match.over = true;
    const points = [3, 2, 1, 0];
    match.finished.forEach((id, i) => (match.scores[id] = (match.scores[id] || 0) + (points[i] || 0)));
    const first = match.finished.length ? room.player(match.finished[0]) : null;
    const d = { title: first ? first.name + " wins the race!" : "Nobody made it down!", scores: match.scores };
    room.send("sl.over", d);
    onOver(d);
    setTimeout(() => {
      if (!match) return;
      if (match.round >= match.races) finish();
      else startRound();
    }, 3500);
  }

  function finish() {
    const rows = room.players
      .filter((p) => match.scores[p.id] !== undefined)
      .sort((a, b) => match.scores[b.id] - match.scores[a.id])
      .map((p) => ({ name: p.name, color: p.color, value: match.scores[p.id] + " pts" }));
    match = null;
    phase = "idle";
    LOBBY.results(rows, rows.length > 1 ? rows[0].name + " wins!" : "Well done!");
  }

  /* ---------- Everybody ---------- */

  function startSpot(k) {
    return -4.5 + k * 3;
  }

  function onRound(d) {
    buildSlope(d.seed);
    others.clear();
    if (meObj) {
      K.scene.remove(meObj);
      K3.dispose(meObj);
      meObj = null;
    }
    players = d.players;
    scores = d.scores || {};
    finished = [];
    roundNo = d.round;
    roundCount = d.rounds;
    firstDown = 0;
    raceEnds = performance.now() + d.limitIn;
    players.forEach((p, k) => {
      if (p.id === room.myId) return;
      const o = others.add(p);
      const x = startSpot(k);
      o.obj.position.set(x, height(x, -4), -4);
      o.obj.rotation.y = DOWNHILL;
    });
    const k = players.findIndex((p) => p.id === room.myId);
    if (k >= 0) {
      const x = startSpot(k);
      me = { x, z: -4, y: height(x, -4), vy: 0, air: false, h: DOWNHILL, s: 0, crashUntil: 0, out: false, px: x, pz: -4, py: 0 };
      me.py = me.y;
      meObj = makeSled(players[k].color);
      K.scene.add(meObj);
    } else {
      me = null;
    }
    camHeading = DOWNHILL;
    orbit.yaw = 0;
    phase = "countdown";
    cd.start(COUNTDOWN);
    LOBBY.hide();
    ARC.banner("Race " + d.round + " of " + d.rounds, 1200);
    renderHud();
  }

  function onRemote(a, from) {
    if (!Array.isArray(a) || phase === "idle") return;
    const o = others.push(from, { x: a[0], y: a[1], z: a[2], h: a[3] }, a[5]);
    if (o) o.data.flags = a[4];
  }

  function onState(d) {
    const fresh = d.finished.filter((id) => !finished.includes(id));
    finished = d.finished;
    raceEnds = performance.now() + d.endsIn;
    fresh.forEach((id) => {
      if (!firstDown) firstDown = performance.now();
      const p = players.find((x) => x.id === id);
      if (id !== room.myId && p) WG.toast(p.name + " is down! (#" + finished.length + ")", 1600);
    });
    renderHud();
  }

  function onOver(d) {
    phase = "over";
    scores = d.scores;
    ARC.banner(d.title, 3000);
    renderHud();
  }

  function renderHud() {
    if (!room || phase === "idle" || !players.length) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = players.map((p) => ({
      name: p.name,
      color: p.color,
      value: (scores[p.id] || 0) + (finished.includes(p.id) ? " ✓" : ""),
      me: p.id === room.myId,
    }));
    rows.push({ name: "Race", color: -1, value: roundNo + "/" + roundCount });
    if (me && phase === "play" && !me.out) {
      rows.push({ name: "Speed", color: -1, value: Math.round(me.s * 3.6) + " km/h" });
      rows.push({ name: "To go", color: -1, value: Math.max(0, Math.round(LENGTH + me.z)) + " m" });
    }
    if (firstDown && phase === "play") {
      const left = Math.max(0, Math.ceil((raceEnds - performance.now()) / 1000));
      rows.push({ name: "Ends in", color: -1, value: left + " s" });
    }
    ARC.scoreboard($("hud"), rows);
  }
  setInterval(() => {
    if (phase === "play") renderHud();
  }, 250);

  /* ---------- My sled ---------- */

  function slopeAt(x, z) {
    const e = 0.1;
    return { x: (height(x + e, z) - height(x - e, z)) / (2 * e), z: (height(x, z + e) - height(x, z - e)) / (2 * e) };
  }

  function stepMe(dt) {
    const now = performance.now();
    me.px = me.x;
    me.py = me.y;
    me.pz = me.z;
    if (phase !== "play" || me.out) return;
    const crashed = now < me.crashUntil;
    const tuck = ARC.input.held("up") && !crashed;
    const brake = ARC.input.held("down");
    const steer = (ARC.input.held("left") ? 1 : 0) - (ARC.input.held("right") ? 1 : 0);

    // the hill pulls the sled along the way it points
    const g = slopeAt(me.x, me.z);
    const along = g.x * Math.sin(me.h) + g.z * Math.cos(me.h);
    if (!me.air && !crashed) me.s += -along * PULL * dt;
    me.s -= (ROLL + (tuck ? DRAG.tuck : DRAG.plain) * me.s * me.s) * dt;
    if (brake && !me.air) me.s -= BRAKE * dt;
    if (crashed) me.s *= Math.max(0, 1 - 4 * dt);
    else if (!me.air && me.s < 1.2) me.s += 1.5 * dt; // a sled never quite stops on a slope
    me.s = Math.max(0, me.s);

    if (!me.air && !crashed && steer) {
      me.h += steer * (tuck ? TURN.tuck : TURN.plain) * dt * Math.min(1, 0.3 + me.s / 6);
    }
    // you can point only so far away from the way the track goes
    const trackH = trackHeading(me.z);
    me.h = trackH + ARC.clamp(turnFrom(me.h, trackH), -MAX_TURN, MAX_TURN);

    me.x += Math.sin(me.h) * me.s * dt;
    me.z += Math.cos(me.h) * me.s * dt;

    // the banks slow you down, turn you back down the track and let you slide back onto it
    const cx = centerX(me.z);
    const dx = me.x - cx;
    const over = Math.abs(dx) - HALF_W;
    if (over > 0) {
      me.s *= Math.max(0, 1 - Math.min(0.6, over * 0.22) * dt);
      me.h = ARC.lerpAngle(me.h, trackH + Math.sign(dx) * 0.5, Math.min(1, over * 0.9 * dt));
      me.x -= Math.sign(dx) * Math.min(4, over * 1.2) * dt;
      if (over > EDGE) me.x = cx + Math.sign(dx) * (HALF_W + EDGE);
    }

    // trees stop you dead, and you end up beside the tree rather than in front of it again
    if (!crashed && me.y - height(me.x, me.z) < 1.5) {
      for (const t of T.trees) {
        if (Math.abs(t.z - me.z) > 1.5 || (t === me.lastTree && now < me.lastTreeUntil)) continue;
        const tx = treeX(t);
        if (Math.hypot(me.x - tx, me.z - t.z) < SLED_R + 0.35) {
          me.s = Math.min(me.s, 1.5);
          me.crashUntil = now + CRASH_MS;
          me.x = tx + (Math.sign(me.x - tx) || 1) * (SLED_R + 0.6);
          me.lastTree = t;
          me.lastTreeUntil = now + CRASH_MS + 1500;
          WG.toast("Crash!", 800);
          break;
        }
      }
    }

    // bump the other sleds
    others.each((o) => {
      const p = o.obj.position;
      const ox = me.x - p.x;
      const oz = me.z - p.z;
      const d = Math.hypot(ox, oz);
      if (d < SLED_R * 2 && d > 1e-4 && Math.abs(me.y - p.y) < 1.2) {
        me.x += (ox / d) * (SLED_R * 2 - d);
        me.z += (oz / d) * (SLED_R * 2 - d);
      }
    });

    // on the snow, or flying: the lip of a ramp drops away faster than gravity pulls
    const ground = height(me.x, me.z);
    if (me.air) {
      me.vy -= GRAVITY * dt;
      me.y += me.vy * dt;
      if (me.y <= ground) {
        me.y = ground;
        me.air = false;
        // carry on down the slope at the speed the snow falls away (not 0, or it hops straight off again)
        me.vy = along * me.s;
      }
    } else {
      const follow = (ground - me.y) / dt;
      if (follow < me.vy - GRAVITY * dt * 1.5 && me.s > 6) {
        me.air = true;
        me.vy -= GRAVITY * dt;
        me.y += me.vy * dt;
      } else {
        me.vy = follow;
        me.y = ground;
      }
    }

    if (me.z <= -LENGTH) {
      me.out = true;
      const t = (now - raceStart) / 1000;
      ARC.banner("Down in " + t.toFixed(1) + " s!", 2200);
      room.to(room.hostId, "sl.fin", { t });
    }
  }

  /* ---------- Loop ---------- */

  function update(dt) {
    if (!room || phase === "idle") return;
    const now = performance.now();
    if (cd.tick(now) && phase === "countdown") {
      phase = "play";
      raceStart = now;
    }
    if (me) {
      stepMe(dt);
      if (sendDue(dt)) {
        const flags = (now < me.crashUntil ? 1 : 0) | (me.air ? 2 : 0) | (me.out ? 4 : 0);
        room.share("sl.p", [
          Math.round(me.x * 100) / 100,
          Math.round(me.y * 100) / 100,
          Math.round(me.z * 100) / 100,
          Math.round(me.h * 100) / 100,
          flags,
          Math.round(now * 10) / 10,
        ]);
      }
    }
    if (room.isHost && match && !match.over && phase === "play") hostCheck();
  }

  function tilt(obj, x, z, h, now, crashed) {
    const g = slopeAt(x, z);
    const along = g.x * Math.sin(h) + g.z * Math.cos(h);
    obj.rotation.set(0, h, 0);
    obj.rotateX(-Math.atan(along) * 0.9);
    if (crashed) obj.userData.rider.rotation.z = Math.sin(now / 60) * 0.4;
    else obj.userData.rider.rotation.z = 0;
  }

  let lastDraw = 0;
  const cam = { v: null, off: null };
  function draw(alpha) {
    if (!K) return;
    const now = performance.now();
    const dt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 0.016;
    lastDraw = now;
    if (!cam.v) {
      cam.v = new THREE.Vector3();
      cam.off = new THREE.Vector3();
    }
    orbit.turn(dt);
    others.update();
    others.each((o) => tilt(o.obj, o.obj.position.x, o.obj.position.z, o.obj.rotation.y, now, (o.data.flags || 0) & 1));

    const a = alpha || 0;
    if (me && meObj) {
      meObj.position.set(ARC.lerp(me.px, me.x, a), ARC.lerp(me.py, me.y, a), ARC.lerp(me.pz, me.z, a));
      tilt(meObj, me.x, me.z, me.h, now, now < me.crashUntil);
    }

    // the camera looks along the sled; let go of the mouse and it swings back behind it
    if (orbit.dragging || ARC.input.held("camLeft") || ARC.input.held("camRight")) lastDrag = now;
    else if (now - lastDrag > 2000) orbit.yaw *= Math.exp(-2.5 * dt);
    let target = me && meObj ? meObj.position : null;
    let heading = me ? me.h : DOWNHILL;
    if (!target || (me && me.out)) {
      // watch whoever is still racing, or the finish
      others.each((o) => {
        if (!target && !((o.data.flags || 0) & 4)) {
          target = o.obj.position;
          heading = o.obj.rotation.y;
        }
      });
    }
    if (target && phase !== "idle") {
      camHeading = ARC.lerpAngle(camHeading, heading, Math.min(1, dt * 4));
      const rel = orbit.yaw;
      orbit.yaw = rel + camHeading + Math.PI;
      orbit.offset(cam.off);
      orbit.yaw = rel;
      cam.v.set(target.x, target.y + 0.8, target.z);
      K.camera.position.copy(cam.v).add(cam.off);
      const ground = height(K.camera.position.x, K.camera.position.z);
      if (K.camera.position.y < ground + 1) K.camera.position.y = ground + 1;
      K.camera.lookAt(cam.v);
    } else {
      const t = now / 10000;
      K.camera.position.set(Math.sin(t) * 26, height(0, -10) + 14, -10 + Math.cos(t) * 26);
      K.camera.lookAt(0, height(0, -30), -30);
    }
    K.render();
  }
})();
