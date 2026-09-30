// Snowball Fight — throw snowballs across a snowy arena full of forts. Three hits freeze a player.
// Everybody moves their own character and simulates every snowball the same way. Whoever gets hit
// decides it on their own screen (dodged is dodged); the host checks it and keeps the score.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const HALF = 20; // the arena runs from -20 to 20 on both axes
  const SPEED = 5.5;
  const BODY_R = 0.45;
  const HAND_Y = 1.3; // where snowballs leave the hand
  const AIM_Y = 0.8; // the height you aim at
  const BALL_R = 0.18;
  const GRAVITY = 16;
  const THROW_SPEED = 16; // across the ground
  const MAX_RANGE = 24;
  const MAX_AMMO = 5;
  const SCOOP_S = 0.4;
  const COOLDOWN_S = 0.3;
  const FREEZE_MS = 3000;
  const SAFE_MS = 1500; // untouchable after thawing
  const HITS_TO_FREEZE = 3;
  const COUNTDOWN = 3000;
  const SEND_MS = 33;
  const SPAWNS = [[-15, -15], [15, 15], [15, -15], [-15, 15]];

  let K = null;
  let orbit = null; // the mouse camera
  let room = null;
  let phase = "idle"; // idle | countdown | play | done
  const cd = K3.countdown();
  let endsAt = 0;
  let players = []; // [{ id, name, color, score }]
  let boxes = []; // forts: { x, z, hw, hd, h }
  let trees = []; // { x, z, r }
  let arena = null; // the group holding forts and trees
  let me = null; // { x, z, px, pz, heading, ammo, cool, scoop, frozenUntil, safeUntil, hits }
  let meObj = null;
  let others = null; // K3.crowd of the other players; data: { hits, flags }
  const balls = new Map(); // "owner:seq" -> { owner, x, y, z, vx, vy, vz, mesh }
  const splashes = [];
  let ballSeq = 0;
  let pointer = null; // last mouse position over the canvas
  let pointerAt = 0;
  let aimRing = null;
  const sendDue = ARC.every(SEND_MS);
  let ballGeo = null;
  let ballMat = null;

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
    game: "snowball",
    title: "Snowball Fight",
    blurb: "Hide behind the forts and pelt everybody with snowballs. Three hits freeze a player. 2–4 players.",
    minPlayers: 2,
    lateNote: "A fight is on — you jump straight in.",
    settings: [
      {
        key: "time",
        label: "Match length",
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

  function setup() {
    K = K3.stage($("game"), { sky: { light: 0xcfe3f5, dark: 0x19202e }, fog: [30, 75], shadowBox: 24 });
    K.sun.position.set(14, 30, 12);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF * 2 + 8, HALF * 2 + 8),
      new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    K.scene.add(ground);
    // snow banks around the edge
    const bankMat = new THREE.MeshStandardMaterial({ color: 0xe3ebf6, roughness: 1 });
    [
      [0, -HALF - 0.6, HALF * 2 + 2.4, 1.2],
      [0, HALF + 0.6, HALF * 2 + 2.4, 1.2],
      [-HALF - 0.6, 0, 1.2, HALF * 2],
      [HALF + 0.6, 0, 1.2, HALF * 2],
    ].forEach(([x, z, w, d]) => {
      const bank = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, d), bankMat);
      bank.position.set(x, 0.45, z);
      bank.receiveShadow = true;
      K.scene.add(bank);
    });
    aimRing = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xe05c4a, transparent: true, opacity: 0.8, depthWrite: false })
    );
    aimRing.rotation.x = -Math.PI / 2;
    aimRing.visible = false;
    K.scene.add(aimRing);
    ballGeo = new THREE.SphereGeometry(BALL_R, 12, 10);
    ballMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    others = K3.crowd(K.scene, {
      make: (p) => {
        const obj = K3.character(p.color);
        addIce(obj);
        return obj;
      },
    });
    buildArena(1);

    const canvas = $("game");
    canvas.addEventListener("pointermove", (e) => {
      pointer = { clientX: e.clientX, clientY: e.clientY };
      pointerAt = performance.now();
    });
    canvas.addEventListener("pointerleave", () => (pointer = null));
    // drag to turn the camera; a click without dragging throws where it points
    orbit = K3.orbit(canvas, {
      yaw: 0,
      pitch: 0.95,
      dist: 17,
      minPitch: 0.3,
      maxPitch: 1.4,
      minDist: 7,
      maxDist: 28,
      onClick: (e) => {
        pointer = { clientX: e.clientX, clientY: e.clientY };
        pointerAt = performance.now();
        const p = K3.pointOnPlane(pointer, canvas, K.camera, AIM_Y);
        if (p) throwAt(p.x, p.z);
      },
    });

    const loop = ARC.loop(update, draw);
    loop.start();
  }

  function onRoom(r) {
    room = r;
    room.on("sb.round", when(onRound));
    room.on("sb.p", when(onRemote));
    room.on("sb.throw", when(onThrow));
    room.on("sb.score", when(onScore));
    room.on("sb.end", when(() => {
      phase = "done";
      renderHud();
    }));
    room.on("players", when(() => {
      others.keep((id) => !!room.player(id));
      renderHud();
    }));
    if (room.isHost) {
      room.on("sb.hit", when(hostHit));
      room.on("join", when((p) => {
        if (!match) return;
        if (match.scores[p.id] === undefined) {
          match.scores[p.id] = 0;
          match.hitsDone[p.id] = 0;
          match.freezes[p.id] = 0;
          match.state[p.id] = { hits: 0, frozenUntil: 0, safeUntil: 0 };
        }
        room.to(p.id, "sb.round", roundPayload());
        room.send("sb.score", scorePayload());
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
    match = {
      seed: (Math.random() * 1e9) | 0,
      startAt: performance.now(),
      endsAt: performance.now() + COUNTDOWN + v.time * 1000,
      scores: {},
      hitsDone: {},
      freezes: {},
      state: {},
    };
    room.players.forEach((p) => {
      match.scores[p.id] = 0;
      match.hitsDone[p.id] = 0;
      match.freezes[p.id] = 0;
      match.state[p.id] = { hits: 0, frozenUntil: 0, safeUntil: 0 };
    });
    const d = roundPayload();
    room.send("sb.round", d);
    onRound(d);
  }

  function roundPayload() {
    return {
      seed: match.seed,
      endsIn: Math.max(0, match.endsAt - performance.now()),
      elapsed: performance.now() - match.startAt, // a latecomer skips the countdown
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: match.scores[p.id] || 0 })),
    };
  }

  function scorePayload(extra) {
    return Object.assign(
      {
        scores: match.scores,
        hits: Object.fromEntries(Object.entries(match.state).map(([id, s]) => [id, s.hits])),
      },
      extra || {}
    );
  }

  // The victim says they were hit; the host checks it could be true and scores it.
  function hostHit(d, victim) {
    if (!match || !d || performance.now() > match.endsAt) return;
    const by = d.by;
    const now = performance.now();
    const v = match.state[victim];
    if (!v || by === victim || match.scores[by] === undefined) return;
    if (now < v.frozenUntil || now < v.safeUntil) return;
    v.hits++;
    match.scores[by] += 1;
    match.hitsDone[by]++;
    let frozen = false;
    if (v.hits >= HITS_TO_FREEZE) {
      frozen = true;
      v.hits = 0;
      v.frozenUntil = now + FREEZE_MS;
      v.safeUntil = now + FREEZE_MS + SAFE_MS;
      match.scores[by] += 2;
      match.freezes[by]++;
    }
    const out = scorePayload({ victim, by, ball: d.ball, frozen });
    room.send("sb.score", out);
    onScore(out);
  }

  function hostTick() {
    if (!match || performance.now() < match.endsAt) return;
    const rows = room.players
      .filter((p) => match.scores[p.id] !== undefined)
      .sort((a, b) => match.scores[b.id] - match.scores[a.id])
      .map((p) => ({
        name: p.name,
        color: p.color,
        value: match.scores[p.id] + " pts",
        note: match.hitsDone[p.id] + " hits · " + match.freezes[p.id] + (match.freezes[p.id] === 1 ? " freeze" : " freezes"),
      }));
    match = null;
    room.send("sb.end");
    phase = "done";
    LOBBY.results(rows, rows.length ? rows[0].name + " wins!" : "Game over");
  }

  /* ---------- The arena ---------- */

  function buildArena(seed) {
    if (arena) {
      K.scene.remove(arena);
      K3.dispose(arena);
    }
    arena = new THREE.Group();
    K.scene.add(arena);
    const rand = WG.rng(seed);
    boxes = [];
    trees = [];
    const roomFor = (x, z, r) =>
      SPAWNS.every(([sx, sz]) => Math.hypot(x - sx, z - sz) > r + 3.5) &&
      boxes.every((b) => Math.abs(x - b.x) > b.hw + r + 1.8 || Math.abs(z - b.z) > b.hd + r + 1.8) &&
      trees.every((t) => Math.hypot(x - t.x, z - t.z) > t.r + r + 1.8);
    let tries = 0;
    while (boxes.length < 11 && tries++ < 400) {
      const long = 2.5 + rand() * 3.5;
      const across = rand() < 0.5;
      const x = -16 + rand() * 32;
      const z = -16 + rand() * 32;
      const hw = across ? long / 2 : 0.45;
      const hd = across ? 0.45 : long / 2;
      if (!roomFor(x, z, Math.max(hw, hd))) continue;
      boxes.push({ x, z, hw, hd, h: 1.1 + rand() * 0.4 });
    }
    while (trees.length < 7 && tries++ < 900) {
      const x = -17 + rand() * 34;
      const z = -17 + rand() * 34;
      if (!roomFor(x, z, 0.55)) continue;
      trees.push({ x, z, r: 0.55 });
    }

    const fortMat = new THREE.MeshStandardMaterial({ color: 0xdde7f3, roughness: 0.95 });
    boxes.forEach((b) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.hw * 2, b.h, b.hd * 2), fortMat);
      m.position.set(b.x, b.h / 2, b.z);
      m.castShadow = true;
      m.receiveShadow = true;
      arena.add(m);
    });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f6b3f, roughness: 0.9 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    trees.forEach((t) => {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 1, 8), trunkMat);
      trunk.position.y = 0.5;
      const low = new THREE.Mesh(new THREE.ConeGeometry(1.2, 1.8, 10), leafMat);
      low.position.y = 1.8;
      const high = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.4, 10), leafMat);
      high.position.y = 2.8;
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.6, 10), capMat);
      cap.position.y = 3.5;
      [trunk, low, high, cap].forEach((m) => {
        m.castShadow = true;
        g.add(m);
      });
      g.position.set(t.x, 0, t.z);
      arena.add(g);
    });
  }

  // Keeps a circle out of the forts, trees and banks.
  function pushOut(p, r) {
    boxes.forEach((b) => {
      const cx = ARC.clamp(p.x, b.x - b.hw, b.x + b.hw);
      const cz = ARC.clamp(p.z, b.z - b.hd, b.z + b.hd);
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d = Math.hypot(dx, dz);
      if (d >= r) return;
      if (d > 1e-4) {
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
      } else if (b.hw - Math.abs(p.x - b.x) < b.hd - Math.abs(p.z - b.z)) {
        p.x = b.x + Math.sign(p.x - b.x || 1) * (b.hw + r);
      } else {
        p.z = b.z + Math.sign(p.z - b.z || 1) * (b.hd + r);
      }
    });
    trees.forEach((t) => {
      const dx = p.x - t.x;
      const dz = p.z - t.z;
      const d = Math.hypot(dx, dz);
      if (d < t.r + r && d > 1e-4) {
        p.x = t.x + (dx / d) * (t.r + r);
        p.z = t.z + (dz / d) * (t.r + r);
      }
    });
    p.x = ARC.clamp(p.x, -HALF + r, HALF - r);
    p.z = ARC.clamp(p.z, -HALF + r, HALF - r);
  }

  function blocked(x, y, z) {
    if (y <= 0 || Math.abs(x) > HALF + 1 || Math.abs(z) > HALF + 1) return true;
    for (const b of boxes) {
      if (Math.abs(x - b.x) < b.hw + BALL_R && Math.abs(z - b.z) < b.hd + BALL_R && y < b.h + BALL_R) return true;
    }
    for (const t of trees) {
      if (y < 3.6 && Math.hypot(x - t.x, z - t.z) < t.r + BALL_R + (y > 1.1 ? 0.5 : 0)) return true;
    }
    return false;
  }

  /* ---------- Everybody: the match ---------- */

  function spawnFor(id) {
    const order = players.map((p) => p.id).sort();
    const k = Math.max(0, order.indexOf(id));
    return SPAWNS[k % SPAWNS.length];
  }

  function makeOther(p) {
    const o = others.add(p);
    o.data = { hits: 0, flags: 0 };
    const s = spawnFor(p.id);
    o.obj.position.set(s[0], 0, s[1]);
    return o;
  }

  // the name tag shows the hits taken: "Anna ●●"
  function setTag(id, hits) {
    const o = others.get(id);
    if (o) others.tag(id, o.p.name + (hits ? " " + "●".repeat(hits) : ""));
  }

  let iceGeo = null;
  let iceMat = null;
  function addIce(obj) {
    if (!iceGeo) {
      iceGeo = new THREE.BoxGeometry(1.15, 1.75, 1.15);
      iceMat = new THREE.MeshStandardMaterial({ color: 0xa8d8ff, transparent: true, opacity: 0.55, roughness: 0.1 });
    }
    const ice = new THREE.Mesh(iceGeo, iceMat);
    ice.position.y = 0.85;
    ice.visible = false;
    obj.add(ice);
    obj.userData.ice = ice;
  }

  function clearPeople() {
    if (meObj) {
      K.scene.remove(meObj);
      K3.dispose(meObj);
      meObj = null;
    }
    others.clear();
    balls.forEach((b) => K.scene.remove(b.mesh));
    balls.clear();
  }

  function onRound(d) {
    buildArena(d.seed);
    clearPeople();
    players = d.players;
    const now = performance.now();
    endsAt = now + d.endsIn;
    players.forEach((p) => {
      if (p.id !== room.myId) makeOther(p);
    });
    const s = spawnFor(room.myId);
    const my = players.find((p) => p.id === room.myId);
    me = {
      x: s[0],
      z: s[1],
      px: s[0],
      pz: s[1],
      heading: Math.atan2(-s[0], -s[1]),
      ammo: MAX_AMMO,
      cool: 0,
      scoop: 0,
      scooping: false,
      frozenUntil: 0,
      safeUntil: 0,
      hits: 0,
    };
    meObj = K3.character(my ? my.color : 0);
    addIce(meObj);
    K.scene.add(meObj);
    const elapsed = d.elapsed || 0;
    phase = elapsed < COUNTDOWN ? "countdown" : "play";
    if (phase === "countdown") cd.start(COUNTDOWN - elapsed);
    else cd.stop();
    LOBBY.hide();
    renderHud();
  }

  function onRemote(a, from) {
    if (!Array.isArray(a) || phase === "idle") return;
    let o = others.get(from);
    if (!o) {
      // somebody who joined after the fight started
      const p = room.player(from);
      if (!p) return;
      if (!players.some((x) => x.id === from)) players.push({ id: p.id, name: p.name, color: p.color, score: 0 });
      o = makeOther(p);
      renderHud();
    }
    others.push(from, { x: a[0], z: a[1], h: a[2] }, a[4]);
    o.data.flags = a[3];
  }

  function onThrow(d, from) {
    if (!d || from === room.myId) return;
    spawnBall(from + ":" + d.id, from, d);
  }

  function spawnBall(key, owner, d) {
    const mesh = new THREE.Mesh(ballGeo, ballMat);
    mesh.castShadow = true;
    mesh.position.set(d.x, d.y, d.z);
    K.scene.add(mesh);
    balls.set(key, { owner, x: d.x, y: d.y, z: d.z, vx: d.vx, vy: d.vy, vz: d.vz, mesh, px: d.x, py: d.y, pz: d.z });
  }

  function removeBall(key, splash) {
    const b = balls.get(key);
    if (!b) return;
    K.scene.remove(b.mesh);
    balls.delete(key);
    if (splash) addSplash(b.x, Math.max(0.1, b.y), b.z);
  }

  function addSplash(x, y, z) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
    );
    mesh.position.set(x, y, z);
    K.scene.add(mesh);
    splashes.push({ mesh, t0: performance.now() });
  }

  function onScore(d) {
    players.forEach((p) => {
      if (d.scores[p.id] !== undefined) p.score = d.scores[p.id];
    });
    Object.entries(d.hits || {}).forEach(([id, h]) => {
      const o = others.get(id);
      if (o && o.data.hits !== h) {
        o.data.hits = h;
        setTag(id, h);
      }
      if (id === room.myId && me) me.hits = h;
    });
    if (d.victim) {
      if (d.ball && balls.has(d.by + ":" + d.ball)) removeBall(d.by + ":" + d.ball, true);
      const victim = players.find((p) => p.id === d.victim);
      const by = players.find((p) => p.id === d.by);
      if (d.victim === room.myId && me) {
        if (d.frozen) {
          me.frozenUntil = performance.now() + FREEZE_MS;
          me.safeUntil = me.frozenUntil + SAFE_MS;
          ARC.banner("Frozen!", 1200);
        }
      } else if (d.by === room.myId && victim) {
        WG.toast(d.frozen ? "You froze " + victim.name + "! +3" : "Hit " + victim.name + "! +1", 1100);
      } else if (d.frozen && victim && by) {
        WG.toast(by.name + " froze " + victim.name, 1200);
      }
    }
    renderHud();
  }

  function renderHud() {
    if (!room || phase === "idle" || !players.length) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = players.map((p) => ({ name: p.name, color: p.color, value: p.score, me: p.id === room.myId }));
    const left = Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));
    rows.push({ name: "Time", color: -1, value: Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") });
    if (me) rows.push({ name: "Snowballs", color: -1, value: "●".repeat(me.ammo) + "○".repeat(MAX_AMMO - me.ammo) });
    ARC.scoreboard($("hud"), rows);
  }
  setInterval(() => {
    if (phase === "play" || phase === "countdown") renderHud();
  }, 500);

  /* ---------- Me ---------- */

  function aimPoint() {
    if (!pointer || !K) return null;
    return K3.pointOnPlane(pointer, $("game"), K.camera, AIM_Y);
  }

  function throwAt(tx, tz) {
    if (!me || phase !== "play") return;
    const now = performance.now();
    if (now < me.frozenUntil || me.cool > 0) return;
    if (me.ammo <= 0) {
      WG.toast("Out of snowballs — hold R to scoop!", 1200);
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
    dist = ARC.clamp(dist, 1.5, MAX_RANGE);
    me.heading = Math.atan2(dx, dz);
    // aimed so it comes down at the spot you clicked
    const t = dist / THROW_SPEED;
    const start = { x: me.x + dx * 0.55, y: HAND_Y, z: me.z + dz * 0.55 };
    const d = {
      id: ++ballSeq,
      x: Math.round(start.x * 100) / 100,
      y: HAND_Y,
      z: Math.round(start.z * 100) / 100,
      vx: Math.round(dx * THROW_SPEED * 100) / 100,
      vy: Math.round(((AIM_Y - HAND_Y) / t + 0.5 * GRAVITY * t) * 100) / 100,
      vz: Math.round(dz * THROW_SPEED * 100) / 100,
    };
    me.ammo--;
    me.cool = COOLDOWN_S;
    spawnBall(room.myId + ":" + d.id, room.myId, d);
    room.share("sb.throw", d);
    renderHud();
  }

  function stepMe(dt) {
    const now = performance.now();
    me.px = me.x;
    me.pz = me.z;
    me.cool = Math.max(0, me.cool - dt);
    me.scooping = false;
    if (phase !== "play" || now < me.frozenUntil) return;

    // "forward" is wherever the camera looks
    const dir = K3.walkDir(orbit);
    const tx = dir.x;
    const tz = dir.z;
    const len = dir.len;
    me.x += tx * SPEED * dt;
    me.z += tz * SPEED * dt;
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

    // face the mouse while it is in use, otherwise the way I walk
    const aim = now - pointerAt < 2500 ? aimPoint() : null;
    if (aim) me.heading = Math.atan2(aim.x - me.x, aim.z - me.z);
    else if (len) me.heading = ARC.lerpAngle(me.heading, Math.atan2(tx, tz), Math.min(1, dt * 12));

    // scoop snow: hold R, standing still
    if (ARC.input.held("reload") && !len && me.ammo < MAX_AMMO) {
      me.scooping = true;
      me.scoop += dt;
      if (me.scoop >= SCOOP_S) {
        me.scoop = 0;
        me.ammo++;
        renderHud();
      }
    } else {
      me.scoop = 0;
    }

    if (ARC.input.hit("action") || ARC.input.hit("attack")) {
      throwAt(me.x + Math.sin(me.heading) * 10, me.z + Math.cos(me.heading) * 10);
    }
  }

  function stepBalls(dt) {
    const now = performance.now();
    balls.forEach((b, key) => {
      b.px = b.x;
      b.py = b.y;
      b.pz = b.z;
      b.vy -= GRAVITY * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      if (blocked(b.x, b.y, b.z)) {
        removeBall(key, true);
        return;
      }
      // only the player being hit decides it
      if (me && b.owner !== room.myId && phase === "play" && now >= me.safeUntil && now >= me.frozenUntil) {
        if (Math.hypot(b.x - me.x, b.z - me.z) < BODY_R + BALL_R + 0.05 && b.y < 1.7) {
          const seq = key.split(":").pop();
          room.to(room.hostId, "sb.hit", { by: b.owner, ball: Number(seq) });
          removeBall(key, true);
        }
      }
    });
  }

  /* ---------- Loop ---------- */

  function update(dt) {
    if (!room || phase === "idle") return;
    const now = performance.now();
    if (cd.tick(now) && phase === "countdown") phase = "play";
    stepBalls(dt);
    if (me) {
      stepMe(dt);
      if (sendDue(dt)) {
        let flags = 0;
        if (now < me.frozenUntil) flags |= 1;
        else if (now < me.safeUntil) flags |= 2;
        if (me.scooping) flags |= 4;
        room.share("sb.p", [Math.round(me.x * 100) / 100, Math.round(me.z * 100) / 100, Math.round(me.heading * 100) / 100, flags, Math.round(now * 10) / 10]);
      }
    }
    if (room.isHost) hostTick();
  }

  function showState(obj, flags, now) {
    obj.userData.ice.visible = !!(flags & 1);
    obj.visible = !(flags & 2) || Math.floor(now / 120) % 2 === 0;
    obj.scale.y = flags & 4 ? 0.82 : 1;
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
    const a = alpha || 0;

    others.update();
    others.each((o) => showState(o.obj, o.data.flags, now));
    balls.forEach((b) => b.mesh.position.set(ARC.lerp(b.px, b.x, a), ARC.lerp(b.py, b.y, a), ARC.lerp(b.pz, b.z, a)));
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i];
      const t = (now - s.t0) / 350;
      if (t >= 1) {
        K.scene.remove(s.mesh);
        K3.dispose(s.mesh);
        splashes.splice(i, 1);
        continue;
      }
      s.mesh.scale.setScalar(1 + t * 2.5);
      s.mesh.material.opacity = 0.9 * (1 - t);
    }

    if (me && meObj) {
      meObj.position.set(ARC.lerp(me.px, me.x, a), 0, ARC.lerp(me.pz, me.z, a));
      meObj.rotation.y = me.heading;
      let flags = 0;
      if (now < me.frozenUntil) flags |= 1;
      else if (now < me.safeUntil) flags |= 2;
      if (me.scooping) flags |= 4;
      showState(meObj, flags, now);
    }

    const aim = phase === "play" && me && !orbit.dragging ? aimPoint() : null;
    aimRing.visible = !!aim;
    if (aim) {
      const dx = aim.x - me.x;
      const dz = aim.z - me.z;
      const d = Math.hypot(dx, dz);
      const k = d > MAX_RANGE ? MAX_RANGE / d : 1;
      aimRing.position.set(me.x + dx * k, 0.03, me.z + dz * k);
    }

    if (me && meObj && phase !== "idle") {
      // my character already moves smoothly, so the camera sits right on it and turns with the mouse
      cam.v.copy(meObj.position);
      K.camera.position.copy(cam.v).add(orbit.offset(cam.off));
      K.camera.lookAt(cam.v.x, cam.v.y + 0.6, cam.v.z);
    } else {
      const t = now / 12000;
      K.camera.position.set(Math.sin(t) * 30, 20, Math.cos(t) * 30);
      K.camera.lookAt(0, 0, 0);
    }
    K.render();
  }
})();
