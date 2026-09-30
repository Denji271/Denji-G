// Minigolf — everybody plays the same hole at once, each with their own ball.
// Each player rolls their own ball (they pass through each other, so lag never matters);
// the host keeps the scorecard and moves everybody on to the next hole.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const BALL_R = 0.15;
  const CUP_R = 0.22;
  const MIN_SHOT = 1.2;
  const MAX_SHOT = 13;
  const AIM_RANGE = 6; // the pointer this far from the ball = a full-power putt
  const ROLL = 0.9; // rolling resistance
  const DRAG = 0.35; // extra slowing that grows with speed
  const SLOPE = 4;
  const BOUNCE = 0.75;
  const REST = 0.08;
  const SUBSTEPS = 4;
  const SINK_SPEED = 6; // faster than this and the ball skips over the cup
  const HOLE_MS = 120000;
  const NEXT_MS = 2800;
  const SAIL = { len: 1.45, speed: 1.6, thick: 0.08 };
  const MOVER_PERIOD = 3.2;
  const SEND_MS = 33;
  const SLOPES = { "<": [-1, 0], ">": [1, 0], "^": [0, -1], v: [0, 1] };
  const SOLID = new Set(["#", "X", "W"]);

  let K = null;
  let orbit = null; // the mouse camera
  let room = null;
  let phase = "idle"; // idle | play
  let hole = null; // parsed: { name, par, w, h, grid, tee, cup, sails, movers }
  let holeIndex = 0;
  let holeCount = 1;
  let holeStart = 0;
  let holeEnds = 0;
  let maxStrokes = 8;
  let cards = {}; // id -> strokes per finished hole
  let cur = {}; // id -> { strokes, done } this hole
  let group = null; // the hole's meshes
  let sails = []; // windmill sails to turn
  let moverMeshes = [];
  let ball = null; // { x, z, vx, vz, moving, sunk, sinkAt, px, pz, slow, rolled }
  let ballObj = null;
  let strokes = 0;
  let done = false;
  let lastRest = null;
  const others = new Map(); // id -> { buf, obj, sunk }
  let pointer = null;
  let pointerAt = 0;
  let aimAngle = Math.PI; // pointing up the screen (towards -z)
  let charge = -1; // seconds Space has been held, -1 when not charging
  let aimMesh = null;
  const sendDue = ARC.every(SEND_MS);
  let ballGeo = null;

  // host only
  let match = null;

  const ready = Promise.all([
    K3.load(),
    WG.loadScript("data/golf-holes.js", () => window.GOLF_HOLES, "golf course"),
  ])
    .then(setup)
    .catch((err) => {
      K3.fail($("game"), err.message);
      throw err;
    });
  const when = (fn) => (d, from) => ready.then(() => fn(d, from));

  LOBBY.init({
    game: "minigolf",
    title: "Minigolf",
    blurb: "Everybody putts the same hole at the same time. Windmills, water and slopes — fewest strokes wins. 1–4 players.",
    lateNote: "A round is on — you join from the current hole.",
    settings: [
      {
        key: "holes",
        label: "Course",
        value: 6,
        options: [
          { value: 3, label: "Quick — 3 holes" },
          { value: 6, label: "6 holes" },
          { value: 9, label: "Full — 9 holes" },
        ],
      },
      {
        key: "max",
        label: "Most strokes a hole",
        value: 8,
        options: [
          { value: 6, label: "6" },
          { value: 8, label: "8" },
          { value: 10, label: "10" },
        ],
      },
    ],
    onRoom,
    onStart: (v) => ready.then(() => startMatch(v)),
    onLobby: () => {
      phase = "idle";
      match = null;
      renderHud();
    },
  });

  function setup() {
    K = K3.stage($("game"), { sky: { light: 0xbfe3ff, dark: 0x172030 }, fog: [25, 70], shadowBox: 12 });
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x3f7a3f, roughness: 1 }));
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.6;
    grass.receiveShadow = true;
    K.scene.add(grass);
    ballGeo = new THREE.SphereGeometry(BALL_R, 16, 12);
    aimMesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.02, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    aimMesh.visible = false;
    K.scene.add(aimMesh);
    buildHole(0);

    const canvas = $("game");
    canvas.addEventListener("pointermove", (e) => {
      pointer = { clientX: e.clientX, clientY: e.clientY };
      pointerAt = performance.now();
    });
    canvas.addEventListener("pointerleave", () => (pointer = null));
    // drag to turn the camera; a click without dragging putts towards where it points
    orbit = K3.orbit(canvas, {
      yaw: 0,
      pitch: 0.9,
      dist: 9.6,
      minPitch: 0.2,
      maxPitch: 1.45,
      minDist: 3,
      maxDist: 26,
      onClick: (e) => {
        pointer = { clientX: e.clientX, clientY: e.clientY };
        pointerAt = performance.now();
        const aim = pointerAim();
        if (aim) shoot(aim.dx, aim.dz, aim.power);
      },
    });

    const loop = ARC.loop(update, draw);
    loop.start();
  }

  function onRoom(r) {
    room = r;
    room.on("mg.hole", when(onHole));
    room.on("mg.card", when(onCard));
    room.on("mg.b", when(onRemote));
    room.on("players", () => {
      others.forEach((o, id) => {
        if (room.player(id)) return;
        K.scene.remove(o.obj);
        o.obj.children.forEach((tag) => K3.dispose(tag)); // the ball shape itself is shared
        o.obj.material.dispose();
        others.delete(id);
      });
      renderHud();
    });
    if (room.isHost) {
      room.on("mg.s", when(hostStatus));
      room.on("join", when((p) => {
        if (!match) return;
        match.cards[p.id] = match.cards[p.id] || [];
        match.cur[p.id] = match.cur[p.id] || { strokes: 0, done: false };
        room.to(p.id, "mg.hole", holePayload());
        sendCard();
      }));
      room.on("leave", when(() => {
        if (match) checkAllDone();
      }));
    }
  }

  /* ---------- Host: the scorecard ---------- */

  function startMatch(v) {
    match = {
      count: Math.min(v.holes, GOLF_HOLES.length),
      index: -1,
      max: v.max,
      cards: {},
      cur: {},
      advancing: false,
      deadline: 0,
    };
    room.players.forEach((p) => (match.cards[p.id] = []));
    nextHole();
  }

  function nextHole() {
    if (!match) return;
    if (match.index >= 0) {
      Object.keys(match.cards).forEach((id) => {
        const c = match.cur[id];
        if (c) match.cards[id][match.index] = c.done ? c.strokes : match.max;
      });
    }
    match.index++;
    match.advancing = false;
    if (match.index >= match.count) {
      finish();
      return;
    }
    match.cur = {};
    room.players.forEach((p) => {
      match.cards[p.id] = match.cards[p.id] || [];
      match.cur[p.id] = { strokes: 0, done: false };
    });
    match.deadline = performance.now() + HOLE_MS;
    const d = holePayload();
    room.send("mg.hole", d);
    onHole(d);
  }

  function holePayload() {
    return {
      index: match.index,
      count: match.count,
      max: match.max,
      endsIn: Math.max(0, match.deadline - performance.now()),
      cards: match.cards,
      cur: match.cur,
    };
  }

  function sendCard() {
    const d = { index: match.index, cards: match.cards, cur: match.cur };
    room.send("mg.card", d);
    onCard(d);
  }

  function hostStatus(d, from) {
    if (!match || match.advancing || !d || d.hole !== match.index) return;
    const c = match.cur[from] || (match.cur[from] = { strokes: 0, done: false });
    c.strokes = ARC.clamp(d.strokes | 0, 0, match.max);
    c.done = !!d.done || c.strokes >= match.max;
    sendCard();
    checkAllDone();
  }

  function checkAllDone() {
    if (!match || match.advancing) return;
    const everyone = room.players.every((p) => match.cur[p.id] && match.cur[p.id].done);
    if (!everyone) return;
    match.advancing = true;
    setTimeout(nextHole, NEXT_MS);
  }

  function hostTick() {
    if (!match || match.advancing || performance.now() < match.deadline) return;
    Object.values(match.cur).forEach((c) => {
      if (!c.done) {
        c.done = true;
        c.strokes = match.max;
      }
    });
    sendCard();
    match.advancing = true;
    setTimeout(nextHole, NEXT_MS);
  }

  function finish() {
    const par = GOLF_HOLES.slice(0, match.count).reduce((s, h) => s + h.par, 0);
    const rows = room.players
      .map((p) => {
        const card = match.cards[p.id] || [];
        let total = 0;
        for (let i = 0; i < match.count; i++) total += card[i] === undefined ? match.max : card[i];
        return { p, total };
      })
      .sort((a, b) => a.total - b.total)
      .map(({ p, total }) => {
        const diff = total - par;
        return { name: p.name, color: p.color, value: total + " strokes", note: diff === 0 ? "level par" : (diff > 0 ? "+" : "") + diff + " to par" };
      });
    const title = rows.length > 1 ? rows[0].name + " wins!" : "Round done — " + (rows[0] ? rows[0].value : "");
    match = null;
    phase = "idle";
    LOBBY.results(rows, title);
  }

  /* ---------- The course ---------- */

  function parse(def) {
    const w = Math.max(...def.rows.map((r) => r.length));
    const grid = def.rows.map((r) => r.padEnd(w, " "));
    const out = { name: def.name, par: def.par, w, h: grid.length, grid, tee: null, cup: null, sails: [], movers: [] };
    grid.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        const x = c + 0.5;
        const z = r + 0.5;
        if (ch === "S") out.tee = { x, z };
        else if (ch === "O") out.cup = { x, z };
        else if (ch === "W") out.sails.push({ x, z });
        else if (ch === "M") {
          // slides along the open stretch of its row
          let a = c;
          let b = c;
          const open = (k) => k >= 0 && k < w && !SOLID.has(row[k]) && row[k] !== " ";
          while (open(a - 1)) a--;
          while (open(b + 1)) b++;
          const span = Math.max(1, b - a);
          out.movers.push({ z, min: a + 0.5, max: b + 0.5, phase: Math.acos(1 - (2 * (c - a)) / span) });
        }
      });
    });
    return out;
  }

  function tileAt(c, r) {
    if (!hole || r < 0 || r >= hole.h || c < 0 || c >= hole.w) return " ";
    return hole.grid[r][c];
  }

  function moverX(m, t) {
    return m.min + (m.max - m.min) * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / MOVER_PERIOD + m.phase));
  }

  function moverVX(m, t) {
    const w = (2 * Math.PI) / MOVER_PERIOD;
    return (m.max - m.min) * 0.5 * w * Math.sin(w * t + m.phase);
  }

  function holeTime() {
    return (performance.now() - holeStart) / 1000;
  }

  function buildHole(index) {
    if (group) {
      K.scene.remove(group);
      K3.dispose(group);
    }
    hole = parse(GOLF_HOLES[index]);
    group = new THREE.Group();
    K.scene.add(group);
    sails = [];
    moverMeshes = [];

    const counts = { green: 0, wall: 0, post: 0, water: 0 };
    hole.grid.forEach((row) =>
      [...row].forEach((ch) => {
        if (ch === "#" || ch === "W") counts.wall++;
        else if (ch === "X") counts.post++;
        else if (ch === "~") counts.water++;
        else if (ch !== " ") counts.green++;
      })
    );
    const box = new THREE.BoxGeometry(1, 1, 1);
    const inst = (n, color, castShadow) => {
      const m = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color, roughness: 0.8 }), Math.max(1, n));
      m.count = n;
      m.castShadow = castShadow;
      m.receiveShadow = true;
      group.add(m);
      return m;
    };
    const greens = inst(counts.green, 0xffffff, false);
    const walls = inst(counts.wall, 0xa0764a, true);
    const posts = inst(counts.post, 0xe05c4a, true);
    const water = inst(counts.water, 0x3b82c4, false);
    const mtx = new THREE.Matrix4();
    const light = new THREE.Color(0x6cbf5f);
    const dark = new THREE.Color(0x5fae55);
    const k = { green: 0, wall: 0, post: 0, water: 0 };
    const place = (mesh, i, x, y, z, sy) => {
      mtx.makeScale(1, sy, 1);
      mtx.setPosition(x, y, z);
      mesh.setMatrixAt(i, mtx);
    };
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.3);
    arrowShape.lineTo(0.22, -0.05);
    arrowShape.lineTo(0.08, -0.05);
    arrowShape.lineTo(0.08, -0.3);
    arrowShape.lineTo(-0.08, -0.3);
    arrowShape.lineTo(-0.08, -0.05);
    arrowShape.lineTo(-0.22, -0.05);
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0xbfe8a8, transparent: true, opacity: 0.75 });

    hole.grid.forEach((row, r) =>
      [...row].forEach((ch, c) => {
        const x = c + 0.5;
        const z = r + 0.5;
        if (ch === "#" || ch === "W") place(walls, k.wall++, x, ch === "W" ? 0.8 : 0.175, z, ch === "W" ? 1.6 : 0.35);
        else if (ch === "X") place(posts, k.post++, x, 0.2, z, 0.4);
        else if (ch === "~") place(water, k.water++, x, -0.14, z, 0.06);
        else if (ch !== " ") {
          place(greens, k.green, x, -0.05, z, 0.1);
          greens.setColorAt(k.green++, (r + c) % 2 ? light : dark);
          const s = SLOPES[ch];
          if (s) {
            const a = new THREE.Mesh(arrowGeo, arrowMat);
            a.rotation.x = -Math.PI / 2;
            a.rotation.z = Math.atan2(-s[0], -s[1]); // the arrow shape points up (-z) before turning
            a.position.set(x, 0.004, z);
            group.add(a);
          }
        }
      })
    );
    [greens, walls, posts, water].forEach((m) => {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });

    // windmills: a roof on the tower and a sail that turns round it
    hole.sails.forEach((s) => {
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.8, 0.8, 4), new THREE.MeshStandardMaterial({ color: 0xb8443a, roughness: 0.7 }));
      roof.position.set(s.x, 2, s.z);
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      const sail = new THREE.Mesh(new THREE.BoxGeometry(SAIL.len * 2, 0.2, SAIL.thick * 2), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));
      sail.position.set(s.x, 0.14, s.z);
      sail.castShadow = true;
      group.add(roof, sail);
      sails.push(sail);
    });
    hole.movers.forEach(() => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 0.35, 1), new THREE.MeshStandardMaterial({ color: 0x9a5bd6, roughness: 0.6 }));
      m.castShadow = true;
      group.add(m);
      moverMeshes.push(m);
    });

    // the cup and its flag
    const cup = new THREE.Mesh(new THREE.CircleGeometry(CUP_R, 24), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    cup.rotation.x = -Math.PI / 2;
    cup.position.set(hole.cup.x, 0.003, hole.cup.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.4, 8), new THREE.MeshStandardMaterial({ color: 0xf2f2f2 }));
    pole.position.set(hole.cup.x, 0.7, hole.cup.z);
    pole.castShadow = true;
    const flagShape = new THREE.Shape();
    flagShape.moveTo(0, 0);
    flagShape.lineTo(0.55, -0.16);
    flagShape.lineTo(0, -0.32);
    const flag = new THREE.Mesh(new THREE.ShapeGeometry(flagShape), new THREE.MeshStandardMaterial({ color: 0xe05c4a, side: THREE.DoubleSide }));
    flag.position.set(hole.cup.x + 0.02, 1.38, hole.cup.z);
    const tee = new THREE.Mesh(new THREE.CircleGeometry(0.28, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
    tee.rotation.x = -Math.PI / 2;
    tee.position.set(hole.tee.x, 0.003, hole.tee.z);
    group.add(cup, pole, flag, tee);
  }

  /* ---------- Ball physics ---------- */

  function bounceOff(b, nx, nz, ox, oz) {
    const vn = (b.vx - ox) * nx + (b.vz - oz) * nz;
    if (vn < 0) {
      b.vx -= (1 + BOUNCE) * vn * nx;
      b.vz -= (1 + BOUNCE) * vn * nz;
    }
  }

  // ox, oz: how fast the thing is moving (for the sliding blocks)
  function hitBox(b, x0, z0, x1, z1, ox, oz) {
    const cx = ARC.clamp(b.x, x0, x1);
    const cz = ARC.clamp(b.z, z0, z1);
    let dx = b.x - cx;
    let dz = b.z - cz;
    const d = Math.hypot(dx, dz);
    if (d >= BALL_R) return;
    if (d > 1e-6) {
      dx /= d;
      dz /= d;
      b.x = cx + dx * BALL_R;
      b.z = cz + dz * BALL_R;
    } else {
      // centre inside the block: out through the nearest side
      const pen = [b.x - x0, x1 - b.x, b.z - z0, z1 - b.z];
      const i = pen.indexOf(Math.min(...pen));
      dx = i === 0 ? -1 : i === 1 ? 1 : 0;
      dz = i === 2 ? -1 : i === 3 ? 1 : 0;
      if (i === 0) b.x = x0 - BALL_R;
      else if (i === 1) b.x = x1 + BALL_R;
      else if (i === 2) b.z = z0 - BALL_R;
      else b.z = z1 + BALL_R;
    }
    bounceOff(b, dx, dz, ox || 0, oz || 0);
  }

  function hitSail(b, s, t) {
    const a = t * SAIL.speed;
    const ux = Math.cos(a);
    const uz = -Math.sin(a);
    const along = ARC.clamp((b.x - s.x) * ux + (b.z - s.z) * uz, -SAIL.len, SAIL.len);
    const px = s.x + ux * along;
    const pz = s.z + uz * along;
    let dx = b.x - px;
    let dz = b.z - pz;
    const d = Math.hypot(dx, dz);
    const reach = BALL_R + SAIL.thick;
    if (d >= reach || d < 1e-6) return;
    dx /= d;
    dz /= d;
    b.x = px + dx * reach;
    b.z = pz + dz * reach;
    // the sail's own speed where it touches the ball (it turns about the tower)
    const w = SAIL.speed;
    bounceOff(b, dx, dz, uz * w * along, -ux * w * along);
  }

  function stepBall(b, dt) {
    const t = holeTime();
    const s = SLOPES[tileAt(Math.floor(b.x), Math.floor(b.z))];
    if (s) {
      b.vx += s[0] * SLOPE * dt;
      b.vz += s[1] * SLOPE * dt;
    }
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > 0) {
      const ns = Math.max(0, sp - (ROLL + DRAG * sp) * dt);
      b.vx *= ns / sp;
      b.vz *= ns / sp;
    }
    b.x += b.vx * dt;
    b.z += b.vz * dt;

    const c = Math.floor(b.x);
    const r = Math.floor(b.z);
    for (let rr = r - 1; rr <= r + 1; rr++) {
      for (let cc = c - 1; cc <= c + 1; cc++) {
        if (SOLID.has(tileAt(cc, rr))) hitBox(b, cc, rr, cc + 1, rr + 1);
      }
    }
    hole.movers.forEach((m) => {
      const mx = moverX(m, t);
      hitBox(b, mx - 0.5, m.z - 0.5, mx + 0.5, m.z + 0.5, moverVX(m, t), 0);
    });
    hole.sails.forEach((sail) => hitSail(b, sail, t));
    return !!s;
  }

  // Runs my ball for one game step. Returns "cup", "splash" or "" when nothing happened.
  function rollBall(dt) {
    const b = ball;
    let onSlope = false;
    for (let i = 0; i < SUBSTEPS; i++) {
      onSlope = stepBall(b, dt / SUBSTEPS) || onSlope;
      const dCup = Math.hypot(b.x - hole.cup.x, b.z - hole.cup.z);
      if (dCup < CUP_R && Math.hypot(b.vx, b.vz) < SINK_SPEED) return "cup";
      const under = tileAt(Math.floor(b.x), Math.floor(b.z));
      if (under === " " || under === "~") return "splash";
    }
    b.rolled += dt;
    const sp = Math.hypot(b.vx, b.vz);
    b.slow = sp < REST ? b.slow + dt : 0;
    // at rest: stopped off a slope, stuck against a wall on one, or rolling for ages
    if ((sp < REST && !onSlope) || b.slow > 1.2 || b.rolled > 25) {
      b.vx = 0;
      b.vz = 0;
      b.moving = false;
      return "rest";
    }
    return "";
  }

  /* ---------- Everybody: holes ---------- */

  function onHole(d) {
    buildHole(d.index);
    holeIndex = d.index;
    holeCount = d.count;
    maxStrokes = d.max;
    cards = d.cards || {};
    cur = d.cur || {};
    const now = performance.now();
    holeStart = now;
    holeEnds = now + d.endsIn;
    strokes = 0;
    done = false;
    charge = -1;
    ball = { x: hole.tee.x, z: hole.tee.z, px: hole.tee.x, pz: hole.tee.z, vx: 0, vz: 0, moving: false, sunk: false, sinkAt: 0, slow: 0, rolled: 0 };
    lastRest = { x: ball.x, z: ball.z };
    aimAngle = Math.atan2(hole.cup.x - hole.tee.x, hole.cup.z - hole.tee.z);
    if (!ballObj) {
      const my = room.player(room.myId);
      ballObj = makeBall(my ? my.color : 0);
      K.scene.add(ballObj);
    }
    others.forEach((o) => {
      o.buf.clear();
      o.sunk = false;
      o.obj.position.set(hole.tee.x, BALL_R, hole.tee.z);
    });
    phase = "play";
    LOBBY.hide();
    ARC.banner("Hole " + (d.index + 1) + " · Par " + hole.par, 1800);
    renderHud();
  }

  function makeBall(color) {
    const mesh = new THREE.Mesh(ballGeo, new THREE.MeshStandardMaterial({ color: new THREE.Color(NET.color(color)), roughness: 0.35 }));
    mesh.castShadow = true;
    return mesh;
  }

  function onCard(d) {
    if (d.index !== holeIndex) return;
    cards = d.cards || cards;
    cur = d.cur || cur;
    renderHud();
  }

  function onRemote(a, from) {
    if (!Array.isArray(a) || !hole) return;
    let o = others.get(from);
    if (!o) {
      const p = room.player(from);
      if (!p) return;
      const obj = makeBall(p.color);
      const tag = K3.label(p.name);
      tag.scale.set(1.4, 0.35, 1);
      tag.position.y = 0.55;
      obj.add(tag);
      K.scene.add(obj);
      o = { buf: ARC.snapshots(100), obj, sunk: false };
      others.set(from, o);
    }
    o.buf.push({ x: a[0], z: a[1] }, a[3]);
    o.sunk = !!a[2];
  }

  function sendStatus() {
    room.to(room.hostId, "mg.s", { hole: holeIndex, strokes, done });
  }

  function canShoot() {
    return phase === "play" && !done && ball && !ball.moving && !ball.sunk && strokes < maxStrokes && !ARC.input.held("view");
  }

  // Where the pointer says to putt: direction and power.
  function pointerAim() {
    if (!pointer || !ball || !K) return null;
    const p = K3.pointOnPlane(pointer, $("game"), K.camera, BALL_R);
    if (!p) return null;
    const dx = p.x - ball.x;
    const dz = p.z - ball.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return null;
    return { dx: dx / d, dz: dz / d, power: ARC.clamp(d / AIM_RANGE, 0.04, 1) };
  }

  function shoot(dx, dz, power) {
    if (!canShoot()) return;
    const speed = MIN_SHOT + power * (MAX_SHOT - MIN_SHOT);
    lastRest = { x: ball.x, z: ball.z };
    ball.vx = dx * speed;
    ball.vz = dz * speed;
    ball.moving = true;
    ball.slow = 0;
    ball.rolled = 0;
    aimAngle = Math.atan2(dx, dz);
    strokes++;
    sendStatus();
    renderHud();
  }

  function scoreName(n, par) {
    if (n === 1) return "Hole in one!";
    const diff = n - par;
    return { "-3": "Albatross!", "-2": "Eagle!", "-1": "Birdie!", 0: "Par", 1: "Bogey", 2: "Double bogey" }[diff] || n + " strokes";
  }

  function update(dt) {
    if (!room || phase !== "play" || !ball) return;
    ball.px = ball.x;
    ball.pz = ball.z;

    if (ball.moving) {
      const what = rollBall(dt);
      if (what === "cup") {
        ball.moving = false;
        ball.sunk = true;
        ball.sinkAt = performance.now();
        ball.x = hole.cup.x;
        ball.z = hole.cup.z;
        done = true;
        ARC.banner(scoreName(strokes, hole.par), 2000);
        sendStatus();
      } else if (what === "splash") {
        strokes++;
        ball.moving = false;
        ball.vx = 0;
        ball.vz = 0;
        ball.x = ball.px = lastRest.x;
        ball.z = ball.pz = lastRest.z;
        WG.toast("Splash! One stroke penalty", 1400);
        if (strokes >= maxStrokes) done = true;
        sendStatus();
      } else if (what === "rest" && strokes >= maxStrokes) {
        done = true;
        ARC.banner("Out of strokes", 1600);
        sendStatus();
      }
      renderHud();
    } else if (canShoot()) {
      // keyboard putting: aim with the arrows, hold Space for power
      const turn = (ARC.input.held("right") ? 1 : 0) - (ARC.input.held("left") ? 1 : 0);
      if (turn) {
        aimAngle -= turn * 1.6 * dt;
        pointerAt = 0;
      }
      if (ARC.input.held("action")) {
        charge = charge < 0 ? 0 : charge + dt;
      } else if (charge >= 0) {
        shoot(Math.sin(aimAngle), Math.cos(aimAngle), keyPower());
        charge = -1;
      }
    }

    if (sendDue(dt) && (ball.moving || ball.sunk || !ball.sentRest)) {
      ball.sentRest = !ball.moving;
      room.share("mg.b", [Math.round(ball.x * 1000) / 1000, Math.round(ball.z * 1000) / 1000, ball.sunk ? 1 : 0, Math.round(performance.now() * 10) / 10]);
    }
    if (ball.moving) ball.sentRest = false;
    if (room.isHost) hostTick();
  }

  // Space power swings up and down so a long hold is not always a full-power putt.
  function keyPower() {
    const t = (charge * 0.8) % 2;
    return ARC.clamp(t < 1 ? t : 2 - t, 0.04, 1);
  }

  function renderHud() {
    if (!room || phase === "idle" || !hole) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = room.players
      .filter((p) => cur[p.id] || cards[p.id])
      .map((p) => {
        const card = cards[p.id] || [];
        const c = cur[p.id] || { strokes: 0, done: false };
        const mine = p.id === room.myId;
        const now = mine ? strokes : c.strokes;
        const total = card.reduce((s, n) => s + (n || 0), 0) + now;
        return { name: p.name, color: p.color, value: total + ((mine ? done : c.done) ? " ✓" : ""), me: mine };
      });
    const left = Math.max(0, Math.ceil((holeEnds - performance.now()) / 1000));
    rows.push({ name: "Hole", color: -1, value: holeIndex + 1 + "/" + holeCount });
    rows.push({ name: "Par", color: -1, value: hole.par });
    rows.push({ name: "Strokes", color: -1, value: strokes + "/" + maxStrokes });
    rows.push({ name: "Time", color: -1, value: Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") });
    ARC.scoreboard($("hud"), rows);
  }
  setInterval(() => {
    if (phase === "play") renderHud();
  }, 1000);

  /* ---------- Drawing ---------- */

  let lastDraw = 0;
  const cam = { v: null, off: null, dist: 0 };
  function draw(alpha) {
    if (!K) return;
    const now = performance.now();
    const dt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 0.016;
    lastDraw = now;
    if (!cam.v) {
      cam.v = new THREE.Vector3();
      cam.off = new THREE.Vector3();
      cam.dist = orbit.dist;
    }
    orbit.turn(dt);
    const t = holeTime();
    sails.forEach((m, i) => {
      m.rotation.y = t * SAIL.speed;
      m.position.set(hole.sails[i].x, 0.14, hole.sails[i].z);
    });
    moverMeshes.forEach((m, i) => m.position.set(moverX(hole.movers[i], t), 0.175, hole.movers[i].z));

    if (ball && ballObj) {
      const a = alpha || 0;
      let y = BALL_R;
      if (ball.sunk) y = BALL_R - Math.min(0.5, (now - ball.sinkAt) / 600);
      ballObj.position.set(ARC.lerp(ball.px, ball.x, a), y, ARC.lerp(ball.pz, ball.z, a));
      ballObj.visible = y > -0.3;
    }
    others.forEach((o) => {
      const s = o.buf.sample();
      if (s) o.obj.position.set(ARC.lerp(s.a.x, s.b.x, s.t), BALL_R, ARC.lerp(s.a.z, s.b.z, s.t));
      o.obj.visible = !o.sunk;
    });

    // the aiming line: which way, and how hard
    let aim = null;
    if (canShoot()) {
      const p = now - pointerAt < 4000 && !orbit.dragging ? pointerAim() : null;
      if (p) {
        aimAngle = Math.atan2(p.dx, p.dz);
        aim = p.power;
      } else {
        aim = charge >= 0 ? keyPower() : 0.25;
      }
    }
    aimMesh.visible = aim !== null;
    if (aim !== null) {
      const len = 0.4 + aim * 2.6;
      aimMesh.scale.z = len;
      aimMesh.rotation.y = aimAngle;
      aimMesh.position.set(ball.x + Math.sin(aimAngle) * (len / 2 + BALL_R), 0.03, ball.z + Math.cos(aimAngle) * (len / 2 + BALL_R));
      aimMesh.material.color.setHSL(0.33 * (1 - aim), 0.85, 0.5);
    }

    // follow my ball; hold V (or once I'm done) to see the whole hole. The mouse turns the
    // camera at once; only the switch between the ball and the whole hole glides.
    const overview = phase !== "play" || ARC.input.held("view") || done;
    let fx = hole.w / 2;
    let fz = hole.h / 2;
    let dist = orbit.dist;
    let pitch = orbit.pitch;
    if (overview) {
      dist = Math.max(dist, Math.max(hole.w, hole.h) * 1.15 + 3);
      pitch = Math.max(pitch, 0.85);
    } else if (ballObj) {
      fx = ballObj.position.x;
      fz = ballObj.position.z;
    }
    const k = 1 - Math.exp(-6 * dt);
    cam.v.x += (fx - cam.v.x) * k;
    cam.v.z += (fz - cam.v.z) * k;
    cam.dist += (dist - cam.dist) * k;
    cam.pitch = cam.pitch === undefined ? pitch : cam.pitch + (pitch - cam.pitch) * k;
    orbit.offset(cam.off, cam.dist, cam.pitch);
    K.camera.position.copy(cam.v).add(cam.off);
    K.camera.lookAt(cam.v.x, 0.6, cam.v.z);
    K.render();
  }
})();
