// Hex-a-gone — the floors are made of hexagons that drop away a moment after somebody steps on them.
// Fall through the last floor and you are out; the last player standing wins the round.
// Everybody moves their own character; the host decides which tiles fall and who is out.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const R = 1; // hexagon size, centre to corner
  const RINGS = 6; // rings around the middle tile: 127 tiles a floor
  const GAP = 7; // height between floors
  const TILE_H = 0.5;
  const DROP_MS = 650; // from the first step until the tile goes
  const FALL_MS = 800; // the tile tumbling away
  const COUNTDOWN = 3000;
  const GRACE_MS = 1500; // after "Go!" the tiles hold for a moment
  const SPEED = 6.2;
  const GRAVITY = 26;
  const JUMP = 9.5;
  const BODY_R = 0.45;
  const SEND_MS = 33;
  const FLOOR_COLORS = ["#f0c419", "#57a05a", "#2f6fde", "#9a5bd6"];
  const HOT = "#e05c4a";
  const CEILING = GAP - 1.2; // on a lower floor the camera stays under the floor above

  // The same layout on every floor (pointy-top hexagons, axial coordinates).
  const CELLS = [];
  const INDEX = new Map();
  for (let q = -RINGS; q <= RINGS; q++) {
    for (let r = Math.max(-RINGS, -q - RINGS); r <= Math.min(RINGS, -q + RINGS); r++) {
      INDEX.set(q + "," + r, CELLS.length);
      CELLS.push({ x: Math.sqrt(3) * R * (q + r / 2), z: 1.5 * R * r });
    }
  }

  // Which tile a point is over, or -1.
  function cellAt(x, z) {
    const q = ((Math.sqrt(3) / 3) * x - z / 3) / R;
    const r = ((2 / 3) * z) / R;
    const s = -q - r;
    let rq = Math.round(q);
    let rr = Math.round(r);
    const rs = Math.round(s);
    const dq = Math.abs(rq - q);
    const dr = Math.abs(rr - r);
    const ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    const i = INDEX.get(rq + "," + rr);
    return i === undefined ? -1 : i;
  }

  const floorY = (f) => -f * GAP;

  let K = null; // the 3D stage once Three.js has loaded
  let orbit = null; // the mouse camera
  let room = null;
  let phase = "idle"; // idle | countdown | play | over
  const cd = K3.countdown();
  let graceEnd = 0;
  let floors = 3;
  let tiles = []; // per floor: [{ dropAt }] on the local clock; Infinity while it holds
  let floorMeshes = [];
  const moving = new Set(); // "f,i" of tiles shaking or falling
  let players = []; // this round: [{ id, name, color, score }]
  let me = null; // { x, y, z, vx, vy, vz, px, py, pz, heading, ground, coyote, floor, cell, out }
  let meObj = null;
  let others = null; // K3.crowd of the other players; data.out once they fell
  let spectating = false;
  let roundNo = 0;
  let roundCount = 0;
  const sendDue = ARC.every(SEND_MS);

  // host only
  let match = null;

  const ready = K3.load()
    .then(setup)
    .catch((err) => {
      K3.fail($("game"), err.message);
      throw err;
    });
  // Messages can arrive before the 3D scene exists; they wait for it, still in order.
  const when = (fn) => (d, from) => ready.then(() => fn(d, from));

  LOBBY.init({
    game: "hexagone",
    title: "Hex-a-gone",
    blurb: "The floor falls away under your feet. Keep moving, jump the holes and be the last one standing. 1–4 players.",
    lateNote: "A round is on right now — you can watch, and you are in from the next round.",
    settings: [
      {
        key: "floors",
        label: "Floors",
        value: 3,
        options: [
          { value: 2, label: "2" },
          { value: 3, label: "3" },
          { value: 4, label: "4" },
        ],
      },
      {
        key: "rounds",
        label: "Rounds",
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

  function setup() {
    K = K3.stage($("game"), { sky: { light: 0xa9d8ff, dark: 0x141a28 }, fog: [18, 60], shadowBox: 14 });
    K.sun.position.set(10, 30, 8);
    K.sun.target.position.set(0, -6, 0);
    orbit = K3.orbit($("game"), { yaw: 0, pitch: 0.6, dist: 10, minPitch: 0.12, maxPitch: 1.25, minDist: 5, maxDist: 18 });
    others = K3.crowd(K.scene);
    buildFloors(3);
    const loop = ARC.loop(update, draw);
    loop.start();
  }

  function onRoom(r) {
    room = r;
    room.on("hx.round", when(onRound));
    room.on("hx.p", when(onRemote));
    room.on("hx.drop", when(onDrop));
    room.on("hx.dead", when(onDead));
    room.on("hx.over", when(onOver));
    room.on("players", renderHud);
    if (room.isHost) {
      room.on("hx.step", when(hostStep));
      room.on("hx.out", when((d, from) => hostOut(from)));
      room.on("join", when((p) => {
        if (match && !match.over) room.to(p.id, "hx.round", roundPayload(true));
      }));
      room.on("leave", when((p) => hostOut(p.id)));
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
    match = { rounds: v.rounds, floors: v.floors, round: 0, scores: {}, survived: {}, started: room.players.length };
    startRound();
  }

  function startRound() {
    if (match.started > 1 && room.players.length < 2) {
      finish();
      return;
    }
    match.round++;
    match.over = false;
    match.dropped = new Set();
    match.alive = new Set(room.players.map((p) => p.id));
    match.outOrder = [];
    match.roundStart = performance.now();
    room.players.forEach((p) => {
      if (match.scores[p.id] === undefined) {
        match.scores[p.id] = 0;
        match.survived[p.id] = 0;
      }
    });
    // spread out on the top floor
    const ids = WG.shuffle(room.players.map((p) => p.id));
    match.spawns = {};
    ids.forEach((id, k) => {
      const a = (k / ids.length) * Math.PI * 2 + Math.PI / 4;
      match.spawns[id] = [Math.round(Math.cos(a) * 32) / 10, Math.round(Math.sin(a) * 32) / 10];
    });
    room.players.forEach((p) => room.to(p.id, "hx.round", roundPayload(false)));
  }

  function roundPayload(spectate) {
    return {
      round: match.round,
      rounds: match.rounds,
      floors: match.floors,
      spawns: match.spawns,
      players: room.players
        .filter((p) => match.scores[p.id] !== undefined)
        .map((p) => ({ id: p.id, name: p.name, color: p.color, score: match.scores[p.id] })),
      dropped: [...match.dropped].map((k) => k.split(",").map(Number)),
      out: [...Object.keys(match.spawns)].filter((id) => !match.alive.has(id)),
      spectate,
    };
  }

  function hostStep(d) {
    if (!match || match.over || !Array.isArray(d)) return;
    if (performance.now() < match.roundStart + COUNTDOWN + GRACE_MS - 150) return;
    const f = d[0] | 0;
    const i = d[1] | 0;
    if (f < 0 || f >= match.floors || i < 0 || i >= CELLS.length) return;
    const key = f + "," + i;
    if (match.dropped.has(key)) return;
    match.dropped.add(key);
    room.send("hx.drop", [f, i]);
    onDrop([f, i]);
  }

  function hostOut(id) {
    if (!match || match.over || !match.alive.has(id)) return;
    match.alive.delete(id);
    match.outOrder.push(id);
    match.survived[id] = (match.survived[id] || 0) + Math.max(0, performance.now() - match.roundStart - COUNTDOWN);
    room.send("hx.dead", { id });
    onDead({ id });
    checkEnd();
  }

  function checkEnd() {
    const need = match.started > 1 ? 1 : 0;
    if (match.alive.size > need) return;
    match.over = true;
    const now = performance.now();
    // points for everybody you outlasted
    const order = [...match.alive].concat(match.outOrder.slice().reverse());
    order.forEach((id, place) => {
      if (match.scores[id] !== undefined) match.scores[id] += order.length - 1 - place;
    });
    match.alive.forEach((id) => (match.survived[id] += Math.max(0, now - match.roundStart - COUNTDOWN)));
    const winner = match.alive.size ? room.player([...match.alive][0]) : null;
    const title = winner ? winner.name + " wins the round!" : match.started > 1 ? "Round over" : "You fell!";
    const d = { title, scores: match.scores };
    room.send("hx.over", d);
    onOver(d);
    setTimeout(() => {
      if (!match) return;
      if (match.round >= match.rounds) finish();
      else startRound();
    }, 3200);
  }

  function finish() {
    const fmt = (ms) => Math.floor(ms / 60000) + ":" + String(Math.floor(ms / 1000) % 60).padStart(2, "0");
    const rows = room.players
      .filter((p) => match.scores[p.id] !== undefined)
      .sort((a, b) => match.scores[b.id] - match.scores[a.id] || match.survived[b.id] - match.survived[a.id])
      .map((p) => ({
        name: p.name,
        color: p.color,
        value: match.scores[p.id] + " pts",
        note: fmt(match.survived[p.id]) + " on the floor",
      }));
    const title = match.started > 1 && rows.length ? rows[0].name + " wins!" : "Well played!";
    match = null;
    phase = "idle";
    LOBBY.results(rows, title);
  }

  /* ---------- Everybody: rounds and the others ---------- */

  function buildFloors(n) {
    floorMeshes.forEach((m) => {
      K.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    floors = n;
    tiles = [];
    floorMeshes = [];
    moving.clear();
    const mtx = new THREE.Matrix4();
    for (let f = 0; f < n; f++) {
      const geo = new THREE.CylinderGeometry(R * 0.94, R * 0.94, TILE_H, 6);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 });
      const mesh = new THREE.InstancedMesh(geo, mat, CELLS.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const color = new THREE.Color(FLOOR_COLORS[f % FLOOR_COLORS.length]);
      CELLS.forEach((c, i) => {
        mtx.makeTranslation(c.x, floorY(f) - TILE_H / 2, c.z);
        mesh.setMatrixAt(i, mtx);
        mesh.setColorAt(i, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      K.scene.add(mesh);
      floorMeshes.push(mesh);
      tiles.push(CELLS.map(() => ({ dropAt: Infinity })));
    }
  }

  function clearPlayers() {
    if (meObj) {
      K.scene.remove(meObj);
      K3.dispose(meObj);
      meObj = null;
    }
    others.clear();
  }

  function onRound(d) {
    buildFloors(d.floors);
    const now = performance.now();
    // tiles that fell before a late arrival joined: gone at once, the next frame hides them
    d.dropped.forEach(([f, i]) => {
      if (!tiles[f] || !tiles[f][i]) return;
      tiles[f][i].dropAt = now - FALL_MS - 1;
      moving.add(f + "," + i);
    });
    clearPlayers();
    players = d.players;
    roundNo = d.round;
    roundCount = d.rounds;
    players.forEach((p) => {
      if (p.id === room.myId) return;
      const o = others.add(p);
      const s = d.spawns[p.id];
      if (s) o.obj.position.set(s[0], floorY(0), s[1]);
      o.data.out = !s || d.out.includes(p.id);
      o.obj.visible = !o.data.out;
    });
    const spawn = d.spawns[room.myId];
    spectating = !!d.spectate || !spawn;
    if (!spectating) {
      me = { x: spawn[0], y: floorY(0), z: spawn[1], vx: 0, vy: 0, vz: 0, heading: Math.atan2(-spawn[0], -spawn[1]), ground: true, coyote: 0, floor: 0, cell: -1, out: false };
      me.px = me.x;
      me.py = me.y;
      me.pz = me.z;
      const my = players.find((p) => p.id === room.myId);
      meObj = K3.character(my ? my.color : 0);
      K.scene.add(meObj);
    } else {
      me = null;
    }
    phase = spectating ? "play" : "countdown";
    if (spectating) cd.stop();
    else cd.start(COUNTDOWN);
    graceEnd = now + COUNTDOWN + GRACE_MS;
    LOBBY.hide();
    if (spectating) ARC.banner("Watching — you are in next round", 2200);
    renderHud();
  }

  function onRemote(a, from) {
    if (Array.isArray(a)) others.push(from, { x: a[0], y: a[1], z: a[2], h: a[3] }, a[4]);
  }

  function onDrop(d) {
    const [f, i] = d;
    const t = tiles[f] && tiles[f][i];
    if (!t) return;
    t.dropAt = Math.min(t.dropAt, performance.now() + DROP_MS);
    moving.add(f + "," + i);
  }

  function onDead(d) {
    const p = players.find((x) => x.id === d.id);
    const o = others.get(d.id);
    if (o) {
      o.data.out = true;
      o.obj.visible = false;
    }
    if (d.id === room.myId) {
      if (me) me.out = true;
      if (phase === "play") ARC.banner("You're out!", 1500);
    } else if (p && phase === "play") {
      WG.toast(p.name + " is out!", 1400);
    }
    renderHud();
  }

  function onOver(d) {
    phase = "over";
    players.forEach((p) => {
      if (d.scores[p.id] !== undefined) p.score = d.scores[p.id];
    });
    ARC.banner(d.title, 2800);
    renderHud();
  }

  function renderHud() {
    if (!room || phase === "idle" || !players.length) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = players.map((p) => {
      const o = others.get(p.id);
      const out = p.id === room.myId ? !me || me.out : !o || o.data.out;
      return { name: p.name, color: p.color, value: p.score, out, me: p.id === room.myId };
    });
    rows.push({ name: "Round", color: -1, value: roundNo + "/" + roundCount });
    ARC.scoreboard($("hud"), rows);
  }

  /* ---------- My character ---------- */

  function solid(f, i) {
    return i >= 0 && tiles[f] && tiles[f][i] && performance.now() < tiles[f][i].dropAt;
  }

  function stepMe(dt) {
    const now = performance.now();
    me.px = me.x;
    me.py = me.y;
    me.pz = me.z;
    const canMove = phase === "play" && !me.out;

    // "forward" is wherever the camera looks
    let tx = 0;
    let tz = 0;
    if (canMove) {
      const dir = K3.walkDir(orbit);
      tx = dir.x * SPEED;
      tz = dir.z * SPEED;
      if (dir.len) me.heading = ARC.lerpAngle(me.heading, Math.atan2(tx, tz), Math.min(1, dt * 14));
    }
    const grip = Math.min(1, dt * (me.ground ? 14 : 4));
    me.vx += (tx - me.vx) * grip;
    me.vz += (tz - me.vz) * grip;

    me.coyote = me.ground ? 0.1 : me.coyote - dt;
    if (canMove && ARC.input.hit("action") && me.coyote > 0) {
      me.vy = JUMP;
      me.coyote = 0;
      me.ground = false;
    }
    me.vy = Math.max(-40, me.vy - GRAVITY * dt);

    const oldY = me.y;
    me.x += me.vx * dt;
    me.y += me.vy * dt;
    me.z += me.vz * dt;

    // bump into the others (only I move — they push themselves out of me on their side)
    others.each((o) => {
      if (o.data.out || !o.obj.visible) return;
      const p = o.obj.position;
      if (Math.abs(me.y - p.y) > 1.3) return;
      const dx = me.x - p.x;
      const dz = me.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < BODY_R * 2 && d > 0.0001) {
        const push = BODY_R * 2 - d;
        me.x += (dx / d) * push;
        me.z += (dz / d) * push;
      }
    });

    // land on the first floor we fell onto that still has a tile here
    me.ground = false;
    if (me.vy <= 0) {
      const i = cellAt(me.x, me.z);
      for (let f = 0; f < floors; f++) {
        const top = floorY(f);
        if (oldY >= top - 0.05 && me.y <= top && solid(f, i)) {
          me.y = top;
          me.vy = 0;
          me.ground = true;
          me.floor = f;
          me.cell = i;
          break;
        }
      }
    }
    if (me.ground && now >= graceEnd && phase === "play") stepOn(me.floor, me.cell);

    if (!me.out && me.y < floorY(floors - 1) - 12) {
      me.out = true;
      if (phase === "play") room.to(room.hostId, "hx.out");
    }
  }

  // The tile starts shaking here straight away; the host tells everybody else.
  function stepOn(f, i) {
    const t = tiles[f][i];
    if (t.dropAt !== Infinity) return;
    t.dropAt = performance.now() + DROP_MS;
    moving.add(f + "," + i);
    room.to(room.hostId, "hx.step", [f, i]);
  }

  /* ---------- Loop ---------- */

  function update(dt) {
    if (!room || phase === "idle") return;
    const now = performance.now();
    if (cd.tick(now) && phase === "countdown") phase = "play";
    if (me) {
      stepMe(dt);
      if (sendDue(dt) && !me.out) {
        room.share("hx.p", [
          Math.round(me.x * 100) / 100,
          Math.round(me.y * 100) / 100,
          Math.round(me.z * 100) / 100,
          Math.round(me.heading * 100) / 100,
          Math.round(now * 10) / 10,
        ]);
      }
    }
  }

  const mtx = {};
  function animateTiles(now) {
    if (!mtx.m) {
      mtx.m = new THREE.Matrix4();
      mtx.q = new THREE.Quaternion();
      mtx.p = new THREE.Vector3();
      mtx.s = new THREE.Vector3(1, 1, 1);
      mtx.k = new THREE.Vector3();
      mtx.c = new THREE.Color();
      mtx.hot = new THREE.Color(HOT);
      mtx.e = new THREE.Euler();
    }
    moving.forEach((key) => {
      const [f, i] = key.split(",").map(Number);
      const t = tiles[f] && tiles[f][i];
      const mesh = floorMeshes[f];
      if (!t || !mesh) {
        moving.delete(key);
        return;
      }
      const c = CELLS[i];
      const left = t.dropAt - now;
      if (left > 0) {
        // shaking and warming up
        const heat = 1 - left / DROP_MS;
        const j = 0.05 * heat;
        mtx.p.set(c.x + (Math.random() - 0.5) * j, floorY(f) - TILE_H / 2, c.z + (Math.random() - 0.5) * j);
        mtx.q.identity();
        mtx.m.compose(mtx.p, mtx.q, mtx.s);
        mesh.setMatrixAt(i, mtx.m);
        mtx.c.set(FLOOR_COLORS[f % FLOOR_COLORS.length]).lerp(mtx.hot, Math.min(1, heat * 1.2));
        mesh.setColorAt(i, mtx.c);
        mesh.instanceColor.needsUpdate = true;
      } else if (-left < FALL_MS) {
        const s = -left / 1000;
        mtx.p.set(c.x, floorY(f) - TILE_H / 2 - 14 * s * s, c.z);
        mtx.e.set(s * 2.2, 0, s * 1.4);
        mtx.q.setFromEuler(mtx.e);
        const k = 1 - (-left / FALL_MS) * 0.6;
        mtx.m.compose(mtx.p, mtx.q, mtx.k.set(k, k, k));
        mesh.setMatrixAt(i, mtx.m);
      } else {
        mtx.m.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, mtx.m);
        moving.delete(key);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  let lastDraw = 0;
  const focus = { v: null, off: null, on: false };
  function draw(alpha) {
    if (!K) return;
    const now = performance.now();
    const dt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 0.016;
    lastDraw = now;
    if (!focus.v) {
      focus.v = new THREE.Vector3();
      focus.off = new THREE.Vector3();
    }
    orbit.turn(dt);

    animateTiles(now);
    others.update();

    if (me && meObj) {
      const a = alpha || 0;
      meObj.position.set(ARC.lerp(me.px, me.x, a), ARC.lerp(me.py, me.y, a), ARC.lerp(me.pz, me.z, a));
      meObj.rotation.y = me.heading;
      meObj.visible = !me.out || meObj.position.y > floorY(floors - 1) - 30;
    }

    // follow me; when I'm out, follow somebody still in; in the lobby, circle slowly
    let target = null;
    if (me && !me.out) target = meObj.position;
    else {
      others.each((o) => {
        if (!target && !o.data.out && o.obj.visible) target = o.obj.position;
      });
    }
    if (phase === "idle" || !target) {
      const a = now / 9000;
      focus.on = false;
      focus.v.set(0, floorY(Math.floor((floors - 1) / 2)), 0);
      K.camera.position.set(Math.sin(a) * 22, 16, Math.cos(a) * 22);
      K.camera.lookAt(focus.v);
    } else {
      // the point we look at glides after the player, but drops with them at once when they fall
      if (!focus.on) focus.v.copy(target);
      focus.on = true;
      const k = 1 - Math.exp(-10 * dt);
      focus.v.x += (target.x - focus.v.x) * k;
      focus.v.z += (target.z - focus.v.z) * k;
      focus.v.y = target.y < focus.v.y ? target.y : focus.v.y + (target.y - focus.v.y) * k;
      // the mouse turns the camera round; on a lower floor it keeps under the floor above
      orbit.offset(focus.off);
      if (focus.v.y < floorY(0) - 1 && focus.off.y > CEILING) focus.off.multiplyScalar(CEILING / focus.off.y);
      K.camera.position.copy(focus.v).add(focus.off);
      K.camera.lookAt(focus.v.x, focus.v.y + 0.6, focus.v.z);
    }
    K.render();
  }
})();
