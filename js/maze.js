// Maze Race — everybody races through the same hedge maze to the exit; a new, bigger maze each round.
// Everybody moves their own character; the maze comes from the host's seed, so it is the same for all.
// The host keeps the finishing order and the points.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CELL = 3; // one maze square, in world units
  const WALL_T = 0.5;
  const WALL_H = 2.6;
  const SPEED = 6.4;
  const BODY_R = 0.4;
  const EYE = 1.35;
  const GRACE_MS = 45000; // after the first one is out
  const COUNTDOWN = 3000;
  const SEND_MS = 33;
  const CRUMB_EVERY = 0.9;
  const MAX_CRUMBS = 3000;
  const SIZES = { 1: [15], 3: [11, 15, 19], 5: [11, 13, 15, 17, 19] };
  const N = 1;
  const E = 2;
  const S = 4;
  const W = 8;

  let K = null;
  let orbit = null;
  let others = null;
  let room = null;
  let phase = "idle"; // idle | countdown | play | done | over
  const cd = K3.countdown();
  let players = [];
  let scores = {};
  let finished = []; // ids, in order
  let size = 11;
  let roundNo = 0;
  let roundCount = 3;
  let raceStart = 0;
  let raceEnds = 0;
  let firstOut = 0;
  let open = null; // per square: which sides are open (N E S W bits)
  let cellWalls = []; // per square: the wall boxes around it { x0, x1, z0, z1 }
  let mazeGroup = null;
  let wallMesh = null;
  let crumbs = null;
  let crumbCount = 0;
  let firstPerson = false;
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
    game: "maze",
    title: "Maze Race",
    blurb: "Race through a hedge maze to the exit — a new, bigger maze every round. 1–4 players.",
    lateNote: "A maze is being raced — you are in from the next round.",
    settings: [
      {
        key: "rounds",
        label: "Rounds",
        value: 3,
        options: [
          { value: 1, label: "1 maze" },
          { value: 3, label: "3 mazes" },
          { value: 5, label: "5 mazes" },
        ],
      },
    ],
    onRoom,
    onStart: (v) => ready.then(() => startMatch(v)),
    onLobby: stopAll,
  });

  /* ---------- Setup ---------- */

  function setup() {
    K = K3.stage($("game"), { sky: { light: 0xbfe0ff, dark: 0x121827 }, fog: [18, 60], shadowBox: 34, fov: 62 });
    // kept low, so even zoomed right out the camera stays under the top of the hedges
    orbit = K3.orbit($("game"), { yaw: Math.PI, pitch: 0.12, dist: 4.5, minPitch: -0.15, maxPitch: 0.17, minDist: 2, maxDist: 7 });
    others = K3.crowd(K.scene);
    const loop = ARC.loop(update, draw);
    loop.start();
    buildMaze(1, 11);
  }

  function onRoom(r) {
    room = r;
    room.on("mz.round", when(onRound));
    room.on("mz.p", when(onRemote));
    room.on("mz.state", when(onState));
    room.on("mz.over", when(onOver));
    room.on("players", when(() => {
      others.keep((id) => !!room.player(id));
      renderHud();
    }));
    if (room.isHost) {
      room.on("mz.fin", when((d, from) => hostFinish(from)));
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

  /* ---------- The maze ---------- */

  // A maze with one path everywhere (a random walk that backs up when stuck), plus a few extra gaps
  // so there is more than one way through.
  function makeMaze(n, rand) {
    const o = new Uint8Array(n * n);
    const seen = new Uint8Array(n * n);
    const dirs = [
      [0, -1, N, S],
      [1, 0, E, W],
      [0, 1, S, N],
      [-1, 0, W, E],
    ];
    const stack = [0];
    seen[0] = 1;
    while (stack.length) {
      const cur = stack[stack.length - 1];
      const c = cur % n;
      const r = Math.floor(cur / n);
      const ways = dirs.filter(([dc, dr]) => {
        const nc = c + dc;
        const nr = r + dr;
        return nc >= 0 && nr >= 0 && nc < n && nr < n && !seen[nr * n + nc];
      });
      if (!ways.length) {
        stack.pop();
        continue;
      }
      const [dc, dr, bit, back] = ways[Math.floor(rand() * ways.length)];
      const next = (r + dr) * n + c + dc;
      o[cur] |= bit;
      o[next] |= back;
      seen[next] = 1;
      stack.push(next);
    }
    const extra = Math.floor(n * n * 0.06);
    for (let k = 0; k < extra; k++) {
      const c = 1 + Math.floor(rand() * (n - 2));
      const r = 1 + Math.floor(rand() * (n - 2));
      const [dc, dr, bit, back] = dirs[Math.floor(rand() * 4)];
      o[r * n + c] |= bit;
      o[(r + dr) * n + c + dc] |= back;
    }
    return o;
  }

  function buildMaze(seed, n) {
    size = n;
    open = makeMaze(n, WG.rng(seed));
    if (mazeGroup) {
      K.scene.remove(mazeGroup);
      K3.dispose(mazeGroup);
    }
    mazeGroup = new THREE.Group();
    K.scene.add(mazeGroup);
    const span = n * CELL;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(span + 8, span + 8), new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(span / 2, 0, span / 2);
    floor.receiveShadow = true;
    mazeGroup.add(floor);

    // every wall once: the north and west side of each square, plus the far edges
    const boxes = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const o = open[r * n + c];
        if (!(o & N)) boxes.push({ x0: c * CELL - WALL_T / 2, x1: (c + 1) * CELL + WALL_T / 2, z0: r * CELL - WALL_T / 2, z1: r * CELL + WALL_T / 2 });
        if (!(o & W)) boxes.push({ x0: c * CELL - WALL_T / 2, x1: c * CELL + WALL_T / 2, z0: r * CELL - WALL_T / 2, z1: (r + 1) * CELL + WALL_T / 2 });
        if (r === n - 1 && !(o & S)) boxes.push({ x0: c * CELL - WALL_T / 2, x1: (c + 1) * CELL + WALL_T / 2, z0: span - WALL_T / 2, z1: span + WALL_T / 2 });
        if (c === n - 1 && !(o & E)) boxes.push({ x0: span - WALL_T / 2, x1: span + WALL_T / 2, z0: r * CELL - WALL_T / 2, z1: (r + 1) * CELL + WALL_T / 2 });
      }
    }
    // which squares each wall touches, for quick bumping
    cellWalls = Array.from({ length: n * n }, () => []);
    boxes.forEach((b) => {
      const c0 = Math.max(0, Math.floor((b.x0 - 0.01) / CELL));
      const c1 = Math.min(n - 1, Math.floor((b.x1 + 0.01) / CELL));
      const r0 = Math.max(0, Math.floor((b.z0 - 0.01) / CELL));
      const r1 = Math.min(n - 1, Math.floor((b.z1 + 0.01) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cellWalls[r * n + c].push(b);
    });

    const hedge = new THREE.MeshStandardMaterial({ color: 0x2f6b3f, roughness: 0.95 });
    wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), hedge, boxes.length);
    const m = new THREE.Matrix4();
    const tint = new THREE.Color();
    const rand = WG.rng(seed + 7);
    boxes.forEach((b, i) => {
      m.makeScale(b.x1 - b.x0, WALL_H, b.z1 - b.z0);
      m.setPosition((b.x0 + b.x1) / 2, WALL_H / 2, (b.z0 + b.z1) / 2);
      wallMesh.setMatrixAt(i, m);
      wallMesh.setColorAt(i, tint.setHSL(0.34, 0.45, 0.36 + rand() * 0.08));
    });
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    mazeGroup.add(wallMesh);

    // the way out: a gate and a column of light that shows over the hedges
    const ex = (n - 0.5) * CELL;
    const ez = (n - 0.5) * CELL;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.7, 40, 20, 1, true),
      // no fog on it: it has to shine from the far end of the maze
      new THREE.MeshBasicMaterial({ color: 0xf0c419, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide, fog: false })
    );
    beam.position.set(ex, 20, ez);
    const pad = new THREE.Mesh(new THREE.CircleGeometry(1.1, 28), new THREE.MeshBasicMaterial({ color: 0xf0c419 }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(ex, 0.02, ez);
    mazeGroup.add(beam, pad);
    const start = new THREE.Mesh(new THREE.CircleGeometry(1.1, 28), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    start.rotation.x = -Math.PI / 2;
    start.position.set(CELL / 2, 0.02, CELL / 2);
    mazeGroup.add(start);

    // my footprints
    crumbs = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.16, 10).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      MAX_CRUMBS
    );
    crumbs.count = 0;
    crumbCount = 0;
    mazeGroup.add(crumbs);

    K.sun.position.set(span / 2 + 14, 34, span / 2 + 10);
    K.sun.target.position.set(span / 2, 0, span / 2);
  }

  // Keeps a circle out of the hedges around it.
  function pushOut(p, r) {
    const c = Math.floor(p.x / CELL);
    const rr = Math.floor(p.z / CELL);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc;
        const r2 = rr + dr;
        if (cc < 0 || r2 < 0 || cc >= size || r2 >= size) continue;
        cellWalls[r2 * size + cc].forEach((b) => {
          const cx = ARC.clamp(p.x, b.x0, b.x1);
          const cz = ARC.clamp(p.z, b.z0, b.z1);
          const dx = p.x - cx;
          const dz = p.z - cz;
          const d = Math.hypot(dx, dz);
          if (d >= r) return;
          if (d > 1e-4) {
            p.x = cx + (dx / d) * r;
            p.z = cz + (dz / d) * r;
          } else {
            const pen = [p.x - b.x0, b.x1 - p.x, p.z - b.z0, b.z1 - p.z];
            const k = pen.indexOf(Math.min(...pen));
            if (k === 0) p.x = b.x0 - r;
            else if (k === 1) p.x = b.x1 + r;
            else if (k === 2) p.z = b.z0 - r;
            else p.z = b.z1 + r;
          }
        });
      }
    }
    const span = size * CELL;
    p.x = ARC.clamp(p.x, r, span - r);
    p.z = ARC.clamp(p.z, r, span - r);
  }

  function dropCrumb(x, z) {
    if (crumbCount >= MAX_CRUMBS) return;
    const m = new THREE.Matrix4().makeTranslation(x, 0.015, z);
    crumbs.setMatrixAt(crumbCount++, m);
    crumbs.count = crumbCount;
    crumbs.instanceMatrix.needsUpdate = true;
  }

  /* ---------- Host ---------- */

  function startMatch(v) {
    match = { sizes: SIZES[v.rounds] || SIZES[3], round: 0, scores: {} };
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
    const n = match.sizes[match.round - 1];
    match.limitAt = performance.now() + COUNTDOWN + (60 + n * 8) * 1000;
    const d = {
      seed: match.seed,
      size: n,
      round: match.round,
      rounds: match.sizes.length,
      limitIn: match.limitAt - performance.now(),
      scores: match.scores,
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    };
    room.send("mz.round", d);
    onRound(d);
  }

  function hostFinish(id) {
    if (!match || match.over || match.finished.includes(id) || !match.racers.includes(id)) return;
    match.finished.push(id);
    if (!match.firstOut) match.firstOut = performance.now();
    sendState();
    hostCheck();
  }

  function sendState() {
    const d = {
      finished: match.finished,
      endsIn: Math.max(0, (match.firstOut ? Math.min(match.firstOut + GRACE_MS, match.limitAt) : match.limitAt) - performance.now()),
    };
    room.send("mz.state", d);
    onState(d);
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
    const d = { title: first ? first.name + " found the way out first!" : "Nobody got out!", scores: match.scores };
    room.send("mz.over", d);
    onOver(d);
    setTimeout(() => {
      if (!match) return;
      if (match.round >= match.sizes.length) finish();
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
    buildMaze(d.seed, d.size);
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
    const now = performance.now();
    raceEnds = now + d.limitIn;
    // everybody starts in the first square, a little apart
    const spot = (k) => [CELL / 2 + (k % 2 ? 0.6 : -0.6), CELL / 2 + (k > 1 ? 0.6 : -0.6)];
    players.forEach((p, k) => {
      if (p.id === room.myId) return;
      const o = others.add(p);
      const s = spot(k);
      o.obj.position.set(s[0], 0, s[1]);
    });
    const k = Math.max(0, players.findIndex((p) => p.id === room.myId));
    const s = spot(k);
    const racing = players.some((p) => p.id === room.myId);
    me = racing ? { x: s[0], z: s[1], px: s[0], pz: s[1], heading: 0, lastCrumb: { x: s[0], z: s[1] }, out: false } : null;
    if (me) {
      const my = players[k];
      meObj = K3.character(my ? my.color : 0);
      K.scene.add(meObj);
      // look down the maze
      orbit.yaw = Math.PI * 1.25;
      crumbs.material.color.set(NET.color(my ? my.color : 0));
    }
    phase = "countdown";
    cd.start(COUNTDOWN);
    LOBBY.hide();
    ARC.banner("Maze " + d.round + " of " + d.rounds, 1200);
    renderHud();
  }

  function onRemote(a, from) {
    if (!Array.isArray(a) || phase === "idle") return;
    others.push(from, { x: a[0], z: a[1], h: a[2] }, a[3]);
  }

  function onState(d) {
    const fresh = d.finished.filter((id) => !finished.includes(id));
    finished = d.finished;
    const now = performance.now();
    raceEnds = now + d.endsIn;
    fresh.forEach((id) => {
      if (!firstOut) firstOut = now;
      const p = players.find((x) => x.id === id);
      const o = others.get(id);
      if (o) o.obj.visible = false;
      if (id !== room.myId && p) WG.toast(p.name + " is out! (#" + finished.length + ")", 1600);
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
    const rows = players.map((p) => {
      const place = finished.indexOf(p.id);
      return { name: p.name, color: p.color, value: (scores[p.id] || 0) + (place >= 0 ? " ✓" : ""), me: p.id === room.myId };
    });
    const left = Math.max(0, Math.ceil((raceEnds - performance.now()) / 1000));
    rows.push({ name: "Maze", color: -1, value: roundNo + "/" + roundCount });
    if (phase === "play") rows.push({ name: firstOut ? "Ends in" : "Time left", color: -1, value: Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") });
    ARC.scoreboard($("hud"), rows);
  }
  setInterval(() => {
    if (phase === "play") renderHud();
  }, 500);

  /* ---------- Me ---------- */

  function stepMe(dt) {
    me.px = me.x;
    me.pz = me.z;
    if (phase !== "play" || me.out) return;
    const dir = K3.walkDir(orbit);
    me.x += dir.x * SPEED * dt;
    me.z += dir.z * SPEED * dt;
    pushOut(me, BODY_R);
    others.each((o) => {
      if (!o.obj.visible) return;
      const p = o.obj.position;
      const dx = me.x - p.x;
      const dz = me.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < BODY_R * 2 && d > 1e-4) {
        me.x += (dx / d) * (BODY_R * 2 - d);
        me.z += (dz / d) * (BODY_R * 2 - d);
      }
    });
    pushOut(me, BODY_R);
    if (dir.len) me.heading = ARC.lerpAngle(me.heading, Math.atan2(dir.x, dir.z), Math.min(1, dt * 14));
    if (Math.hypot(me.x - me.lastCrumb.x, me.z - me.lastCrumb.z) > CRUMB_EVERY) {
      me.lastCrumb = { x: me.x, z: me.z };
      dropCrumb(me.x, me.z);
    }
    // out of the maze
    const ex = (size - 0.5) * CELL;
    if (Math.hypot(me.x - ex, me.z - ex) < 1.1) {
      me.out = true;
      const t = (performance.now() - raceStart) / 1000;
      ARC.banner("You're out! " + t.toFixed(1) + " s", 2200);
      if (meObj) meObj.visible = false;
      room.to(room.hostId, "mz.fin", { t });
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
    if (ARC.input.hit("look")) {
      firstPerson = !firstPerson;
      WG.toast(firstPerson ? "First-person view" : "Behind-the-back view", 900);
    }
    if (me) {
      stepMe(dt);
      if (sendDue(dt) && !me.out) {
        room.share("mz.p", [Math.round(me.x * 100) / 100, Math.round(me.z * 100) / 100, Math.round(me.heading * 100) / 100, Math.round(now * 10) / 10]);
      }
    }
    if (room.isHost && match && !match.over && phase === "play") hostCheck();
  }

  let lastDraw = 0;
  const cam = { head: null, off: null, ray: null, dir: null };
  function draw(alpha) {
    if (!K) return;
    const now = performance.now();
    const dt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 0.016;
    lastDraw = now;
    if (!cam.head) {
      cam.head = new THREE.Vector3();
      cam.off = new THREE.Vector3();
      cam.dir = new THREE.Vector3();
      cam.ray = new THREE.Raycaster();
    }
    orbit.turn(dt);
    others.update();

    if (me && meObj) {
      const a = alpha || 0;
      meObj.position.set(ARC.lerp(me.px, me.x, a), 0, ARC.lerp(me.pz, me.z, a));
      meObj.rotation.y = me.heading;
      meObj.visible = !me.out && !firstPerson;
    }

    if (me && meObj && phase !== "idle" && !me.out) {
      cam.head.set(meObj.position.x, EYE, meObj.position.z);
      if (firstPerson) {
        // look the way the mouse points
        orbit.offset(cam.off, 1);
        K.camera.position.copy(cam.head);
        K.camera.lookAt(cam.head.x - cam.off.x, cam.head.y - cam.off.y * 0.6, cam.head.z - cam.off.z);
      } else {
        // behind my back, pulled in when a hedge is in the way
        orbit.offset(cam.off);
        const want = cam.off.length();
        cam.dir.copy(cam.off).normalize();
        cam.ray.set(cam.head, cam.dir);
        cam.ray.far = want;
        const hit = cam.ray.intersectObject(wallMesh, false)[0];
        const dist = hit ? Math.max(0.3, hit.distance - 0.25) : want;
        K.camera.position.copy(cam.head).addScaledVector(cam.dir, dist);
        K.camera.lookAt(cam.head);
      }
    } else {
      // watching from above: after getting out, or in the lobby
      const span = size * CELL;
      const t = now / 14000;
      K.camera.position.set(span / 2 + Math.sin(t) * span * 0.8, span * 0.9, span / 2 + Math.cos(t) * span * 0.8);
      K.camera.lookAt(span / 2, 0, span / 2);
    }
    K.render();
  }
})();
