// Obstacle Course — race everybody to the end of a wobbly course: gaps, a sweeping bar, hammers,
// moving platforms, dropping tiles, a conveyor belt and a narrow beam, in a random order each round.
// Everything on the course moves by the clock since the round started, so it is the same for everybody;
// each player runs their own character, and the host keeps the finishing order and the points.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const RUN = 7.5;
  const JUMP = 9.5;
  const GRAVITY = 26;
  const STEP = 0.45; // what you can walk up without jumping
  const BODY_R = 0.4;
  const BODY_H = 1.4;
  const DIVE_SPEED = 11;
  const DIVE_COOL = 1;
  const FALL_Y = -9;
  const SAFE_MS = 1000; // untouchable after a respawn
  const GRACE_MS = 45000;
  const COUNTDOWN = 3000;
  const SEND_MS = 33;
  const KINDS = ["gaps", "sweeper", "hammers", "movers", "tiles", "belt", "beam"];
  const PASTEL = [0xf28cb1, 0x9a5bd6, 0x6ea0ff, 0xf0c419, 0x57c7a0];

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
  let raceStart = 0; // local time of "Go!", the course's clock starts then
  let raceEnds = 0;
  let firstOut = 0;
  let course = null; // { solids, sweepers, hammers, checkpoints, finishZ, group, belts }
  let me = null;
  let meObj = null;
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
    game: "obstacle",
    title: "Obstacle Course",
    blurb: "Race to the finish of a wobbly obstacle course — sweeping bars, hammers, moving platforms. 1–4 players.",
    lateNote: "A race is on — you are in from the next round.",
    settings: [
      {
        key: "rounds",
        label: "Rounds",
        value: 3,
        options: [
          { value: 1, label: "1 course" },
          { value: 3, label: "3 courses" },
          { value: 5, label: "5 courses" },
        ],
      },
    ],
    onRoom,
    onStart: (v) => ready.then(() => startMatch(v)),
    onLobby: stopAll,
  });

  /* ---------- Building the course ---------- */

  // Seconds on the course's clock.
  function clock() {
    return phase === "play" || phase === "over" ? (performance.now() - raceStart) / 1000 : 0;
  }

  function buildCourse(seed) {
    if (course && course.group) {
      K.scene.remove(course.group);
      K3.dispose(course.group);
    }
    const rand = WG.rng(seed);
    const c = { solids: [], sweepers: [], hammers: [], checkpoints: [], group: new THREE.Group(), belts: [] };
    K.scene.add(c.group);
    const mats = {};
    const mat = (color) => (mats[color] = mats[color] || new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
    let colorAt = Math.floor(rand() * PASTEL.length);
    const nextColor = () => PASTEL[colorAt++ % PASTEL.length];

    // a solid box; x/y/z are its centre, w/h/d its size
    function box(x, y, z, w, h, d, color, extra) {
      const s = Object.assign({ x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2, z0: z - d / 2, z1: z + d / 2, ox: 0, oz: 0 }, extra);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      c.group.add(mesh);
      s.mesh = mesh;
      s.home = { x, z };
      c.solids.push(s);
      return s;
    }
    // a floor slab whose top is at `top`
    const floor = (x, z, w, d, top, color) => box(x, top - 0.5, z, w, 1, d, color);

    const builders = {
      start(z0) {
        floor(0, z0 - 5, 10, 10, 0, 0xdde3ee);
        return 10;
      },
      gaps(z0) {
        const col = nextColor();
        const tops = [0, 0.5, 1, 0.3];
        let z = z0;
        tops.forEach((top, i) => {
          const len = i === 0 ? 4 : 3.4;
          floor(0, z - len / 2, 8, len, top, col);
          z -= len + (i < tops.length - 1 ? 2.4 + rand() * 0.6 : 0);
        });
        return z0 - z;
      },
      sweeper(z0) {
        floor(0, z0 - 8, 10, 16, 0, nextColor());
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 9, 12), mat(0xe05c4a));
        arm.rotation.z = Math.PI / 2;
        const pivot = new THREE.Group();
        pivot.position.set(0, 0.6, z0 - 8);
        pivot.add(arm);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.2, 16), mat(0xffffff));
        hub.position.set(0, 0.6, z0 - 8);
        c.group.add(pivot, hub);
        c.sweepers.push({ x: 0, z: z0 - 8, y0: 0.3, y1: 0.9, half: 4.5, speed: (rand() < 0.5 ? -1 : 1) * (1.3 + rand() * 0.4), pivot });
        box(0, 0.6, z0 - 8, 1, 1.2, 1, 0xffffff); // the hub is solid
        return 16;
      },
      hammers(z0) {
        floor(0, z0 - 9, 6, 18, 0, nextColor());
        [4, 9, 14].forEach((dz, i) => {
          const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.2, 1), mat(0xe05c4a));
          const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 5, 6), mat(0x555a66));
          rope.position.y = 3.1;
          const g = new THREE.Group();
          g.add(head, rope);
          g.position.set(0, 0.8, z0 - dz);
          c.group.add(g);
          c.hammers.push({ z: z0 - dz, y0: 0.2, y1: 1.4, amp: 3.6, speed: 1.7 + rand() * 0.4, phase: i * 2.1 + rand(), g });
        });
        const beamSide = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 14), mat(0x555a66));
        beamSide.position.set(0, 5.8, z0 - 9);
        c.group.add(beamSide);
        return 18;
      },
      movers(z0) {
        const col = nextColor();
        floor(0, z0 - 1.25, 8, 2.5, 0, col);
        [5.5, 10.5, 15.5].forEach((dz, i) => {
          const s = floor(0, z0 - dz, 3.2, 3.2, 0, 0xffffff);
          s.move = { ax: 3, speed: 1.1 + rand() * 0.3, phase: i * 2 + rand() };
        });
        floor(0, z0 - 19.75, 8, 2.5, 0, col);
        return 21;
      },
      tiles(z0) {
        floor(0, z0 - 1, 10, 2, 0, 0xdde3ee);
        const col = nextColor();
        for (let r = 0; r < 5; r++) {
          for (let k = 0; k < 5; k++) {
            const s = floor(-4 + k * 2, z0 - 3 - r * 2, 1.9, 1.9, 0, col);
            s.tile = { phase: rand(), normal: s.mesh.material };
          }
        }
        floor(0, z0 - 13, 10, 2, 0, 0xdde3ee);
        return 14;
      },
      belt(z0) {
        const s = floor(0, z0 - 8, 8, 16, 0, 0x555a66);
        s.belt = 3.5; // pushes you back towards the start
        const stripes = new THREE.Group();
        for (let k = 0; k < 16; k++) {
          const st = new THREE.Mesh(new THREE.BoxGeometry(8, 0.02, 0.35), mat(0xf0c419));
          st.position.set(0, 0.011, z0 - k);
          stripes.add(st);
        }
        c.group.add(stripes);
        c.belts.push({ stripes, z0, z1: z0 - 16 });
        for (let k = 0; k < 3; k++) box(-2.5 + rand() * 5, 0.5, z0 - 3 - k * 4.5, 1.4, 1, 1.4, 0xe05c4a);
        return 16;
      },
      beam(z0) {
        const col = nextColor();
        floor(0, z0 - 1.25, 8, 2.5, 0, col);
        floor(0, z0 - 8, 1.1, 11, 0, 0xffffff);
        floor(0, z0 - 14.75, 8, 2.5, 0, col);
        return 16;
      },
      finish(z0) {
        floor(0, z0 - 6, 12, 12, 0, 0xf0c419);
        const arch = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.35, 10, 30, Math.PI), mat(0xe05c4a));
        arch.position.set(0, 0, z0 - 2);
        c.group.add(arch);
        c.finishZ = z0 - 2;
        return 12;
      },
    };

    const order = ["start"].concat(WG.shuffle(KINDS, rand).slice(0, 6), ["finish"]);
    let z = 0;
    order.forEach((kind) => {
      c.checkpoints.push(z);
      z -= builders[kind](z);
    });
    course = c;

    // water far below, to fall into
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x5aa9e6, roughness: 1 }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, FALL_Y - 4, -60);
    c.group.add(sea);
    K.sun.position.set(12, 30, -40);
    K.sun.target.position.set(0, 0, -60);
  }

  // Moves everything that moves to where it is at time t.
  function moveCourse(t) {
    course.solids.forEach((s) => {
      if (s.move) {
        s.ox = s.move.ax * Math.sin(t * s.move.speed + s.move.phase);
        s.mesh.position.x = s.home.x + s.ox;
      }
      if (s.tile) {
        // up for most of every four seconds; red and shaking just before it drops
        const k = (t / 4 + s.tile.phase) % 1;
        s.gone = k >= 0.75;
        s.mesh.visible = !s.gone;
        const warn = k >= 0.58 && !s.gone;
        s.mesh.material = warn ? warnMat() : s.tile.normal;
        s.mesh.position.x = s.home.x + (warn ? (Math.random() - 0.5) * 0.06 : 0);
      }
    });
    course.sweepers.forEach((w) => (w.pivot.rotation.y = t * w.speed));
    course.hammers.forEach((h) => (h.g.position.x = h.amp * Math.sin(t * h.speed + h.phase)));
    course.belts.forEach((b) => {
      b.stripes.children.forEach((st, k) => {
        st.position.z = b.z0 - ((k + t * 3.5) % 16);
      });
    });
  }

  let warn = null;
  function warnMat() {
    return (warn = warn || new THREE.MeshStandardMaterial({ color: 0xe05c4a, roughness: 0.6 }));
  }

  function solidNow(s) {
    return !s.gone;
  }

  /* ---------- Setup ---------- */

  function setup() {
    K = K3.stage($("game"), { sky: { light: 0x9fd4ff, dark: 0x1a2236 }, fog: [45, 130], shadowBox: 30, far: 500 });
    orbit = K3.orbit($("game"), { yaw: 0, pitch: 0.42, dist: 9, minPitch: 0.05, maxPitch: 1.35, minDist: 4, maxDist: 22, onClick: () => dive() });
    others = K3.crowd(K.scene);
    buildCourse(1);
    const loop = ARC.loop(update, draw);
    loop.start();
  }

  function onRoom(r) {
    room = r;
    room.on("ob.round", when(onRound));
    room.on("ob.p", when(onRemote));
    room.on("ob.state", when(onState));
    room.on("ob.over", when(onOver));
    room.on("players", when(() => {
      others.keep((id) => !!room.player(id));
      renderHud();
    }));
    if (room.isHost) {
      room.on("ob.fin", when((d, from) => hostFinish(from)));
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
    match = { rounds: v.rounds, round: 0, scores: {} };
    room.players.forEach((p) => (match.scores[p.id] = 0));
    startRound();
  }

  function startRound() {
    match.round++;
    match.seed = (Math.random() * 1e9) | 0;
    match.finished = [];
    match.firstOut = 0;
    match.over = false;
    match.racers = room.players.map((p) => p.id);
    match.racers.forEach((id) => (match.scores[id] = match.scores[id] || 0));
    match.limitAt = performance.now() + COUNTDOWN + 180000;
    const d = {
      seed: match.seed,
      round: match.round,
      rounds: match.rounds,
      limitIn: match.limitAt - performance.now(),
      scores: match.scores,
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    };
    room.send("ob.round", d);
    onRound(d);
  }

  function hostFinish(id) {
    if (!match || match.over || match.finished.includes(id) || !match.racers.includes(id)) return;
    match.finished.push(id);
    if (!match.firstOut) match.firstOut = performance.now();
    const d = { finished: match.finished, endsIn: Math.max(0, Math.min(match.firstOut + GRACE_MS, match.limitAt) - performance.now()) };
    room.send("ob.state", d);
    onState(d);
    hostCheck();
  }

  function hostCheck() {
    if (!match || match.over) return;
    const racing = match.racers.filter((id) => room.player(id));
    const everyone = racing.every((id) => match.finished.includes(id));
    const now = performance.now();
    const late = (match.firstOut && now > match.firstOut + GRACE_MS) || now > match.limitAt;
    if (!everyone && !late) return;
    match.over = true;
    const points = [3, 2, 1, 0];
    match.finished.forEach((id, i) => (match.scores[id] = (match.scores[id] || 0) + (points[i] || 0)));
    const first = match.finished.length ? room.player(match.finished[0]) : null;
    const d = { title: first ? first.name + " qualified first!" : "Nobody made it!", scores: match.scores };
    room.send("ob.over", d);
    onOver(d);
    setTimeout(() => {
      if (!match) return;
      if (match.round >= match.rounds) finish();
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

  function onRound(d) {
    buildCourse(d.seed);
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
    firstOut = 0;
    raceEnds = performance.now() + d.limitIn;
    const startX = (k) => -3 + k * 2;
    players.forEach((p, k) => {
      if (p.id === room.myId) return;
      const o = others.add(p);
      o.obj.position.set(startX(k), 0, -4);
      o.obj.rotation.y = Math.PI;
    });
    const k = players.findIndex((p) => p.id === room.myId);
    if (k >= 0) {
      me = { x: startX(k), y: 0, z: -4, vx: 0, vy: 0, vz: 0, h: Math.PI, ground: null, dive: 0, diveCool: 0, stun: 0, safeUntil: 0, check: 0, out: false };
      me.px = me.x;
      me.py = me.y;
      me.pz = me.z;
      meObj = K3.character(players[k].color);
      K.scene.add(meObj);
    } else {
      me = null;
    }
    orbit.yaw = 0; // behind, looking down the course (-z)
    phase = "countdown";
    cd.start(COUNTDOWN);
    moveCourse(0);
    LOBBY.hide();
    ARC.banner("Course " + d.round + " of " + d.rounds, 1200);
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
      if (!firstOut) firstOut = performance.now();
      const p = players.find((x) => x.id === id);
      if (id !== room.myId && p) WG.toast(p.name + " qualified! (#" + finished.length + ")", 1600);
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
    rows.push({ name: "Course", color: -1, value: roundNo + "/" + roundCount });
    if (me && phase === "play" && !me.out) {
      const total = -course.finishZ;
      rows.push({ name: "Done", color: -1, value: Math.round(ARC.clamp(-me.z / total, 0, 1) * 100) + "%" });
    }
    if (firstOut && phase === "play") {
      rows.push({ name: "Ends in", color: -1, value: Math.max(0, Math.ceil((raceEnds - performance.now()) / 1000)) + " s" });
    }
    ARC.scoreboard($("hud"), rows);
  }
  setInterval(() => {
    if (phase === "play") renderHud();
  }, 400);

  /* ---------- My runner ---------- */

  function dive() {
    if (!me || phase !== "play" || me.out || me.diveCool > 0 || me.stun > 0) return;
    const dir = K3.walkDir(orbit);
    const hx = dir.len ? dir.x : Math.sin(me.h);
    const hz = dir.len ? dir.z : Math.cos(me.h);
    me.h = Math.atan2(hx, hz);
    me.vx = hx * DIVE_SPEED;
    me.vz = hz * DIVE_SPEED;
    me.vy = Math.max(me.vy, 3.5);
    me.ground = null;
    me.dive = 0.5;
    me.diveCool = DIVE_COOL;
  }

  function respawn() {
    const z0 = course.checkpoints[me.check];
    Object.assign(me, { x: (Math.random() - 0.5) * 3, y: 1, z: z0 - 1.5, vx: 0, vy: 0, vz: 0, h: Math.PI, ground: null, dive: 0, stun: 0 });
    me.px = me.x;
    me.py = me.y;
    me.pz = me.z;
    me.safeUntil = performance.now() + SAFE_MS;
  }

  // Knocked by a bar or a hammer.
  function knock(dx, dz, force) {
    const len = Math.hypot(dx, dz) || 1;
    me.vx = (dx / len) * force;
    me.vz = (dz / len) * force;
    me.vy = 6;
    me.ground = null;
    me.stun = 0.55;
    me.safeUntil = performance.now() + 500;
  }

  function stepMe(dt) {
    const now = performance.now();
    const t = clock();
    me.px = me.x;
    me.py = me.y;
    me.pz = me.z;
    me.diveCool = Math.max(0, me.diveCool - dt);
    me.stun = Math.max(0, me.stun - dt);
    me.dive = Math.max(0, me.dive - dt);
    if (phase !== "play" || me.out) return;

    // ride along on whatever I stand on
    if (me.ground && solidNow(me.ground)) {
      if (me.ground.move) {
        const was = me.ground.move.ax * Math.sin((t - dt) * me.ground.move.speed + me.ground.move.phase);
        me.x += me.ground.ox - was;
      }
      if (me.ground.belt) me.z += me.ground.belt * dt;
    }

    const dir = K3.walkDir(orbit);
    if (me.stun <= 0 && me.dive <= 0) {
      const grip = Math.min(1, dt * (me.ground ? 16 : 5));
      me.vx += (dir.x * RUN - me.vx) * grip;
      me.vz += (dir.z * RUN - me.vz) * grip;
      if (dir.len) me.h = ARC.lerpAngle(me.h, Math.atan2(dir.x, dir.z), Math.min(1, dt * 14));
      if (me.ground && ARC.input.hit("action")) {
        me.vy = JUMP;
        me.ground = null;
      }
    }
    if (ARC.input.hit("dive")) dive();

    me.vy = Math.max(-35, me.vy - GRAVITY * dt);
    const oldY = me.y;
    me.x += me.vx * dt;
    me.z += me.vz * dt;
    me.y += me.vy * dt;

    // sideways: walls, blocks and platform edges (small steps are simply walked up)
    for (const s of course.solids) {
      if (!solidNow(s)) continue;
      const x0 = s.x0 + s.ox;
      const x1 = s.x1 + s.ox;
      if (me.y + BODY_H <= s.y0 || me.y >= s.y1 - STEP) continue;
      const cx = ARC.clamp(me.x, x0, x1);
      const cz = ARC.clamp(me.z, s.z0, s.z1);
      const dx = me.x - cx;
      const dz = me.z - cz;
      const d = Math.hypot(dx, dz);
      if (d >= BODY_R) continue;
      if (d > 1e-4) {
        me.x = cx + (dx / d) * BODY_R;
        me.z = cz + (dz / d) * BODY_R;
      } else {
        const pen = [me.x - x0, x1 - me.x, me.z - s.z0, s.z1 - me.z];
        const k = pen.indexOf(Math.min(...pen));
        if (k === 0) me.x = x0 - BODY_R;
        else if (k === 1) me.x = x1 + BODY_R;
        else if (k === 2) me.z = s.z0 - BODY_R;
        else me.z = s.z1 + BODY_R;
      }
    }

    // up and down: land on the highest top under my feet
    me.ground = null;
    let best = -Infinity;
    for (const s of course.solids) {
      if (!solidNow(s)) continue;
      const inside = me.x > s.x0 + s.ox - 0.25 && me.x < s.x1 + s.ox + 0.25 && me.z > s.z0 - 0.25 && me.z < s.z1 + 0.25;
      if (!inside) continue;
      if (me.vy <= 0 && oldY >= s.y1 - STEP && me.y <= s.y1 && s.y1 > best) {
        best = s.y1;
        me.ground = s;
      } else if (me.vy > 0 && oldY + BODY_H <= s.y0 && me.y + BODY_H > s.y0) {
        me.y = s.y0 - BODY_H;
        me.vy = 0;
      }
    }
    if (me.ground) {
      me.y = best;
      me.vy = 0;
    }

    // the sweeping bars and the hammers
    if (now >= me.safeUntil) {
      for (const w of course.sweepers) {
        if (me.y > w.y1 || me.y + BODY_H < w.y0) continue;
        const a = t * w.speed;
        const ux = Math.cos(a);
        const uz = -Math.sin(a);
        const along = ARC.clamp((me.x - w.x) * ux + (me.z - w.z) * uz, -w.half, w.half);
        const px = w.x + ux * along;
        const pz = w.z + uz * along;
        if (Math.hypot(me.x - px, me.z - pz) < BODY_R + 0.25 && Math.abs(along) > 0.6) {
          // pushed the way the bar is moving where it hit
          knock(uz * w.speed * along, -ux * w.speed * along, 11);
          break;
        }
      }
      for (const h of course.hammers) {
        if (me.y > h.y1 || me.y + BODY_H < h.y0 || Math.abs(me.z - h.z) > 0.5 + BODY_R) continue;
        const hx = h.amp * Math.sin(t * h.speed + h.phase);
        if (Math.abs(me.x - hx) < 0.75 + BODY_R) {
          const swing = Math.cos(t * h.speed + h.phase);
          knock(swing >= 0 ? 1 : -1, 0.15, 12);
          break;
        }
      }
    }

    // bump the others
    others.each((o) => {
      const p = o.obj.position;
      if (Math.abs(me.y - p.y) > 1.2) return;
      const dx = me.x - p.x;
      const dz = me.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < BODY_R * 2 && d > 1e-4) {
        me.x += (dx / d) * (BODY_R * 2 - d);
        me.z += (dz / d) * (BODY_R * 2 - d);
      }
    });

    // checkpoints: the start of every stretch I have reached
    while (me.check + 1 < course.checkpoints.length && me.z < course.checkpoints[me.check + 1] - 1) me.check++;
    if (me.y < FALL_Y) respawn();

    if (me.z < course.finishZ && me.ground) {
      me.out = true;
      const secs = (now - raceStart) / 1000;
      ARC.banner("Qualified! " + secs.toFixed(1) + " s", 2200);
      room.to(room.hostId, "ob.fin", { t: secs });
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
    if (phase === "play" || phase === "over") moveCourse(clock());
    if (me) {
      stepMe(dt);
      if (sendDue(dt)) {
        const flags = (me.dive > 0 ? 1 : 0) | (me.stun > 0 ? 2 : 0) | (me.out ? 4 : 0);
        room.share("ob.p", [
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

  let lastDraw = 0;
  const cam = { v: null, off: null, on: false };
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
    others.each((o) => (o.obj.rotation.x = (o.data.flags || 0) & 1 ? 1.2 : 0));

    if (me && meObj) {
      const a = alpha || 0;
      meObj.position.set(ARC.lerp(me.px, me.x, a), ARC.lerp(me.py, me.y, a), ARC.lerp(me.pz, me.z, a));
      meObj.rotation.set(me.dive > 0 ? 1.2 : 0, me.h, 0, "YXZ");
      meObj.visible = now >= me.safeUntil || Math.floor(now / 120) % 2 === 0;
    }

    let target = me && meObj && !me.out ? meObj.position : null;
    if (!target) {
      others.each((o) => {
        if (!target && !((o.data.flags || 0) & 4)) target = o.obj.position;
      });
    }
    if (target && phase !== "idle") {
      // glide after the runner, but never through the course when falling
      if (!cam.on) cam.v.copy(target);
      cam.on = true;
      const k = 1 - Math.exp(-10 * dt);
      cam.v.x += (target.x - cam.v.x) * k;
      cam.v.z += (target.z - cam.v.z) * k;
      cam.v.y += (Math.max(target.y, FALL_Y + 2) - cam.v.y) * k;
      K.camera.position.copy(cam.v).add(orbit.offset(cam.off));
      K.camera.lookAt(cam.v.x, cam.v.y + 0.8, cam.v.z);
    } else {
      cam.on = false;
      const t = now / 12000;
      const mid = course ? course.finishZ / 2 : -60;
      K.camera.position.set(Math.sin(t) * 40, 30, mid + Math.cos(t) * 40);
      K.camera.lookAt(0, 0, mid);
    }
    K.render();
  }
})();
