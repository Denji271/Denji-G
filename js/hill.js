// King of the Hill — stand alone in the glowing ring on the hill and your clock ticks up.
// Everybody moves their own character; shoves are decided by whoever shoves (what you see is
// what you hit). The host watches everybody's positions, keeps the clocks and moves the ring.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ARENA_R = 16; // the island
  const HILL_R = 8.5;
  const TOP_R = 2.4; // the flat top
  const HILL_H = 3.2;
  const ZONE_R = 2.3;
  const ZONE_SPOTS = [[0, 0], [5.4, 0], [0, 5.4], [-5.4, 0], [0, -5.4]]; // the top, then the four shoulders
  const ZONE_EVERY = 30000;
  const SPEED = 6;
  const GRAVITY = 24;
  const JUMP = 8;
  const SLIDE = 2.2; // how hard the slope pulls you down
  const BODY_R = 0.45;
  const DASH_S = 0.18;
  const DASH_SPEED = 14;
  const DASH_COOL = 1.1;
  const SHOVE = 11;
  const RESPAWN_MS = 2000;
  const COUNTDOWN = 3000;
  const SEND_MS = 33;
  const HOLD_COLOR = "#f0c419";

  let K = null;
  let orbit = null;
  let others = null; // K3.crowd; data: { flags }
  let room = null;
  let phase = "idle"; // idle | countdown | play | done
  const cd = K3.countdown();
  let players = []; // [{ id, name, color }]
  let scores = {}; // id -> seconds
  let zone = { x: 0, z: 0 };
  let holder = null;
  let contested = false;
  let endsAt = 0;
  let target = 60;
  let me = null;
  let meObj = null;
  let zoneMesh = null;
  let crown = null;
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
    game: "hill",
    title: "King of the Hill",
    blurb: "Hold the glowing ring on the hill all by yourself — shove everybody else out of it. 2–4 players.",
    minPlayers: 2,
    lateNote: "A game is on — you jump straight in.",
    settings: [
      {
        key: "target",
        label: "Win at",
        value: 60,
        options: [
          { value: 30, label: "30 seconds" },
          { value: 60, label: "60 seconds" },
          { value: 90, label: "90 seconds" },
        ],
      },
      {
        key: "time",
        label: "Time limit",
        value: 180,
        options: [
          { value: 120, label: "2 minutes" },
          { value: 180, label: "3 minutes" },
          { value: 300, label: "5 minutes" },
        ],
      },
    ],
    onRoom,
    onStart: (v) => ready.then(() => startMatch(v)),
    onLobby: stopAll,
  });

  /* ---------- The island ---------- */

  // The hill's height at a distance from the middle.
  function hillAt(d) {
    if (d <= TOP_R) return HILL_H;
    if (d >= HILL_R) return 0;
    const t = (d - TOP_R) / (HILL_R - TOP_R);
    return HILL_H * (1 - t * t * (3 - 2 * t));
  }

  // Ground height at a point, or -Infinity off the island.
  function height(x, z) {
    const d = Math.hypot(x, z);
    return d > ARENA_R ? -Infinity : hillAt(d);
  }

  function slope(x, z) {
    const e = 0.05;
    const h = (a, b) => {
      const v = height(a, b);
      return v === -Infinity ? 0 : v;
    };
    return { x: (h(x + e, z) - h(x - e, z)) / (2 * e), z: (h(x, z + e) - h(x, z - e)) / (2 * e) };
  }

  function setup() {
    K = K3.stage($("game"), { sky: { light: 0xaedcff, dark: 0x151c2b }, fog: [35, 90], shadowBox: 20 });
    K.sun.position.set(12, 30, 10);
    orbit = K3.orbit($("game"), { yaw: 0, pitch: 0.55, dist: 11, minPitch: 0.1, maxPitch: 1.35, minDist: 5, maxDist: 26, onClick: () => shove() });
    others = K3.crowd(K.scene);

    // the island: rings of vertices lifted by the hill
    const rings = 48;
    const segs = 72;
    const pos = [];
    const col = [];
    const low = new THREE.Color(0x4f9a4a);
    const high = new THREE.Color(0x8ccf6a);
    const c = new THREE.Color();
    for (let i = 0; i <= rings; i++) {
      const r = (ARENA_R * i) / rings;
      for (let j = 0; j <= segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const y = hillAt(r); // not height(): the very edge may round to just off the island
        pos.push(x, y, z);
        c.copy(low).lerp(high, y / HILL_H);
        col.push(c.r, c.g, c.b);
      }
    }
    const idx = [];
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = i * (segs + 1) + j;
        const b = a + segs + 1;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    ground.receiveShadow = true;
    K.scene.add(ground);
    const cliff = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_R, ARENA_R * 0.75, 4, 72, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 1 })
    );
    cliff.position.y = -2;
    K.scene.add(cliff);

    // the ring: a see-through column of light
    zoneMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(ZONE_R, ZONE_R, 3, 40, 1, true),
      new THREE.MeshBasicMaterial({ color: HOLD_COLOR, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
    );
    K.scene.add(zoneMesh);

    // the holder's crown
    crown = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({ color: 0xf0c419, metalness: 0.6, roughness: 0.3 });
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.16, 12), gold);
    crown.add(band);
    for (let k = 0; k < 5; k++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 6), gold);
      const a = (k / 5) * Math.PI * 2;
      spike.position.set(Math.cos(a) * 0.26, 0.17, Math.sin(a) * 0.26);
      crown.add(spike);
    }
    crown.visible = false;
    K.scene.add(crown);

    const loop = ARC.loop(update, draw);
    loop.start();
  }

  function onRoom(r) {
    room = r;
    room.on("hl.start", when(onStart));
    room.on("hl.p", when(onRemote));
    room.on("hl.push", when(onPush));
    room.on("hl.score", when(onScore));
    room.on("hl.end", when(() => {
      phase = "done";
      renderHud();
    }));
    room.on("players", when(() => {
      others.keep((id) => !!room.player(id));
      renderHud();
    }));
    if (room.isHost) {
      room.on("join", when((p) => {
        if (!match) return;
        if (match.scores[p.id] === undefined) match.scores[p.id] = 0;
        room.to(p.id, "hl.start", startPayload());
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

  /* ---------- Host ---------- */

  function startMatch(v) {
    const now = performance.now();
    match = {
      target: v.target,
      startAt: now,
      endsAt: now + COUNTDOWN + v.time * 1000,
      scores: {},
      zoneAt: 0,
      zoneMoves: now + COUNTDOWN + ZONE_EVERY,
      holder: null,
      contested: false,
      lastSync: 0,
    };
    room.players.forEach((p) => (match.scores[p.id] = 0));
    const d = startPayload();
    room.send("hl.start", d);
    onStart(d);
  }

  function startPayload() {
    const spot = ZONE_SPOTS[match.zoneAt];
    return {
      elapsed: performance.now() - match.startAt,
      endsIn: Math.max(0, match.endsAt - performance.now()),
      target: match.target,
      zone: spot,
      scores: match.scores,
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    };
  }

  // Who is standing in the ring right now (on the ground, not falling back in).
  function inZone(x, y, z, flags) {
    if (flags & 1) return false;
    const spot = ZONE_SPOTS[match.zoneAt];
    if (Math.hypot(x - spot[0], z - spot[1]) > ZONE_R) return false;
    return y > height(x, z) - 0.6;
  }

  function hostTick(dt) {
    if (!match || phase === "done") return;
    const now = performance.now();
    if (now < match.startAt + COUNTDOWN) return;

    const inside = [];
    if (me && inZone(me.x, me.y, me.z, me.respawnAt ? 1 : 0)) inside.push(room.myId);
    others.each((o, id) => {
      const s = o.buf.latest();
      if (s && inZone(s.x, s.y, s.z, s.f || 0)) inside.push(id);
    });
    match.holder = inside.length === 1 ? inside[0] : null;
    match.contested = inside.length > 1;
    if (match.holder && match.scores[match.holder] !== undefined) match.scores[match.holder] += dt;

    if (now >= match.zoneMoves) {
      // somewhere else on the hill
      match.zoneAt = (match.zoneAt + 1 + Math.floor(Math.random() * (ZONE_SPOTS.length - 1))) % ZONE_SPOTS.length;
      match.zoneMoves = now + ZONE_EVERY;
    }

    const best = Object.entries(match.scores).sort((a, b) => b[1] - a[1])[0];
    if ((best && best[1] >= match.target) || now >= match.endsAt) {
      finish();
      return;
    }
    if (now - match.lastSync > 250) {
      match.lastSync = now;
      const d = {
        scores: roundScores(match.scores),
        zone: ZONE_SPOTS[match.zoneAt],
        holder: match.holder,
        contested: match.contested,
        endsIn: Math.max(0, match.endsAt - now),
        movesIn: Math.max(0, match.zoneMoves - now),
      };
      room.send("hl.score", d);
      onScore(d);
    }
  }

  function roundScores(s) {
    const out = {};
    Object.keys(s).forEach((id) => (out[id] = Math.round(s[id] * 10) / 10));
    return out;
  }

  function finish() {
    const rows = room.players
      .filter((p) => match.scores[p.id] !== undefined)
      .sort((a, b) => match.scores[b.id] - match.scores[a.id])
      .map((p) => ({ name: p.name, color: p.color, value: match.scores[p.id].toFixed(1) + " s", note: "on the hill" }));
    match = null;
    room.send("hl.end");
    phase = "done";
    crown.visible = false;
    LOBBY.results(rows, rows.length ? rows[0].name + " is king of the hill!" : "Game over");
  }

  /* ---------- Everybody ---------- */

  function spawnSpot(id) {
    const order = players.map((p) => p.id).sort();
    const k = Math.max(0, order.indexOf(id));
    const a = (k / Math.max(2, order.length)) * Math.PI * 2 + Math.PI / 4;
    return [Math.cos(a) * 12, Math.sin(a) * 12];
  }

  function onStart(d) {
    others.clear();
    if (meObj) {
      K.scene.remove(meObj);
      K3.dispose(meObj);
    }
    players = d.players;
    scores = d.scores || {};
    target = d.target;
    zone = { x: d.zone[0], z: d.zone[1] };
    holder = null;
    const now = performance.now();
    endsAt = now + d.endsIn;
    players.forEach((p) => {
      if (p.id === room.myId) return;
      const o = others.add(p);
      const s = spawnSpot(p.id);
      o.obj.position.set(s[0], 0, s[1]);
    });
    const s = spawnSpot(room.myId);
    me = { x: s[0], y: 0, z: s[1], vx: 0, vy: 0, vz: 0, heading: Math.atan2(-s[0], -s[1]), ground: true, dash: 0, cool: 0, stun: 0, hit: new Set(), respawnAt: 0 };
    me.px = me.x;
    me.py = me.y;
    me.pz = me.z;
    const my = players.find((p) => p.id === room.myId);
    meObj = K3.character(my ? my.color : 0);
    K.scene.add(meObj);
    orbit.yaw = Math.atan2(s[0], s[1]); // look towards the hill
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
      renderHud();
    }
    const o = others.push(from, { x: a[0], y: a[1], z: a[2], h: a[3], f: a[4] }, a[5]);
    if (o) o.data.flags = a[4];
  }

  // Somebody shoved me: fly away from them.
  function onPush(d) {
    if (!me || !d || d.to !== room.myId || me.respawnAt || phase !== "play") return;
    const len = Math.hypot(d.dx, d.dz) || 1;
    me.vx += (d.dx / len) * SHOVE;
    me.vz += (d.dz / len) * SHOVE;
    me.vy = Math.max(me.vy, 4.5);
    me.ground = false;
    me.stun = 0.4;
  }

  function onScore(d) {
    scores = d.scores;
    zone = { x: d.zone[0], z: d.zone[1] };
    holder = d.holder;
    contested = d.contested;
    endsAt = performance.now() + d.endsIn;
    renderHud();
  }

  function renderHud() {
    if (!room || phase === "idle" || !players.length) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = players.map((p) => ({
      name: (p.id === holder ? "♛ " : "") + p.name,
      color: p.color,
      value: Math.floor(scores[p.id] || 0) + " s",
      me: p.id === room.myId,
    }));
    const left = Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));
    rows.push({ name: "Win at", color: -1, value: target + " s" });
    rows.push({ name: "Time", color: -1, value: Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") });
    ARC.scoreboard($("hud"), rows);
  }
  setInterval(() => {
    if (phase === "play" || phase === "countdown") renderHud();
  }, 500);

  /* ---------- My character ---------- */

  // Click or J: a short dash that knocks over whoever it runs into.
  function shove() {
    if (!me || phase !== "play" || me.respawnAt || me.cool > 0 || me.stun > 0) return;
    let dx = Math.sin(me.heading);
    let dz = Math.cos(me.heading);
    const dir = K3.walkDir(orbit);
    if (dir.len) {
      dx = dir.x;
      dz = dir.z;
    } else {
      // standing still: shove the way the camera looks
      const f = orbit.move(1, 0);
      const l = Math.hypot(f.x, f.z) || 1;
      dx = f.x / l;
      dz = f.z / l;
    }
    me.heading = Math.atan2(dx, dz);
    me.dash = DASH_S;
    me.cool = DASH_COOL;
    me.hit = new Set();
  }

  function respawn() {
    const a = Math.random() * Math.PI * 2;
    me.x = Math.cos(a) * 13;
    me.z = Math.sin(a) * 13;
    me.y = 0;
    me.vx = me.vy = me.vz = 0;
    me.px = me.x;
    me.py = me.y;
    me.pz = me.z;
    me.respawnAt = 0;
    me.heading = Math.atan2(-me.x, -me.z);
  }

  function stepMe(dt) {
    const now = performance.now();
    me.px = me.x;
    me.py = me.y;
    me.pz = me.z;
    me.cool = Math.max(0, me.cool - dt);
    me.stun = Math.max(0, me.stun - dt);
    if (me.respawnAt) {
      if (now >= me.respawnAt) respawn();
      return;
    }
    const canMove = phase === "play";
    const dir = canMove ? K3.walkDir(orbit) : { x: 0, z: 0, len: 0 };
    const g = slope(me.x, me.z);

    // uphill is slow, downhill a little quicker
    let speed = SPEED;
    if (dir.len) {
      const up = g.x * dir.x + g.z * dir.z;
      speed *= up > 0 ? Math.max(0.5, 1 - up * 0.45) : Math.min(1.25, 1 - up * 0.2);
      if (!me.dash) me.heading = ARC.lerpAngle(me.heading, Math.atan2(dir.x, dir.z), Math.min(1, dt * 14));
    }
    let tx = dir.x * speed;
    let tz = dir.z * speed;
    let grip = me.ground ? 10 : 2;
    if (me.stun > 0) grip = 0.6;
    if (me.dash > 0) {
      me.dash = Math.max(0, me.dash - dt);
      tx = Math.sin(me.heading) * DASH_SPEED;
      tz = Math.cos(me.heading) * DASH_SPEED;
      grip = 25;
    }
    me.vx += (tx - me.vx) * Math.min(1, grip * dt);
    me.vz += (tz - me.vz) * Math.min(1, grip * dt);
    if (me.ground) {
      me.vx -= g.x * SLIDE * dt;
      me.vz -= g.z * SLIDE * dt;
    }
    if (canMove && me.ground && ARC.input.hit("action")) {
      me.vy = JUMP;
      me.ground = false;
    }
    if (canMove && ARC.input.hit("attack")) shove();

    const wasGround = me.ground;
    me.vy -= GRAVITY * dt;
    me.x += me.vx * dt;
    me.y += me.vy * dt;
    me.z += me.vz * dt;

    // bump into the others, and knock over whoever my dash runs into
    others.each((o, id) => {
      if (o.data.flags & 1) return;
      const p = o.obj.position;
      if (Math.abs(me.y - p.y) > 1.4) return;
      const dx = me.x - p.x;
      const dz = me.z - p.z;
      const d = Math.hypot(dx, dz);
      if (me.dash > 0 && d < 1.2 && !me.hit.has(id)) {
        me.hit.add(id);
        room.share("hl.push", { to: id, dx: -dx, dz: -dz });
      }
      if (d < BODY_R * 2 && d > 1e-4) {
        me.x += (dx / d) * (BODY_R * 2 - d);
        me.z += (dz / d) * (BODY_R * 2 - d);
      }
    });

    // stand on the ground (and stick to it walking downhill)
    const ground = height(me.x, me.z);
    me.ground = false;
    if (ground !== -Infinity && (me.y <= ground || (wasGround && me.vy <= 0 && me.y - ground < 0.35))) {
      me.y = ground;
      me.vy = 0;
      me.ground = true;
    }
    if (me.y < -14) me.respawnAt = now + RESPAWN_MS;
  }

  /* ---------- Loop ---------- */

  function update(dt) {
    if (!room || phase === "idle") return;
    const now = performance.now();
    if (cd.tick(now) && phase === "countdown") phase = "play";
    if (me) {
      stepMe(dt);
      if (sendDue(dt)) {
        const flags = (me.respawnAt ? 1 : 0) | (me.dash > 0 ? 2 : 0);
        room.share("hl.p", [
          Math.round(me.x * 100) / 100,
          Math.round(me.y * 100) / 100,
          Math.round(me.z * 100) / 100,
          Math.round(me.heading * 100) / 100,
          flags,
          Math.round(now * 10) / 10,
        ]);
      }
    }
    if (room.isHost) hostTick(dt);
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
    others.each((o) => (o.obj.visible = !(o.data.flags & 1)));

    if (me && meObj) {
      const a = alpha || 0;
      meObj.position.set(ARC.lerp(me.px, me.x, a), ARC.lerp(me.py, me.y, a), ARC.lerp(me.pz, me.z, a));
      meObj.rotation.y = me.heading;
      meObj.visible = !me.respawnAt;
      meObj.rotation.x = me.dash > 0 ? 0.35 : 0;
    }

    // the ring: gold when free, the holder's colour when held, flashing when fought over
    const zy = height(zone.x, zone.z);
    zoneMesh.position.set(zone.x, (zy === -Infinity ? 0 : zy) + 1, zone.z);
    const holderP = players.find((p) => p.id === holder);
    const color = contested && Math.floor(now / 150) % 2 ? "#e05c4a" : holderP ? NET.color(holderP.color) : HOLD_COLOR;
    zoneMesh.material.color.set(color);
    zoneMesh.material.opacity = 0.18 + 0.08 * Math.sin(now / 250);

    // the crown floats over the holder's head
    const holderObj = holder === room?.myId ? meObj : holder && others.get(holder) ? others.get(holder).obj : null;
    crown.visible = !!holderObj && holderObj.visible && phase === "play";
    if (crown.visible) {
      crown.position.set(holderObj.position.x, holderObj.position.y + 1.65, holderObj.position.z);
      crown.rotation.y = now / 600;
    }

    if (me && meObj && phase !== "idle") {
      // follow me (or the spot I will come back at) and turn with the mouse
      cam.v.set(meObj.position.x, Math.max(meObj.position.y, -2), meObj.position.z);
      K.camera.position.copy(cam.v).add(orbit.offset(cam.off));
      K.camera.lookAt(cam.v.x, cam.v.y + 0.6, cam.v.z);
    } else {
      const t = now / 12000;
      K.camera.position.set(Math.sin(t) * 28, 16, Math.cos(t) * 28);
      K.camera.lookAt(0, 1, 0);
    }
    K.render();
  }
})();
