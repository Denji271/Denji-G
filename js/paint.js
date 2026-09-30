// Paint Wars — paint the floor your colour by walking over it and lobbing splats; most floor wins.
// Everybody moves their own character. The host paints for everybody, from where they walk and where
// their splats land, and sends out the squares that changed. Each player paints their own trail at once
// and falls back to the host's floor if the host did not see it that way.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SIZE = 40; // squares across; one square is one unit
  const HALF = SIZE / 2;
  const TRAIL_R = 1.05;
  const SPLAT_R = 2.2;
  const SPEED = { own: 7.4, none: 6, enemy: 4.3 };
  const SLOW_MS = 1200;
  const BODY_R = 0.45;
  const INK_MAX = 100;
  const INK_SHOT = 14;
  const INK_FILL = { own: 34, other: 7 };
  const SHOT_SPEED = 15;
  const GRAVITY = 18;
  const HAND_Y = 1.2;
  const BLOCK_H = 1.4;
  const MAX_RANGE = 15;
  const COOLDOWN_S = 0.28;
  const PREDICT_MS = 600;
  const SYNC_MS = 150;
  const COUNTDOWN = 3000;
  const SEND_MS = 33;
  const SPAWNS = [[-16, -16], [16, 16], [16, -16], [-16, 16]];
  const BLOCKED = 255;

  let K = null;
  let orbit = null;
  let others = null; // K3.crowd; data: { flags }
  let room = null;
  let phase = "idle"; // idle | countdown | play | done
  const cd = K3.countdown();
  let players = []; // [{ id, name, color }]
  let endsAt = 0;
  const hostGrid = new Uint8Array(SIZE * SIZE); // 0 bare, colour + 1 painted, BLOCKED under a block
  const grid = new Uint8Array(SIZE * SIZE); // what is shown: the host's floor plus my own fresh paint
  const predicted = new Map(); // square -> when I painted it myself
  let paintable = 1;
  let blocks = []; // in squares: { x0, z0, x1, z1 }
  let texData = null;
  let tex = null;
  let texDirty = true;
  let blockGroup = null;
  let me = null;
  let meObj = null;
  const shots = new Map(); // "owner:seq" -> { owner, color, x, y, z, vx, vy, vz, px, py, pz, mesh }
  const splashes = [];
  let shotSeq = 0;
  let pointer = null;
  let pointerAt = 0;
  let aimRing = null;
  let shotGeo = null;
  const shotMats = {};
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
    game: "paint",
    title: "Paint Wars",
    blurb: "Paint the floor your colour by running over it and lobbing splats. Most floor at the end wins. 2–4 players.",
    minPlayers: 2,
    lateNote: "A game is on — you jump straight in.",
    settings: [
      {
        key: "time",
        label: "Match length",
        value: 120,
        options: [
          { value: 90, label: "1½ minutes" },
          { value: 120, label: "2 minutes" },
          { value: 180, label: "3 minutes" },
        ],
      },
    ],
    onRoom,
    onStart: (v) => ready.then(() => startMatch(v)),
    onLobby: stopAll,
  });

  /* ---------- Setup ---------- */

  function setup() {
    K = K3.stage($("game"), { sky: { light: 0xcfe0f2, dark: 0x171d2a }, fog: [40, 90], shadowBox: 26 });
    K.sun.position.set(14, 30, 12);
    const canvas = $("game");
    orbit = K3.orbit(canvas, {
      yaw: 0,
      pitch: 0.9,
      dist: 16,
      minPitch: 0.3,
      maxPitch: 1.4,
      minDist: 7,
      maxDist: 30,
      onClick: (e) => {
        pointer = { clientX: e.clientX, clientY: e.clientY };
        pointerAt = performance.now();
        const p = K3.pointOnPlane(pointer, canvas, K.camera, 0);
        if (p) splatAt(p.x, p.z);
      },
    });
    others = K3.crowd(K.scene);

    texData = new Uint8Array(SIZE * SIZE * 4);
    tex = new THREE.DataTexture(texData, SIZE, SIZE, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    K.scene.add(floor);
    const lines = new THREE.GridHelper(SIZE, SIZE, 0x000000, 0x000000);
    lines.material.transparent = true;
    lines.material.opacity = 0.08;
    lines.position.y = 0.01;
    K.scene.add(lines);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x8a90a0, roughness: 0.9 });
    [
      [0, -HALF - 0.5, SIZE + 2, 1],
      [0, HALF + 0.5, SIZE + 2, 1],
      [-HALF - 0.5, 0, 1, SIZE],
      [HALF + 0.5, 0, 1, SIZE],
    ].forEach(([x, z, w, d]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 1, d), wallMat);
      wall.position.set(x, 0.5, z);
      K.scene.add(wall);
    });

    aimRing = new THREE.Mesh(
      new THREE.RingGeometry(SPLAT_R - 0.25, SPLAT_R, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false })
    );
    aimRing.rotation.x = -Math.PI / 2;
    aimRing.visible = false;
    K.scene.add(aimRing);
    shotGeo = new THREE.SphereGeometry(0.3, 12, 10);

    canvas.addEventListener("pointermove", (e) => {
      pointer = { clientX: e.clientX, clientY: e.clientY };
      pointerAt = performance.now();
    });
    canvas.addEventListener("pointerleave", () => (pointer = null));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => (texDirty = true));

    buildArena(1);
    const loop = ARC.loop(update, draw);
    loop.start();
  }

  function onRoom(r) {
    room = r;
    room.on("pt.start", when(onStart));
    room.on("pt.p", when(onRemote));
    room.on("pt.shot", when(onShot));
    room.on("pt.cells", when(onCells));
    room.on("pt.end", when(() => {
      phase = "done";
      renderHud();
    }));
    room.on("players", when(() => {
      others.keep((id) => !!room.player(id));
      renderHud();
    }));
    if (room.isHost) {
      room.on("join", when((p) => {
        if (match) room.to(p.id, "pt.start", startPayload(true));
      }));
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

  /* ---------- The floor ---------- */

  function buildArena(seed) {
    const rand = WG.rng(seed);
    hostGrid.fill(0);
    blocks = [];
    for (let tries = 0; blocks.length < 9 && tries < 400; tries++) {
      const w = 1 + Math.floor(rand() * 3);
      const d = 1 + Math.floor(rand() * 3);
      if (w * d < 2) continue;
      const x0 = 3 + Math.floor(rand() * (SIZE - 6 - w));
      const z0 = 3 + Math.floor(rand() * (SIZE - 6 - d));
      const b = { x0, z0, x1: x0 + w, z1: z0 + d };
      const cx = x0 + w / 2 - HALF;
      const cz = z0 + d / 2 - HALF;
      // the corners stay clear to start in, and blocks keep a gap between them
      if (SPAWNS.some(([sx, sz]) => Math.hypot(cx - sx, cz - sz) < 6)) continue;
      if (blocks.some((o) => x0 < o.x1 + 2 && o.x0 < b.x1 + 2 && z0 < o.z1 + 2 && o.z0 < b.z1 + 2)) continue;
      blocks.push(b);
    }
    blocks.forEach((b) => {
      for (let z = b.z0; z < b.z1; z++) for (let x = b.x0; x < b.x1; x++) hostGrid[z * SIZE + x] = BLOCKED;
    });
    paintable = hostGrid.reduce((n, v) => n + (v === BLOCKED ? 0 : 1), 0);
    grid.set(hostGrid);
    predicted.clear();
    texDirty = true;

    if (blockGroup) {
      K.scene.remove(blockGroup);
      K3.dispose(blockGroup);
    }
    blockGroup = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xb8bfcc, roughness: 0.8 });
    blocks.forEach((b) => {
      const w = b.x1 - b.x0;
      const d = b.z1 - b.z0;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, BLOCK_H, d), mat);
      m.position.set(b.x0 + w / 2 - HALF, BLOCK_H / 2, b.z0 + d / 2 - HALF);
      m.castShadow = true;
      m.receiveShadow = true;
      blockGroup.add(m);
    });
    K.scene.add(blockGroup);
  }

  function squareAt(x, z) {
    const cx = Math.floor(x + HALF);
    const cz = Math.floor(z + HALF);
    return cx < 0 || cz < 0 || cx >= SIZE || cz >= SIZE ? -1 : cz * SIZE + cx;
  }

  // Calls fn(square) for every square whose middle is within r of (x, z).
  function eachSquare(x, z, r, fn) {
    const c0 = Math.max(0, Math.floor(x + HALF - r));
    const c1 = Math.min(SIZE - 1, Math.floor(x + HALF + r));
    const r0 = Math.max(0, Math.floor(z + HALF - r));
    const r1 = Math.min(SIZE - 1, Math.floor(z + HALF + r));
    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const dx = cx + 0.5 - HALF - x;
        const dz = cz + 0.5 - HALF - z;
        if (dx * dx + dz * dz <= r * r) fn(cz * SIZE + cx);
      }
    }
  }

  // The host's paint is the real paint.
  function hostPaint(x, z, r, owner) {
    eachSquare(x, z, r, (i) => {
      if (hostGrid[i] === BLOCKED || hostGrid[i] === owner) return;
      hostGrid[i] = owner;
      grid[i] = owner;
      match.dirty.add(i);
      texDirty = true;
    });
  }

  // Everybody else shows their paint straight away and waits for the host to agree.
  function localPaint(x, z, r, owner) {
    const now = performance.now();
    eachSquare(x, z, r, (i) => {
      if (grid[i] === BLOCKED || grid[i] === owner) return;
      grid[i] = owner;
      predicted.set(i, now);
      texDirty = true;
    });
  }

  function paint(x, z, r, owner) {
    if (room && room.isHost && match) hostPaint(x, z, r, owner);
    else localPaint(x, z, r, owner);
  }

  function onCells(d) {
    if (!Array.isArray(d)) return;
    const now = performance.now();
    for (let k = 0; k + 1 < d.length; k += 2) {
      const i = d[k];
      if (i < 0 || i >= grid.length) continue;
      hostGrid[i] = d[k + 1];
      // my own fresh paint stays up for a moment; the host may simply not have seen me there yet
      const mine = predicted.get(i);
      if (mine && now - mine < PREDICT_MS) continue;
      predicted.delete(i);
      if (grid[i] !== hostGrid[i]) {
        grid[i] = hostGrid[i];
        texDirty = true;
      }
    }
  }

  // Paint the host never confirmed goes back to what the host says.
  function expirePredictions(now) {
    predicted.forEach((t, i) => {
      if (now - t < PREDICT_MS) return;
      predicted.delete(i);
      if (grid[i] !== hostGrid[i]) {
        grid[i] = hostGrid[i];
        texDirty = true;
      }
    });
  }

  function paintTexture() {
    const bare = ARC.colors.dark ? [58, 62, 72] : [228, 231, 236];
    const block = [120, 126, 138];
    const rgb = {};
    for (let c = 0; c < 4; c++) {
      const hex = NET.color(c);
      rgb[c + 1] = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }
    for (let cz = 0; cz < SIZE; cz++) {
      for (let cx = 0; cx < SIZE; cx++) {
        const v = grid[cz * SIZE + cx];
        const col = v === 0 ? bare : v === BLOCKED ? block : rgb[v] || bare;
        // the texture's first row is the far edge (+z comes towards the camera)
        const t = ((SIZE - 1 - cz) * SIZE + cx) * 4;
        texData[t] = col[0];
        texData[t + 1] = col[1];
        texData[t + 2] = col[2];
        texData[t + 3] = 255;
      }
    }
    tex.needsUpdate = true;
    texDirty = false;
  }

  function countPaint() {
    const counts = {};
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (v && v !== BLOCKED) counts[v] = (counts[v] || 0) + 1;
    }
    return counts;
  }

  /* ---------- Host ---------- */

  function startMatch(v) {
    const now = performance.now();
    match = {
      seed: (Math.random() * 1e9) | 0,
      startAt: now,
      endsAt: now + COUNTDOWN + v.time * 1000,
      dirty: new Set(),
      lastSync: now,
    };
    const d = startPayload(false);
    room.send("pt.start", d);
    onStart(d);
  }

  function startPayload(late) {
    const d = {
      seed: match.seed,
      elapsed: performance.now() - match.startAt,
      endsIn: Math.max(0, match.endsAt - performance.now()),
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    };
    if (late) d.cells = Array.from(hostGrid);
    return d;
  }

  function hostTick() {
    if (!match || phase === "done") return;
    const now = performance.now();
    if (phase === "play") {
      // everybody paints where they walk
      others.each((o, id) => {
        const s = o.buf.latest();
        const p = room.player(id);
        if (s && p && !(s.f & 1)) hostPaint(s.x, s.z, TRAIL_R, p.color + 1);
      });
    }
    if (now - match.lastSync >= SYNC_MS && match.dirty.size) {
      match.lastSync = now;
      const out = [];
      match.dirty.forEach((i) => out.push(i, hostGrid[i]));
      match.dirty.clear();
      room.send("pt.cells", out);
    }
    if (now >= match.endsAt) finish();
  }

  function finish() {
    const counts = {};
    hostGrid.forEach((v) => {
      if (v && v !== BLOCKED) counts[v] = (counts[v] || 0) + 1;
    });
    const rows = room.players
      .map((p) => ({ p, n: counts[p.color + 1] || 0 }))
      .sort((a, b) => b.n - a.n)
      .map(({ p, n }) => ({ name: p.name, color: p.color, value: Math.round((100 * n) / paintable) + "%", note: n + " squares" }));
    match = null;
    room.send("pt.end");
    phase = "done";
    LOBBY.results(rows, rows.length ? rows[0].name + " painted the most!" : "Game over");
  }

  /* ---------- Everybody ---------- */

  function spawnFor(id) {
    const order = players.map((p) => p.id).sort();
    return SPAWNS[Math.max(0, order.indexOf(id)) % SPAWNS.length];
  }

  function myColor() {
    const p = room && room.player(room.myId);
    return p ? p.color : 0;
  }

  function onStart(d) {
    buildArena(d.seed);
    if (Array.isArray(d.cells) && d.cells.length === grid.length) {
      hostGrid.set(d.cells);
      grid.set(d.cells);
    }
    others.clear();
    if (meObj) {
      K.scene.remove(meObj);
      K3.dispose(meObj);
    }
    shots.forEach((s) => K.scene.remove(s.mesh));
    shots.clear();
    players = d.players;
    const now = performance.now();
    endsAt = now + d.endsIn;
    players.forEach((p) => {
      if (p.id === room.myId) return;
      const o = others.add(p);
      const s = spawnFor(p.id);
      o.obj.position.set(s[0], 0, s[1]);
    });
    const s = spawnFor(room.myId);
    me = { x: s[0], z: s[1], px: s[0], pz: s[1], heading: Math.atan2(-s[0], -s[1]), ink: INK_MAX, cool: 0, slowUntil: 0 };
    meObj = K3.character(myColor());
    K.scene.add(meObj);
    orbit.yaw = Math.atan2(s[0], s[1]); // facing the middle
    const elapsed = d.elapsed || 0;
    phase = elapsed < COUNTDOWN ? "countdown" : "play";
    if (phase === "countdown") cd.start(COUNTDOWN - elapsed);
    LOBBY.hide();
    renderHud();
  }

  function onRemote(a, from) {
    if (!Array.isArray(a) || phase === "idle") return;
    if (!others.has(from)) {
      const p = room.player(from);
      if (!p) return;
      if (!players.some((x) => x.id === from)) players.push({ id: p.id, name: p.name, color: p.color });
      others.add(p);
    }
    const o = others.push(from, { x: a[0], z: a[1], h: a[2], f: a[3] }, a[4]);
    if (o) o.data.flags = a[3];
  }

  function onShot(d, from) {
    if (!d || from === room.myId) return;
    const p = room.player(from);
    spawnShot(from + ":" + d.id, from, p ? p.color : 0, d);
  }

  function spawnShot(key, owner, color, d) {
    if (!shotMats[color]) shotMats[color] = new THREE.MeshStandardMaterial({ color: new THREE.Color(NET.color(color)), roughness: 0.4 });
    const mesh = new THREE.Mesh(shotGeo, shotMats[color]);
    mesh.position.set(d.x, d.y, d.z);
    K.scene.add(mesh);
    shots.set(key, { owner, color, x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, vz: d.vz, px: d.x, py: d.y, pz: d.z, mesh, hitMe: false });
  }

  function splash(x, z, color) {
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(SPLAT_R, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(NET.color(color)), transparent: true, opacity: 0.8, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.05, z);
    K.scene.add(mesh);
    splashes.push({ mesh, t0: performance.now() });
  }

  function renderHud() {
    if (!room || phase === "idle" || !players.length) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const counts = countPaint();
    const rows = players.map((p) => ({
      name: p.name,
      color: p.color,
      value: Math.round((100 * (counts[p.color + 1] || 0)) / paintable) + "%",
      me: p.id === room.myId,
    }));
    const left = Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));
    rows.push({ name: "Time", color: -1, value: Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") });
    if (me) {
      const bars = Math.round((me.ink / INK_MAX) * 8);
      rows.push({ name: "Ink", color: -1, value: "▰".repeat(bars) + "▱".repeat(8 - bars) });
    }
    ARC.scoreboard($("hud"), rows);
  }
  setInterval(() => {
    if (phase === "play" || phase === "countdown") renderHud();
  }, 400);

  /* ---------- Me ---------- */

  function aimPoint() {
    if (!pointer || !K) return null;
    return K3.pointOnPlane(pointer, $("game"), K.camera, 0);
  }

  // Lob a splat so it lands on the spot.
  function splatAt(tx, tz) {
    if (!me || phase !== "play" || me.cool > 0) return;
    if (me.ink < INK_SHOT) {
      WG.toast("Out of ink — stand on your own colour to fill up", 1300);
      return;
    }
    let dx = tx - me.x;
    let dz = tz - me.z;
    let dist = Math.hypot(dx, dz);
    if (dist < 0.01) {
      dx = Math.sin(me.heading);
      dz = Math.cos(me.heading);
      dist = 1;
    }
    dx /= dist;
    dz /= dist;
    dist = ARC.clamp(dist, 2, MAX_RANGE);
    me.heading = Math.atan2(dx, dz);
    const t = dist / SHOT_SPEED;
    const d = {
      id: ++shotSeq,
      x: Math.round((me.x + dx * 0.5) * 100) / 100,
      y: HAND_Y,
      z: Math.round((me.z + dz * 0.5) * 100) / 100,
      vx: Math.round(dx * SHOT_SPEED * 100) / 100,
      vy: Math.round((-HAND_Y / t + 0.5 * GRAVITY * t) * 100) / 100,
      vz: Math.round(dz * SHOT_SPEED * 100) / 100,
    };
    me.ink -= INK_SHOT;
    me.cool = COOLDOWN_S;
    spawnShot(room.myId + ":" + d.id, room.myId, myColor(), d);
    room.share("pt.shot", d);
    renderHud();
  }

  function pushOut(p, r) {
    blocks.forEach((b) => {
      const x0 = b.x0 - HALF;
      const x1 = b.x1 - HALF;
      const z0 = b.z0 - HALF;
      const z1 = b.z1 - HALF;
      const cx = ARC.clamp(p.x, x0, x1);
      const cz = ARC.clamp(p.z, z0, z1);
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d = Math.hypot(dx, dz);
      if (d >= r) return;
      if (d > 1e-4) {
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
      } else {
        const pen = [p.x - x0, x1 - p.x, p.z - z0, z1 - p.z];
        const k = pen.indexOf(Math.min(...pen));
        if (k === 0) p.x = x0 - r;
        else if (k === 1) p.x = x1 + r;
        else if (k === 2) p.z = z0 - r;
        else p.z = z1 + r;
      }
    });
    p.x = ARC.clamp(p.x, -HALF + r, HALF - r);
    p.z = ARC.clamp(p.z, -HALF + r, HALF - r);
  }

  function stepMe(dt) {
    const now = performance.now();
    me.px = me.x;
    me.pz = me.z;
    me.cool = Math.max(0, me.cool - dt);
    const mine = myColor() + 1;
    const under = grid[squareAt(me.x, me.z)];
    const onOwn = under === mine;
    me.ink = Math.min(INK_MAX, me.ink + (onOwn ? INK_FILL.own : INK_FILL.other) * dt);
    if (phase !== "play") return;

    let speed = onOwn ? SPEED.own : under && under !== BLOCKED ? SPEED.enemy : SPEED.none;
    if (now < me.slowUntil) speed *= 0.5;
    const dir = K3.walkDir(orbit);
    me.x += dir.x * speed * dt;
    me.z += dir.z * speed * dt;
    pushOut(me, BODY_R);
    others.each((o) => {
      const p = o.obj.position;
      const dx = me.x - p.x;
      const dz = me.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < BODY_R * 2 && d > 1e-4) {
        me.x += (dx / d) * (BODY_R * 2 - d);
        me.z += (dz / d) * (BODY_R * 2 - d);
      }
    });

    const aim = now - pointerAt < 2500 && !orbit.dragging ? aimPoint() : null;
    if (aim) me.heading = Math.atan2(aim.x - me.x, aim.z - me.z);
    else if (dir.len) me.heading = ARC.lerpAngle(me.heading, Math.atan2(dir.x, dir.z), Math.min(1, dt * 12));

    // painted from the same rounded spot the others (and the host) get, so squares on the edge agree
    paint(Math.round(me.x * 100) / 100, Math.round(me.z * 100) / 100, TRAIL_R, mine);
    if (ARC.input.hit("action") || ARC.input.hit("attack")) splatAt(me.x + Math.sin(me.heading) * 8, me.z + Math.cos(me.heading) * 8);
  }

  function inBlock(x, y, z) {
    if (y > BLOCK_H) return false;
    return blocks.some((b) => x > b.x0 - HALF && x < b.x1 - HALF && z > b.z0 - HALF && z < b.z1 - HALF);
  }

  function stepShots(dt) {
    const now = performance.now();
    shots.forEach((s, key) => {
      s.px = s.x;
      s.py = s.y;
      s.pz = s.z;
      s.vy -= GRAVITY * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      // a splat on my head slows me down for a moment (it still flies on and lands)
      if (me && !s.hitMe && s.owner !== room.myId && s.y < 1.9 && Math.hypot(s.x - me.x, s.z - me.z) < 0.7) {
        s.hitMe = true;
        me.slowUntil = now + SLOW_MS;
        WG.toast("Splat! You're slowed down", 900);
      }
      const out = Math.abs(s.x) > HALF + 2 || Math.abs(s.z) > HALF + 2;
      if (s.y <= 0 || inBlock(s.x, s.y, s.z) || out) {
        K.scene.remove(s.mesh);
        shots.delete(key);
        if (out) return;
        if (phase === "play") paint(s.x, s.z, SPLAT_R, s.color + 1);
        splash(s.x, s.z, s.color);
      }
    });
  }

  /* ---------- Loop ---------- */

  function update(dt) {
    if (!room || phase === "idle") return;
    const now = performance.now();
    if (cd.tick(now) && phase === "countdown") phase = "play";
    stepShots(dt);
    if (me) {
      stepMe(dt);
      if (sendDue(dt)) {
        const flags = now < me.slowUntil ? 2 : 0;
        room.share("pt.p", [Math.round(me.x * 100) / 100, Math.round(me.z * 100) / 100, Math.round(me.heading * 100) / 100, flags, Math.round(now * 10) / 10]);
      }
    }
    if (!room.isHost) expirePredictions(now);
    else hostTick();
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
    if (texDirty) paintTexture();
    others.update();
    const a = alpha || 0;
    shots.forEach((s) => s.mesh.position.set(ARC.lerp(s.px, s.x, a), ARC.lerp(s.py, s.y, a), ARC.lerp(s.pz, s.z, a)));
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i];
      const t = (now - s.t0) / 300;
      if (t >= 1) {
        K.scene.remove(s.mesh);
        K3.dispose(s.mesh);
        splashes.splice(i, 1);
        continue;
      }
      s.mesh.scale.setScalar(0.4 + t * 0.8);
      s.mesh.material.opacity = 0.8 * (1 - t);
    }

    if (me && meObj) {
      meObj.position.set(ARC.lerp(me.px, me.x, a), 0, ARC.lerp(me.pz, me.z, a));
      meObj.rotation.y = me.heading;
    }

    const aim = phase === "play" && me && !orbit.dragging ? aimPoint() : null;
    aimRing.visible = !!aim;
    if (aim) {
      const dx = aim.x - me.x;
      const dz = aim.z - me.z;
      const d = Math.hypot(dx, dz);
      const k = d > MAX_RANGE ? MAX_RANGE / d : 1;
      aimRing.position.set(me.x + dx * k, 0.04, me.z + dz * k);
      aimRing.material.color.set(NET.color(myColor()));
    }

    if (me && meObj && phase !== "idle") {
      cam.v.copy(meObj.position);
      K.camera.position.copy(cam.v).add(orbit.offset(cam.off));
      K.camera.lookAt(cam.v.x, cam.v.y + 0.6, cam.v.z);
    } else {
      const t = now / 12000;
      K.camera.position.set(Math.sin(t) * 32, 24, Math.cos(t) * 32);
      K.camera.lookAt(0, 0, 0);
    }
    K.render();
  }
})();
