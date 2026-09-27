// Tank Trouble — tanks in a maze, shells that bounce off the walls. Last tank rolling scores.
// The host simulates everything; guests send the keys they hold and draw the host's snapshots.
(function () {
  "use strict";

  const COLS = 9;
  const ROWS = 6;
  const CELL = 96;
  const WALL = 6;
  const W = COLS * CELL;
  const H = ROWS * CELL;
  const TANK_R = 13;
  const SPEED = 125;
  const BACK_SPEED = 85;
  const TURN = 3.3;
  const SHELL_R = 3.5;
  const SHELL_SPEED = 210;
  const SHELL_LIFE = 9;
  const MAX_SHELLS = 5;
  const RELOAD = 0.18;
  const ROUND_PAUSE = 3;
  const COUNTDOWN = 2;

  const $ = (id) => document.getElementById(id);
  const view = ARC.view($("game"), W, H);

  let room = null;
  let walls = []; // rectangles {x, y, w, h}
  let tanks = []; // host: the simulation; guests: filled from snapshots
  let shells = [];
  let phase = "idle"; // idle | countdown | run | pause
  let countdownEnd = 0;
  let lastCount = -1;
  let target = 5;
  let players = []; // [{ id, name, color, score }] this round
  const snaps = ARC.snapshots();
  const bursts = []; // explosions to draw

  // host only
  let match = null;
  let timer = 0;
  let nextShellId = 1;
  const inputs = {}; // id -> { u, d, l, r, f }
  let myInput = "";
  let inputAge = 0;

  LOBBY.init({
    game: "tanks",
    title: "Tank Trouble",
    blurb: "Drive, aim and bounce your shells around the maze. Last tank rolling scores. 2–4 players.",
    settings: [
      {
        key: "target",
        label: "First to",
        value: 5,
        options: [
          { value: 3, label: "3 points" },
          { value: 5, label: "5 points" },
          { value: 10, label: "10 points" },
        ],
      },
    ],
    onRoom,
    onStart: startMatch,
    onLobby: () => {
      phase = "idle";
      match = null;
      ARC.banner("");
    },
  });

  ARC.loop(update, draw).start();

  function onRoom(r) {
    room = r;
    room.on("tk.round", onRound);
    room.on("tk.go", () => (phase = "run"));
    room.on("tk.s", (d) => {
      if (!room.isHost) snaps.push(d, d.ts);
    });
    room.on("tk.boom", (d) => boom(d.x, d.y, d.color));
    room.on("tk.over", onRoundOver);
    room.on("players", renderHud);
    if (room.isHost) {
      room.on("tk.in", (d, from) => (inputs[from] = parseInput(d)));
      room.on("leave", (p) => {
        if (!match) return;
        match.players = match.players.filter((m) => m.id !== p.id);
        const t = tanks.find((x) => x.id === p.id);
        if (t && t.alive) {
          t.alive = false;
          room.send("tk.boom", { x: t.x, y: t.y, color: t.color });
        }
      });
    }
  }

  function parseInput(s) {
    s = String(s || "");
    return { u: s.includes("u"), d: s.includes("d"), l: s.includes("l"), r: s.includes("r"), f: s.includes("f") };
  }

  /* ---------- Maze ---------- */

  // Same seed, same maze on every machine.
  function buildMaze(seed) {
    const rand = WG.rng(seed);
    const h = []; // h[r][c]: wall above cell (r, c); r = 0..ROWS
    const v = []; // v[r][c]: wall left of cell (r, c); c = 0..COLS
    for (let r = 0; r <= ROWS; r++) h.push(new Array(COLS).fill(true));
    for (let r = 0; r < ROWS; r++) v.push(new Array(COLS + 1).fill(true));
    const seen = new Set();
    const stack = [[Math.floor(rand() * COLS), Math.floor(rand() * ROWS)]];
    seen.add(stack[0].join());
    while (stack.length) {
      const [c, r] = stack[stack.length - 1];
      const next = WG.shuffle(
        [
          [c + 1, r, () => (v[r][c + 1] = false)],
          [c - 1, r, () => (v[r][c] = false)],
          [c, r + 1, () => (h[r + 1][c] = false)],
          [c, r - 1, () => (h[r][c] = false)],
        ],
        rand
      ).find(([x, y]) => x >= 0 && y >= 0 && x < COLS && y < ROWS && !seen.has(x + "," + y));
      if (!next) {
        stack.pop();
        continue;
      }
      next[2]();
      seen.add(next[0] + "," + next[1]);
      stack.push([next[0], next[1]]);
    }
    // knock out some extra walls so there is more than one way around
    for (let r = 1; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (h[r][c] && rand() < 0.22) h[r][c] = false;
    for (let r = 0; r < ROWS; r++) for (let c = 1; c < COLS; c++) if (v[r][c] && rand() < 0.22) v[r][c] = false;

    const rects = [];
    for (let r = 0; r <= ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (h[r][c]) rects.push({ x: c * CELL - WALL / 2, y: r * CELL - WALL / 2, w: CELL + WALL, h: WALL });
      }
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c <= COLS; c++) {
        if (v[r][c]) rects.push({ x: c * CELL - WALL / 2, y: r * CELL - WALL / 2, w: WALL, h: CELL + WALL });
      }
    }
    return rects;
  }

  /* ---------- Host: match and rounds ---------- */

  function startMatch(settings) {
    match = {
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: 0 })),
      target: settings.target,
      started: room.players.length,
    };
    startRound();
  }

  function startRound() {
    room.players.forEach((p) => {
      if (!match.players.some((m) => m.id === p.id)) match.players.push({ id: p.id, name: p.name, color: p.color, score: 0 });
    });
    const seed = Math.floor(Math.random() * 1e9);
    // spread the tanks over the maze
    const cells = WG.shuffle([...Array(COLS * ROWS).keys()]);
    const picked = [];
    for (const i of cells) {
      if (picked.length === match.players.length) break;
      const c = i % COLS;
      const r = Math.floor(i / COLS);
      if (picked.every((p) => Math.abs(p.c - c) + Math.abs(p.r - r) >= 4)) picked.push({ c, r });
    }
    while (picked.length < match.players.length) picked.push({ c: cells[picked.length] % COLS, r: Math.floor(cells[picked.length] / COLS) });
    const payload = {
      seed,
      target: match.target,
      players: match.players.map((m, i) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        score: m.score,
        x: (picked[i].c + 0.5) * CELL,
        y: (picked[i].r + 0.5) * CELL,
        a: Math.floor(Math.random() * 4) * (Math.PI / 2),
      })),
    };
    room.send("tk.round", payload);
    onRound(payload);
    timer = COUNTDOWN;
    nextShellId = 1;
  }

  function hostUpdate(dt) {
    if (phase === "countdown") {
      timer -= dt;
      if (timer <= 0) {
        phase = "run";
        room.send("tk.go");
      }
    } else if (phase === "pause") {
      timer -= dt;
      if (timer <= 0) finishRound();
    }
    if (phase !== "run" && phase !== "pause") return;

    // where everything was before this step, so drawing can blend in between
    tanks.forEach((t) => {
      t.px = t.x;
      t.py = t.y;
      t.pa = t.a;
    });
    shells.forEach((sh) => {
      sh.px = sh.x;
      sh.py = sh.y;
    });

    tanks.forEach((t) => {
      if (!t.alive) return;
      const inp = inputs[t.id] || {};
      t.reload = Math.max(0, t.reload - dt);
      const turn = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
      t.a += turn * TURN * dt;
      const drive = inp.u ? SPEED : inp.d ? -BACK_SPEED : 0;
      t.x += Math.cos(t.a) * drive * dt;
      t.y += Math.sin(t.a) * drive * dt;
      pushOut(t, TANK_R);
      if (inp.f && !t.held && t.reload <= 0 && shells.filter((s) => s.owner === t.id).length < MAX_SHELLS) fire(t);
      t.held = !!inp.f;
    });

    for (let i = shells.length - 1; i >= 0; i--) {
      const s = shells[i];
      s.life -= dt;
      if (s.life <= 0) {
        shells.splice(i, 1);
        continue;
      }
      // two half steps keep fast shells from slipping through corners
      for (let k = 0; k < 2; k++) {
        s.x += (s.vx * dt) / 2;
        s.y += (s.vy * dt) / 2;
        bounce(s);
      }
      s.age += dt;
      const hit = tanks.find(
        (t) => t.alive && (t.id !== s.owner || s.age > 0.12) && Math.hypot(t.x - s.x, t.y - s.y) < TANK_R + SHELL_R
      );
      if (hit) {
        hit.alive = false;
        shells.splice(i, 1);
        const d = { x: hit.x, y: hit.y, color: hit.color };
        room.send("tk.boom", d);
        boom(d.x, d.y, d.color);
      }
    }

    room.send("tk.s", snapshot()); // every step: 60 updates a second

    const alive = tanks.filter((t) => t.alive);
    if (phase === "run" && alive.length <= (tanks.length > 1 ? 1 : 0)) {
      // a short pause: the last shells can still change the outcome
      phase = "pause";
      timer = ROUND_PAUSE;
    }
  }

  function fire(t) {
    t.reload = RELOAD;
    const s = {
      id: nextShellId++,
      owner: t.id,
      x: t.x + Math.cos(t.a) * (TANK_R + 6),
      y: t.y + Math.sin(t.a) * (TANK_R + 6),
      vx: Math.cos(t.a) * SHELL_SPEED,
      vy: Math.sin(t.a) * SHELL_SPEED,
      life: SHELL_LIFE,
      age: 0,
    };
    bounce(s);
    shells.push(s);
  }

  function finishRound() {
    const alive = tanks.filter((t) => t.alive);
    let winner = null;
    if (alive.length === 1 && tanks.length > 1) {
      winner = match.players.find((m) => m.id === alive[0].id) || null;
      if (winner) winner.score++;
    }
    const d = { winner: winner ? winner.id : null, scores: match.players.map((m) => [m.id, m.score]) };
    room.send("tk.over", d);
    onRoundOver(d);
    const ranked = match.players.slice().sort((a, b) => b.score - a.score);
    const lonely = match.started > 1 && match.players.length < 2;
    if ((ranked.length && ranked[0].score >= match.target) || lonely) {
      phase = "idle";
      const rows = ranked.map((p) => ({ name: p.name, color: p.color, value: p.score }));
      setTimeout(() => {
        match = null;
        LOBBY.results(rows, ranked[0].name + " wins!");
      }, 1500);
      return;
    }
    phase = "between";
    setTimeout(() => {
      if (match) startRound();
    }, 1500);
  }

  function snapshot() {
    return {
      ts: Math.round(performance.now() * 10) / 10,
      t: tanks.map((t) => [Math.round(t.x * 10) / 10, Math.round(t.y * 10) / 10, Math.round(t.a * 100) / 100, t.alive ? 1 : 0]),
      s: shells.map((s) => [s.id, Math.round(s.x), Math.round(s.y)]),
    };
  }

  /* ---------- Physics ---------- */

  function pushOut(o, r) {
    for (const w of walls) {
      const cx = ARC.clamp(o.x, w.x, w.x + w.w);
      const cy = ARC.clamp(o.y, w.y, w.y + w.h);
      const dx = o.x - cx;
      const dy = o.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      if (d2 > 0.0001) {
        const d = Math.sqrt(d2);
        o.x += (dx / d) * (r - d);
        o.y += (dy / d) * (r - d);
      } else {
        // centre inside the wall: leave along the shallow side
        const left = o.x - w.x;
        const right = w.x + w.w - o.x;
        const top = o.y - w.y;
        const bottom = w.y + w.h - o.y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) o.x = w.x - r;
        else if (m === right) o.x = w.x + w.w + r;
        else if (m === top) o.y = w.y - r;
        else o.y = w.y + w.h + r;
      }
    }
    o.x = ARC.clamp(o.x, r, W - r);
    o.y = ARC.clamp(o.y, r, H - r);
  }

  function bounce(s) {
    for (const w of walls) {
      if (s.x + SHELL_R <= w.x || s.x - SHELL_R >= w.x + w.w || s.y + SHELL_R <= w.y || s.y - SHELL_R >= w.y + w.h) continue;
      const penX = Math.min(s.x + SHELL_R - w.x, w.x + w.w - (s.x - SHELL_R));
      const penY = Math.min(s.y + SHELL_R - w.y, w.y + w.h - (s.y - SHELL_R));
      if (penX < penY) {
        s.vx = -s.vx;
        s.x += s.x < w.x + w.w / 2 ? -penX : penX;
      } else {
        s.vy = -s.vy;
        s.y += s.y < w.y + w.h / 2 ? -penY : penY;
      }
    }
  }

  /* ---------- Everybody ---------- */

  function onRound(d) {
    walls = buildMaze(d.seed);
    target = d.target;
    players = d.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score }));
    tanks = d.players.map((p) => ({ id: p.id, color: p.color, x: p.x, y: p.y, a: p.a, alive: true, reload: 0, held: true }));
    shells = [];
    snaps.clear();
    phase = "countdown";
    countdownEnd = performance.now() + COUNTDOWN * 1000;
    lastCount = -1;
    if (players.some((p) => p.id === room.myId)) LOBBY.hide();
    renderHud();
  }

  function onRoundOver(d) {
    const scores = new Map(d.scores);
    players.forEach((p) => {
      if (scores.has(p.id)) p.score = scores.get(p.id);
    });
    const w = players.find((p) => p.id === d.winner);
    ARC.banner(w ? w.name + " scores!" : "Nobody scores", 1600);
    renderHud();
  }

  function boom(x, y, color) {
    bursts.push({ x, y, color, at: performance.now() });
  }

  function renderHud() {
    if (!players.length) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = players.map((p) => {
      const t = tanks.find((x) => x.id === p.id);
      return { name: p.name, color: p.color, value: p.score, out: t && !t.alive, me: room && p.id === room.myId };
    });
    rows.push({ name: "First to", color: -1, value: target });
    ARC.scoreboard($("hud"), rows);
  }

  function update(dt) {
    if (!room) return;
    let s = "";
    if (ARC.input.held("up")) s += "u";
    if (ARC.input.held("down")) s += "d";
    if (ARC.input.held("left")) s += "l";
    if (ARC.input.held("right")) s += "r";
    if (ARC.input.held("action")) s += "f";
    if (room.isHost) {
      inputs[room.myId] = parseInput(s);
      if (match) hostUpdate(dt);
    } else {
      inputAge += dt;
      if (s !== myInput || inputAge > 0.25) {
        room.send("tk.in", s);
        myInput = s;
        inputAge = 0;
      }
    }
  }

  // What to draw this frame. The host blends between its own last two steps; guests blend
  // between the host's updates. Both happen per screen frame, so any refresh rate looks smooth.
  function frameState(alpha) {
    if (room && room.isHost) {
      return {
        tanks: tanks.map((t) => ({
          id: t.id,
          color: t.color,
          alive: t.alive,
          x: ARC.lerp(t.px ?? t.x, t.x, alpha),
          y: ARC.lerp(t.py ?? t.y, t.y, alpha),
          a: ARC.lerpAngle(t.pa ?? t.a, t.a, alpha),
        })),
        shells: shells.map((sh) => ({ x: ARC.lerp(sh.px ?? sh.x, sh.x, alpha), y: ARC.lerp(sh.py ?? sh.y, sh.y, alpha) })),
      };
    }
    const sm = snaps.sample();
    if (!sm) return { tanks, shells: [] };
    sm.b.t.forEach((b, i) => {
      const t = tanks[i];
      const a = sm.a.t[i] || b;
      if (!t) return;
      t.x = ARC.lerp(a[0], b[0], sm.t);
      t.y = ARC.lerp(a[1], b[1], sm.t);
      t.a = ARC.lerpAngle(a[2], b[2], sm.t);
      if (t.alive !== !!b[3]) {
        t.alive = !!b[3];
        renderHud();
      }
    });
    const prev = new Map(sm.a.s.map((x) => [x[0], x]));
    return {
      tanks,
      shells: sm.b.s.map((b) => {
        const a = prev.get(b[0]) || b;
        return { x: ARC.lerp(a[1], b[1], sm.t), y: ARC.lerp(a[2], b[2], sm.t) };
      }),
    };
  }

  /* ---------- Drawing ---------- */

  function draw(alpha) {
    const ctx = view.begin();
    const c = ARC.colors;
    const seen = frameState(alpha || 0);
    ctx.fillStyle = c.dark ? "#1b1c20" : "#f6f7f9";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = c.dark ? "#202126" : "#eceef2";
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) if ((r + col) % 2) ctx.fillRect(col * CELL, r * CELL, CELL, CELL);
    }
    ctx.fillStyle = c.dark ? "#6b6e78" : "#4a4d55";
    walls.forEach((w) => ctx.fillRect(w.x, w.y, w.w, w.h));

    ctx.fillStyle = c.dark ? "#f2f2f3" : "#1a1a1b";
    seen.shells.forEach((s) => {
      ctx.beginPath();
      ctx.arc(s.x, s.y, SHELL_R, 0, Math.PI * 2);
      ctx.fill();
    });

    seen.tanks.forEach((t) => {
      if (!t.alive) return;
      drawTank(ctx, t, NET.color(t.color), c.dark);
      if (phase === "countdown") {
        const p = players.find((x) => x.id === t.id);
        ctx.fillStyle = c.text;
        ctx.font = "700 13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(room && t.id === room.myId ? "You" : p ? p.name : "", t.x, t.y - 22);
      }
    });

    const now = performance.now();
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      const age = (now - b.at) / 600;
      if (age >= 1) {
        bursts.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = NET.color(b.color);
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(b.x + Math.cos(ang) * age * 34, b.y + Math.sin(ang) * age * 34, 5 * (1 - age) + 1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    if (phase === "countdown") {
      const left = Math.ceil((countdownEnd - now) / 1000);
      if (left !== lastCount) {
        lastCount = left;
        ARC.banner(left > 0 ? String(left) : "Go!", left > 0 ? 0 : 600);
      }
    }
  }

  function drawTank(ctx, t, color, dark) {
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.a);
    ctx.fillStyle = dark ? "#0e0e10" : "#2a2b30";
    ctx.fillRect(-14, -12, 28, 5);
    ctx.fillRect(-14, 7, 28, 5);
    ctx.fillStyle = color;
    ctx.fillRect(-12, -9, 24, 18);
    ctx.fillRect(0, -2.5, 19, 5);
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fill();
    ctx.restore();
  }
})();
