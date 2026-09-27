// Bomberman — drop bombs, break crates, catch the others in the blast. Last one standing wins the round.
// The host runs the game; guests send their keys and draw what the host sends back.
(function () {
  "use strict";

  const COLS = 15;
  const ROWS = 13;
  const S = 40; // tile size in pixels
  const W = COLS * S;
  const H = ROWS * S;
  const FUSE = 2.4;
  const FLAME_TIME = 0.5;
  const BASE_SPEED = 3.4; // tiles per second
  const DROP_CHANCE = 0.32;
  const COUNTDOWN = 2;
  const ROUND_PAUSE = 2;
  const CORNERS = [
    [1, 1],
    [COLS - 2, ROWS - 2],
    [COLS - 2, 1],
    [1, ROWS - 2],
  ];

  const $ = (id) => document.getElementById(id);
  const view = ARC.view($("game"), W, H);

  let room = null;
  // grid characters: '#' wall, '+' crate, '.' floor
  let grid = [];
  let people = []; // [{ id, name, color, wins, x, y, alive }]
  let bombs = []; // [{ c, r, … }]
  let flames = []; // [{ c, r }]
  let items = []; // [{ c, r, t }]  t: b | f | s
  let phase = "idle";
  let countdownEnd = 0;
  let lastCount = -1;
  let target = 3;
  const snaps = ARC.snapshots();

  // host only
  let match = null;
  let timer = 0;
  const inputs = {}; // id -> { dir: "", bomb: bool }
  let myDir = "";
  let inputAge = 0;

  LOBBY.init({
    game: "bomber",
    title: "Bomberman",
    blurb: "Drop bombs, blow up crates, grab power-ups and trap the others. 2–4 players.",
    settings: [
      {
        key: "target",
        label: "Rounds to win",
        value: 3,
        options: [
          { value: 2, label: "2" },
          { value: 3, label: "3" },
          { value: 5, label: "5" },
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
    room.on("bm.round", onRound);
    room.on("bm.go", () => (phase = "run"));
    room.on("bm.grid", (g) => (grid = g.split("")));
    room.on("bm.s", (d) => {
      if (!room.isHost) snaps.push(d, d.ts);
    });
    room.on("bm.over", onRoundOver);
    room.on("players", renderHud);
    if (room.isHost) {
      room.on("bm.in", (d, from) => {
        inputs[from] = inputs[from] || { dir: "", bomb: false };
        inputs[from].dir = String(d || "");
      });
      room.on("bm.bomb", (d, from) => {
        inputs[from] = inputs[from] || { dir: "", bomb: false };
        inputs[from].bomb = true;
      });
      room.on("leave", (p) => {
        if (!match) return;
        match.players = match.players.filter((m) => m.id !== p.id);
        const me = people.find((x) => x.id === p.id);
        if (me) me.alive = false;
      });
    }
  }

  const idx = (c, r) => r * COLS + c;

  /* ---------- Host ---------- */

  function startMatch(settings) {
    match = {
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, wins: 0 })),
      target: settings.target,
      started: room.players.length,
    };
    startRound();
  }

  function makeGrid() {
    const g = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const edge = r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1;
        const pillar = r % 2 === 0 && c % 2 === 0;
        g.push(edge || pillar ? "#" : Math.random() < 0.62 ? "+" : ".");
      }
    }
    // room to move around every corner
    CORNERS.forEach(([c, r]) => {
      const dc = c === 1 ? 1 : -1;
      const dr = r === 1 ? 1 : -1;
      [
        [c, r],
        [c + dc, r],
        [c, r + dr],
      ].forEach(([x, y]) => (g[idx(x, y)] = "."));
    });
    return g;
  }

  function startRound() {
    room.players.forEach((p) => {
      if (!match.players.some((m) => m.id === p.id)) match.players.push({ id: p.id, name: p.name, color: p.color, wins: 0 });
    });
    grid = makeGrid();
    const payload = {
      grid: grid.join(""),
      target: match.target,
      players: match.players.map((m, i) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        wins: m.wins,
        x: CORNERS[i % 4][0],
        y: CORNERS[i % 4][1],
      })),
    };
    room.send("bm.round", payload);
    onRound(payload);
    people.forEach((p) => {
      p.bombs = 1;
      p.range = 2;
      p.speed = BASE_SPEED;
    });
    Object.keys(inputs).forEach((k) => (inputs[k].bomb = false));
    timer = COUNTDOWN;
  }

  function hostUpdate(dt) {
    if (phase === "countdown") {
      timer -= dt;
      if (timer <= 0) {
        phase = "run";
        room.send("bm.go");
      }
      return;
    }
    if (phase === "pause") {
      timer -= dt;
      if (timer <= 0) finishRound();
    }
    if (phase !== "run" && phase !== "pause") return;

    // where everybody was before this step, so drawing can blend in between
    people.forEach((p) => {
      p.px = p.x;
      p.py = p.y;
    });

    let gridChanged = false;
    people.forEach((p) => {
      if (!p.alive) return;
      const inp = inputs[p.id] || { dir: "", bomb: false };
      move(p, inp.dir, dt);
      if (inp.bomb) {
        inp.bomb = false;
        dropBomb(p);
      }
      const it = items.findIndex((i) => i.c === Math.round(p.x) && i.r === Math.round(p.y));
      if (it >= 0) {
        const t = items[it].t;
        if (t === "b") p.bombs = Math.min(8, p.bombs + 1);
        if (t === "f") p.range = Math.min(10, p.range + 1);
        if (t === "s") p.speed = Math.min(BASE_SPEED + 2.4, p.speed + 0.6);
        items.splice(it, 1);
      }
    });

    bombs.forEach((b) => (b.fuse -= dt));
    // chain reactions: keep going while new bombs are caught in the blast
    let exploding = bombs.filter((b) => b.fuse <= 0);
    while (exploding.length) {
      const b = exploding.pop();
      if (!bombs.includes(b)) continue;
      bombs = bombs.filter((x) => x !== b);
      if (explode(b)) gridChanged = true;
      bombs.forEach((o) => {
        if (o.fuse > 0 && flames.some((f) => f.c === o.c && f.r === o.r)) {
          o.fuse = 0;
          exploding.push(o);
        }
      });
    }

    flames.forEach((f) => (f.t -= dt));
    flames = flames.filter((f) => f.t > 0);

    people.forEach((p) => {
      if (p.alive && flames.some((f) => f.c === Math.round(p.x) && f.r === Math.round(p.y))) p.alive = false;
    });

    if (gridChanged) room.send("bm.grid", grid.join(""));
    room.send("bm.s", snapshot()); // every step: 60 updates a second

    const alive = people.filter((p) => p.alive);
    if (phase === "run" && alive.length <= (people.length > 1 ? 1 : 0)) {
      phase = "pause";
      timer = ROUND_PAUSE;
    }
  }

  function blocked(c, r, p) {
    const ch = grid[idx(c, r)];
    if (ch === "#" || ch === "+") return true;
    // a bomb blocks, except the one you are still standing on
    return bombs.some((b) => b.c === c && b.r === r && !(p && Math.round(p.x) === c && Math.round(p.y) === r));
  }

  // Lane-based movement: you always walk along the middle of a row or column,
  // and turning a corner eases you onto the new lane.
  function move(p, dir, dt) {
    let dx = 0;
    let dy = 0;
    if (dir.includes("l")) dx = -1;
    else if (dir.includes("r")) dx = 1;
    else if (dir.includes("u")) dy = -1;
    else if (dir.includes("d")) dy = 1;
    if (!dx && !dy) return;
    let step = p.speed * dt;
    const cc = Math.round(p.x);
    const cr = Math.round(p.y);
    if (dx) {
      const off = p.y - cr;
      if (Math.abs(off) > 0.001) {
        if (blocked(cc + dx, cr, p)) return;
        const fix = Math.min(Math.abs(off), step);
        p.y -= Math.sign(off) * fix;
        step -= fix;
      }
      const nx = p.x + dx * step;
      p.x = blocked(cc + dx, cr, p) ? (dx > 0 ? Math.min(nx, cc) : Math.max(nx, cc)) : nx;
    } else {
      const off = p.x - cc;
      if (Math.abs(off) > 0.001) {
        if (blocked(cc, cr + dy, p)) return;
        const fix = Math.min(Math.abs(off), step);
        p.x -= Math.sign(off) * fix;
        step -= fix;
      }
      const ny = p.y + dy * step;
      p.y = blocked(cc, cr + dy, p) ? (dy > 0 ? Math.min(ny, cr) : Math.max(ny, cr)) : ny;
    }
  }

  function dropBomb(p) {
    const c = Math.round(p.x);
    const r = Math.round(p.y);
    if (bombs.some((b) => b.c === c && b.r === r)) return;
    if (bombs.filter((b) => b.owner === p.id).length >= p.bombs) return;
    bombs.push({ c, r, owner: p.id, range: p.range, fuse: FUSE });
  }

  // Returns true when crates were destroyed.
  function explode(b) {
    let broke = false;
    const born = [];
    const burn = (c, r) => {
      flames = flames.filter((f) => !(f.c === c && f.r === r));
      flames.push({ c, r, t: FLAME_TIME });
      items = items.filter((i) => !(i.c === c && i.r === r) || born.includes(i));
    };
    burn(b.c, b.r);
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].forEach(([dc, dr]) => {
      for (let k = 1; k <= b.range; k++) {
        const c = b.c + dc * k;
        const r = b.r + dr * k;
        const ch = grid[idx(c, r)];
        if (ch === "#") break;
        burn(c, r);
        if (ch === "+") {
          grid[idx(c, r)] = ".";
          broke = true;
          if (Math.random() < DROP_CHANCE) {
            const item = { c, r, t: "bfs"[Math.floor(Math.random() * 3)] };
            items.push(item);
            born.push(item);
          }
          break;
        }
        if (bombs.some((o) => o.c === c && o.r === r)) break;
      }
    });
    return broke;
  }

  function snapshot() {
    return {
      ts: Math.round(performance.now() * 10) / 10,
      p: people.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, p.alive ? 1 : 0]),
      b: bombs.map((b) => [b.c, b.r, Math.round(b.fuse * 10)]),
      f: flames.map((f) => [f.c, f.r]),
      i: items.map((i) => [i.c, i.r, i.t]),
    };
  }

  function finishRound() {
    const alive = people.filter((p) => p.alive);
    let winner = null;
    if (alive.length === 1 && people.length > 1) {
      winner = match.players.find((m) => m.id === alive[0].id) || null;
      if (winner) winner.wins++;
    }
    const d = { winner: winner ? winner.id : null, wins: match.players.map((m) => [m.id, m.wins]) };
    room.send("bm.over", d);
    onRoundOver(d);
    const ranked = match.players.slice().sort((a, b) => b.wins - a.wins);
    const lonely = match.started > 1 && match.players.length < 2;
    phase = "between";
    if ((ranked.length && ranked[0].wins >= match.target) || lonely) {
      const rows = ranked.map((p) => ({ name: p.name, color: p.color, value: p.wins + (p.wins === 1 ? " round" : " rounds") }));
      setTimeout(() => {
        phase = "idle";
        match = null;
        LOBBY.results(rows, ranked[0].name + " wins!");
      }, 1500);
      return;
    }
    setTimeout(() => {
      if (match) startRound();
    }, 1500);
  }

  /* ---------- Everybody ---------- */

  function onRound(d) {
    grid = d.grid.split("");
    target = d.target;
    people = d.players.map((p) => Object.assign({}, p, { alive: true }));
    bombs = [];
    flames = [];
    items = [];
    snaps.clear();
    phase = "countdown";
    countdownEnd = performance.now() + COUNTDOWN * 1000;
    lastCount = -1;
    if (people.some((p) => p.id === room.myId)) LOBBY.hide();
    renderHud();
  }

  function onRoundOver(d) {
    const wins = new Map(d.wins);
    people.forEach((p) => {
      if (wins.has(p.id)) p.wins = wins.get(p.id);
    });
    const w = people.find((p) => p.id === d.winner);
    ARC.banner(w ? w.name + " wins the round" : "Draw!", 1600);
    renderHud();
  }

  function renderHud() {
    if (!people.length) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = people.map((p) => ({
      name: p.name,
      color: p.color,
      value: "★".repeat(p.wins || 0) || "0",
      out: !p.alive,
      me: room && p.id === room.myId,
    }));
    rows.push({ name: "Rounds to win", color: -1, value: target });
    ARC.scoreboard($("hud"), rows);
  }

  let bombHeld = false;
  function update(dt) {
    if (!room) return;
    let dir = "";
    // the most recently useful single direction
    if (ARC.input.held("up")) dir = "u";
    else if (ARC.input.held("down")) dir = "d";
    if (ARC.input.held("left")) dir = "l" + dir;
    else if (ARC.input.held("right")) dir = "r" + dir;
    dir = pickDir(dir);
    const bomb = ARC.input.held("action");
    const bombNow = bomb && !bombHeld;
    bombHeld = bomb;

    if (room.isHost) {
      inputs[room.myId] = inputs[room.myId] || { dir: "", bomb: false };
      inputs[room.myId].dir = dir;
      if (bombNow && phase === "run") inputs[room.myId].bomb = true;
      if (match) hostUpdate(dt);
    } else {
      inputAge += dt;
      if (dir !== myDir || inputAge > 0.25) {
        room.send("bm.in", dir);
        myDir = dir;
        inputAge = 0;
      }
      if (bombNow && phase === "run") room.send("bm.bomb");
    }
    if (room.isHost) {
      people.forEach((p) => {
        if (p.alive === false && !p.hudOut) {
          p.hudOut = true;
          renderHud();
        }
      });
    }
  }

  // When two directions are held, prefer the one pressed last — here: keep the previous if still held.
  let lastDir = "";
  function pickDir(held) {
    if (!held) {
      lastDir = "";
      return "";
    }
    const options = held.split("");
    if (options.length === 1) {
      lastDir = options[0];
      return lastDir;
    }
    // two directions: the newer one wins, so turning corners feels natural
    const fresh = options.find((d) => d !== lastDir) || options[0];
    lastDir = fresh;
    return fresh;
  }

  /* ---------- Drawing ---------- */

  // Who stands where this frame. The host blends between its own last two steps; guests blend
  // between the host's updates (and take bombs, flames and items from the same moment).
  function framePeople(alpha) {
    if (room && room.isHost) {
      return people.map((p) => Object.assign({}, p, { x: ARC.lerp(p.px ?? p.x, p.x, alpha), y: ARC.lerp(p.py ?? p.y, p.y, alpha) }));
    }
    const sm = snaps.sample();
    if (!sm) return people;
    sm.b.p.forEach((b, i) => {
      const p = people[i];
      if (!p) return;
      const a = sm.a.p[i] || b;
      p.x = ARC.lerp(a[0], b[0], sm.t);
      p.y = ARC.lerp(a[1], b[1], sm.t);
      if (p.alive !== !!b[2]) {
        p.alive = !!b[2];
        renderHud();
      }
    });
    bombs = sm.b.b.map((b) => ({ c: b[0], r: b[1], fuse: b[2] / 10 }));
    flames = sm.b.f.map((f) => ({ c: f[0], r: f[1] }));
    items = sm.b.i.map((i) => ({ c: i[0], r: i[1], t: i[2] }));
    return people;
  }

  function draw(alpha) {
    const shown = framePeople(alpha || 0);
    const ctx = view.begin();
    const dark = ARC.colors.dark;
    ctx.fillStyle = dark ? "#1f2a1f" : "#cfe6c4";
    ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = grid[idx(c, r)];
        const x = c * S;
        const y = r * S;
        if (ch === "#") {
          ctx.fillStyle = dark ? "#4a4d57" : "#7c8290";
          ctx.fillRect(x, y, S, S);
          ctx.fillStyle = dark ? "#5c606b" : "#959aa6";
          ctx.fillRect(x, y, S, 5);
        } else if (ch === "+") {
          ctx.fillStyle = "#b07a45";
          ctx.fillRect(x + 1, y + 1, S - 2, S - 2);
          ctx.strokeStyle = "#7d5329";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 4, y + 4, S - 8, S - 8);
          ctx.beginPath();
          ctx.moveTo(x + 5, y + 5);
          ctx.lineTo(x + S - 5, y + S - 5);
          ctx.stroke();
        } else if ((r + c) % 2) {
          ctx.fillStyle = dark ? "#223022" : "#c6dfba";
          ctx.fillRect(x, y, S, S);
        }
      }
    }

    items.forEach((i) => drawItem(ctx, i));

    const now = performance.now();
    bombs.forEach((b) => {
      const pulse = 1 + Math.sin(now / (b.fuse < 0.8 ? 60 : 140)) * 0.07;
      const x = b.c * S + S / 2;
      const y = b.r * S + S / 2;
      ctx.fillStyle = "#1a1a1b";
      ctx.beginPath();
      ctx.arc(x, y + 2, 13 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(x - 4, y - 3, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#8a6d00";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 6, y - 8);
      ctx.quadraticCurveTo(x + 10, y - 16, x + 14, y - 14);
      ctx.stroke();
      ctx.fillStyle = Math.floor(now / 90) % 2 ? "#f0c419" : "#e05c4a";
      ctx.beginPath();
      ctx.arc(x + 14, y - 14, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    flames.forEach((f) => {
      const x = f.c * S;
      const y = f.r * S;
      ctx.fillStyle = "#e58f34";
      ctx.fillRect(x + 2, y + 2, S - 4, S - 4);
      ctx.fillStyle = "#f0c419";
      ctx.fillRect(x + 9, y + 9, S - 18, S - 18);
    });

    shown.forEach((p) => {
      if (!p.alive) return;
      drawPlayer(ctx, p, NET.color(p.color));
      if (phase === "countdown") {
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#1a1a1b";
        ctx.lineWidth = 3;
        ctx.font = "700 13px system-ui, sans-serif";
        ctx.textAlign = "center";
        const label = room && p.id === room.myId ? "You" : p.name;
        ctx.strokeText(label, p.x * S + S / 2, p.y * S - 4);
        ctx.fillText(label, p.x * S + S / 2, p.y * S - 4);
      }
    });

    if (phase === "countdown") {
      const left = Math.ceil((countdownEnd - now) / 1000);
      if (left !== lastCount) {
        lastCount = left;
        ARC.banner(left > 0 ? String(left) : "Go!", left > 0 ? 0 : 600);
      }
    }
  }

  function drawPlayer(ctx, p, color) {
    const x = p.x * S + S / 2;
    const y = p.y * S + S / 2;
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath();
    ctx.ellipse(x, y + 14, 11, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y - 1, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x - 4.5, y - 3, 3.6, 0, Math.PI * 2);
    ctx.arc(x + 4.5, y - 3, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1a1b";
    ctx.beginPath();
    ctx.arc(x - 4.5, y - 2.5, 1.8, 0, Math.PI * 2);
    ctx.arc(x + 4.5, y - 2.5, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawItem(ctx, i) {
    const x = i.c * S + S / 2;
    const y = i.r * S + S / 2;
    ctx.fillStyle = i.t === "b" ? "#2f6fde" : i.t === "f" ? "#e05c4a" : "#57a05a";
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.fillStyle = "#fff";
    ctx.lineWidth = 2.2;
    if (i.t === "b") {
      ctx.beginPath();
      ctx.arc(x - 1, y + 2, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + 3, y - 3);
      ctx.lineTo(x + 7, y - 7);
      ctx.stroke();
    } else if (i.t === "f") {
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.quadraticCurveTo(x + 9, y, x, y + 8);
      ctx.quadraticCurveTo(x - 9, y, x, y - 9);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x + 2, y - 9);
      ctx.lineTo(x - 5, y + 1);
      ctx.lineTo(x, y + 1);
      ctx.lineTo(x - 2, y + 9);
      ctx.lineTo(x + 5, y - 1);
      ctx.lineTo(x, y - 1);
      ctx.closePath();
      ctx.fill();
    }
  }
})();
