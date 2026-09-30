// Platformer engine shared by the game and the Map Maker: level parsing, physics and drawing.
// Levels are rows of characters, one per 32-pixel tile:
//   .  empty           #  wall              =  one-way platform (drop through with ↓)
//   ^  spikes          *  spring            S  spawn point
//   G  exit / finish   F  checkpoint        k  key (co-op: carry it to the exit)
//   a b c  switches that hold the matching door  A B C  open while pressed
(function () {
  "use strict";

  const T = 32;
  const PW = 22; // player hitbox
  const PH = 28;

  const GRAVITY = 2000;
  const MAX_FALL = 900;
  const RUN = 260;
  const ACCEL_GROUND = 2600;
  const ACCEL_AIR = 1700;
  const FRICTION = 2800;
  const AIR_DRAG = 500;
  const JUMP = 680; // ≈ 3.6 tiles high: 3 tiles alone, 4 standing on a friend's head
  const JUMP_CUT = 240;
  const SPRING = 1010; // ≈ 8 tiles
  const COYOTE = 0.08;
  const BUFFER = 0.1;
  const MAX_SPEED = 1700;

  const TILES = {
    ".": "Empty",
    "#": "Wall",
    "=": "Platform",
    "^": "Spikes",
    "*": "Spring",
    S: "Spawn",
    G: "Exit",
    F: "Checkpoint",
    k: "Key",
    a: "Switch A",
    b: "Switch B",
    c: "Switch C",
    A: "Door A",
    B: "Door B",
    C: "Door C",
  };

  const SWITCH_COLORS = { a: "#9a5bd6", b: "#e58f34", c: "#2bb3a3" };

  /* ---------- Levels ---------- */

  // level: { name, mode, rows: [string] } → map with the tiles and the interesting spots
  function parse(level) {
    const rows = level.rows.map((r) => String(r));
    const w = Math.max(...rows.map((r) => r.length));
    const h = rows.length;
    const grid = rows.map((r) => r.padEnd(w, ".").split("").map((ch) => (ch in TILES ? ch : ".")));
    const map = {
      name: level.name || "Untitled",
      mode: level.mode || "coop",
      w,
      h,
      pw: w * T,
      ph: h * T,
      grid,
      spawns: [],
      flags: [],
      goals: [],
      keys: [],
      switches: [],
      doors: {},
    };
    grid.forEach((row, r) => {
      row.forEach((ch, c) => {
        if (ch === "S") map.spawns.push({ x: c * T + (T - PW) / 2, y: (r + 1) * T - PH });
        else if (ch === "F") map.flags.push({ c, r });
        else if (ch === "G") map.goals.push({ c, r });
        else if (ch === "k") map.keys.push({ x: c * T + T / 2, y: r * T + T / 2 });
        else if (ch === "a" || ch === "b" || ch === "c") map.switches.push({ c, r, id: ch });
        else if (ch === "A" || ch === "B" || ch === "C") map.doors[ch.toLowerCase()] = true;
      });
    });
    if (!map.spawns.length) map.spawns.push({ x: T + (T - PW) / 2, y: T });
    return map;
  }

  // Outside the map: open sky above and below; walls at the sides, except in a brawl
  // arena, where getting knocked off the side is the whole point.
  function at(map, c, r) {
    if (r < 0 || r >= map.h) return ".";
    if (c < 0 || c >= map.w) return map.mode === "brawl" ? "." : "#";
    return map.grid[r][c];
  }

  // world.open: { a: true } — doors whose switch is held
  function solid(map, world, c, r) {
    const ch = at(map, c, r);
    if (ch === "#" || ch === "*") return true;
    if (ch === "A" || ch === "B" || ch === "C") return !(world && world.open && world.open[ch.toLowerCase()]);
    return false;
  }

  // Map Maker checks: returns a list of problems (empty when the level is fine to play).
  function problems(level) {
    const map = parse(level);
    const list = [];
    const count = (ch) => map.grid.reduce((n, row) => n + row.filter((x) => x === ch).length, 0);
    if (!count("S")) list.push("Place at least one spawn point (S).");
    if (map.mode !== "brawl" && !count("G")) list.push("Place an exit (G) so the level can be finished.");
    if (map.mode === "brawl" && count("S") < 2) list.push("A brawl arena needs at least two spawn points.");
    ["a", "b", "c"].forEach((s) => {
      if (count(s) && !count(s.toUpperCase())) list.push("Switch " + s.toUpperCase() + " has no door.");
      if (!count(s) && count(s.toUpperCase())) list.push("Door " + s.toUpperCase() + " has no switch — it never opens.");
    });
    return list;
  }

  /* ---------- Players ---------- */

  function makePlayer(spawn) {
    return {
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      w: PW,
      h: PH,
      face: 1,
      ground: false,
      coyote: 0,
      buffer: 0,
      jumping: false,
      stun: 0,
      standOn: null,
    };
  }

  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // One 1/60 s step for the local player.
  // inp: { left, right, jump, jumpHit, down }; others: [{ x, y, w, h, dx, dy }] (players you can stand on)
  // Returns what happened: { died, sprang, jumped, landed }
  function step(p, inp, map, world, others, dt, opts) {
    const ev = {};
    const o = opts || {};
    let dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    if (p.stun > 0) {
      p.stun -= dt;
      dir = 0;
    }

    // run (o.run speeds somebody up, e.g. whoever is "it" in Tag)
    const accel = p.ground ? ACCEL_GROUND : ACCEL_AIR;
    const run = RUN * (o.run || 1);
    if (dir) {
      p.face = dir;
      if (Math.sign(p.vx) !== dir || Math.abs(p.vx) < run) {
        p.vx += dir * accel * dt;
        if (Math.abs(p.vx) > run && Math.sign(p.vx) === dir) p.vx = dir * run;
      } else {
        p.vx -= Math.sign(p.vx) * AIR_DRAG * dt; // coming down from a knock-back
      }
    } else {
      const drag = (p.ground ? FRICTION : AIR_DRAG) * dt;
      p.vx = Math.abs(p.vx) <= drag ? 0 : p.vx - Math.sign(p.vx) * drag;
    }

    // jump, with a little forgiveness on both ends
    p.coyote = p.ground ? COYOTE : p.coyote - dt;
    p.buffer = inp.jumpHit ? BUFFER : p.buffer - dt;
    if (p.buffer > 0 && p.coyote > 0 && p.stun <= 0) {
      p.vy = -JUMP;
      p.buffer = 0;
      p.coyote = 0;
      p.ground = false;
      p.jumping = true;
      ev.jumped = true;
    }
    if (p.jumping && !inp.jump && p.vy < -JUMP_CUT) p.vy = -JUMP_CUT;
    if (p.vy >= 0) p.jumping = false;

    p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL + (p.stun > 0 ? 600 : 0));
    p.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, p.vx));
    p.vy = Math.max(-MAX_SPEED, p.vy);

    // riding on top of another player
    if (p.standOn) {
      p.x += p.standOn.dx || 0;
    }

    // doors that close on you do not trap you
    const skip = doorsInside(p, map, world);

    p.x += p.vx * dt;
    collideX(p, map, world, skip);

    const prevBottom = p.y + p.h;
    const wasGround = p.ground;
    p.ground = false;
    p.standOn = null;
    p.y += p.vy * dt;
    const hitTile = collideY(p, map, world, skip, prevBottom, inp.down);
    if (!p.ground && p.vy >= 0 && others) {
      for (const b of others) {
        if (p.x + p.w <= b.x + 2 || p.x >= b.x + b.w - 2) continue;
        // a little slack so a friend jumping underneath lifts you instead of passing through
        if (prevBottom <= b.y + 6 + Math.abs(b.dy || 0) && p.y + p.h >= b.y) {
          p.y = b.y - p.h;
          p.vy = 0;
          p.ground = true;
          p.standOn = b;
          break;
        }
      }
    }
    if (hitTile === "*") {
      p.vy = -SPRING;
      p.ground = false;
      p.jumping = false;
      ev.sprang = true;
    }
    if (p.ground && !wasGround) ev.landed = true;

    // a gentle nudge when running into another player (race) — enough to jostle, never enough to block
    if (o.shove && others) {
      for (const b of others) {
        if (!overlap(p, b) || p.standOn === b) continue;
        const push = p.x + p.w / 2 < b.x + b.w / 2 ? -1 : 1;
        p.x += push * 0.7;
        if (insideWall(p, map, world)) p.x -= push * 0.7;
      }
    }

    if (touchesSpikes(p, map) || p.y > map.ph + 40 || (o.bounds && outOfBounds(p, map))) ev.died = true;
    return ev;
  }

  function doorsInside(p, map, world) {
    const skip = new Set();
    const c0 = Math.floor(p.x / T);
    const c1 = Math.floor((p.x + p.w - 0.01) / T);
    const r0 = Math.floor(p.y / T);
    const r1 = Math.floor((p.y + p.h - 0.01) / T);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const ch = at(map, c, r);
        if ((ch === "A" || ch === "B" || ch === "C") && solid(map, world, c, r)) skip.add(c + "," + r);
      }
    }
    return skip;
  }

  function insideWall(p, map, world) {
    const c0 = Math.floor(p.x / T);
    const c1 = Math.floor((p.x + p.w - 0.01) / T);
    const r0 = Math.floor(p.y / T);
    const r1 = Math.floor((p.y + p.h - 0.01) / T);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) if (solid(map, world, c, r)) return true;
    }
    return false;
  }

  function blocked(map, world, skip, c, r) {
    return solid(map, world, c, r) && !skip.has(c + "," + r);
  }

  function collideX(p, map, world, skip) {
    const r0 = Math.floor(p.y / T);
    const r1 = Math.floor((p.y + p.h - 0.01) / T);
    if (p.vx > 0) {
      const c = Math.floor((p.x + p.w - 0.01) / T);
      for (let r = r0; r <= r1; r++) {
        if (blocked(map, world, skip, c, r)) {
          p.x = c * T - p.w;
          p.vx = 0;
          return;
        }
      }
    } else if (p.vx < 0) {
      const c = Math.floor(p.x / T);
      for (let r = r0; r <= r1; r++) {
        if (blocked(map, world, skip, c, r)) {
          p.x = (c + 1) * T;
          p.vx = 0;
          return;
        }
      }
    }
  }

  function collideY(p, map, world, skip, prevBottom, dropping) {
    const c0 = Math.floor(p.x / T);
    const c1 = Math.floor((p.x + p.w - 0.01) / T);
    if (p.vy > 0) {
      const r = Math.floor((p.y + p.h - 0.01) / T);
      let hit = null;
      for (let c = c0; c <= c1; c++) {
        const ch = at(map, c, r);
        const oneWay = ch === "=" && !dropping && prevBottom <= r * T + 0.5;
        if (blocked(map, world, skip, c, r) || oneWay) {
          hit = hit === "*" ? hit : ch;
        }
      }
      if (hit) {
        p.y = r * T - p.h;
        p.vy = 0;
        p.ground = true;
        return hit;
      }
    } else if (p.vy < 0) {
      const r = Math.floor(p.y / T);
      for (let c = c0; c <= c1; c++) {
        if (blocked(map, world, skip, c, r)) {
          p.y = (r + 1) * T;
          p.vy = 0;
          return null;
        }
      }
    }
    return null;
  }

  function touchesSpikes(p, map) {
    const c0 = Math.floor(p.x / T);
    const c1 = Math.floor((p.x + p.w - 0.01) / T);
    const r0 = Math.floor(p.y / T);
    const r1 = Math.floor((p.y + p.h - 0.01) / T);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (at(map, c, r) !== "^") continue;
        const box = { x: c * T + 5, y: r * T + 16, w: T - 10, h: T - 16 };
        if (overlap(p, box)) return true;
      }
    }
    return false;
  }

  function outOfBounds(p, map) {
    return p.x < -T * 4 || p.x > map.pw + T * 4 || p.y < -T * 8;
  }

  // Tiles of a kind the box touches, e.g. touching(p, map, "G")
  function touching(p, map, kind) {
    const c0 = Math.floor(p.x / T);
    const c1 = Math.floor((p.x + p.w - 0.01) / T);
    const r0 = Math.floor(p.y / T);
    const r1 = Math.floor((p.y + p.h - 0.01) / T);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) if (at(map, c, r) === kind) return { c, r };
    }
    return null;
  }

  // Which switches are held down by any of the boxes → { a: true, … }
  function pressed(map, boxes) {
    const open = {};
    map.switches.forEach((s) => {
      const plate = { x: s.c * T + 2, y: s.r * T + T - 10, w: T - 4, h: 10 };
      if (boxes.some((b) => overlap(b, plate))) open[s.id] = true;
    });
    return open;
  }

  /* ---------- Drawing ---------- */

  function palette(dark) {
    return dark
      ? { sky: "#17181c", grid: "#1d1e23", block: "#34363e", edge: "#50535f", plat: "#a8743f", spike: "#9aa0a6", ink: "#f2f2f3" }
      : { sky: "#eef2f7", grid: "#e4e9f0", block: "#c3cad4", edge: "#98a3b2", plat: "#b07a45", spike: "#7d858f", ink: "#1a1a1b" };
  }

  // Draws every tile inside the camera rectangle. world: { open, unlocked, flagsHit: Set("c,r") }
  function drawTiles(ctx, map, world, cam, dark, editor) {
    const pal = palette(dark);
    const c0 = Math.max(0, Math.floor(cam.x / T));
    const c1 = Math.min(map.w - 1, Math.floor((cam.x + cam.w) / T));
    const r0 = Math.max(0, Math.floor(cam.y / T));
    const r1 = Math.min(map.h - 1, Math.floor((cam.y + cam.h) / T));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const ch = map.grid[r][c];
        if (ch === ".") continue;
        drawTile(ctx, ch, c * T, r * T, map, world, pal, c, r, editor);
      }
    }
  }

  function drawTile(ctx, ch, x, y, map, world, pal, c, r, editor) {
    switch (ch) {
      case "#": {
        ctx.fillStyle = pal.block;
        ctx.fillRect(x, y, T, T);
        if (map && at(map, c, r - 1) !== "#") {
          ctx.fillStyle = pal.edge;
          ctx.fillRect(x, y, T, 5);
        }
        break;
      }
      case "=":
        ctx.fillStyle = pal.plat;
        ctx.fillRect(x, y, T, 8);
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.fillRect(x, y + 6, T, 2);
        ctx.fillRect(x + T - 2, y, 2, 8);
        break;
      case "^":
        ctx.fillStyle = pal.spike;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const sx = x + 2 + i * 9.4;
          ctx.moveTo(sx, y + T);
          ctx.lineTo(sx + 4.7, y + 13);
          ctx.lineTo(sx + 9.4, y + T);
        }
        ctx.fill();
        break;
      case "*":
        ctx.fillStyle = pal.block;
        ctx.fillRect(x, y + 14, T, T - 14);
        ctx.strokeStyle = pal.spike;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x + 8, y + 22);
        ctx.lineTo(x + 24, y + 17);
        ctx.moveTo(x + 8, y + 16);
        ctx.lineTo(x + 24, y + 11);
        ctx.stroke();
        ctx.fillStyle = "#f0c419";
        ctx.fillRect(x + 3, y + 4, T - 6, 6);
        break;
      case "a":
      case "b":
      case "c": {
        const down = world && world.open && world.open[ch];
        ctx.fillStyle = SWITCH_COLORS[ch];
        ctx.fillRect(x + 4, y + T - (down ? 3 : 7), T - 8, down ? 3 : 7);
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillRect(x + 2, y + T - 2, T - 4, 2);
        break;
      }
      case "A":
      case "B":
      case "C": {
        const col = SWITCH_COLORS[ch.toLowerCase()];
        const open = world && world.open && world.open[ch.toLowerCase()];
        if (open) {
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 2, y + 2, T - 4, T - 4);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = col;
          ctx.fillRect(x, y, T, T);
          ctx.fillStyle = "rgba(0,0,0,0.2)";
          ctx.fillRect(x + 6, y, 4, T);
          ctx.fillRect(x + 22, y, 4, T);
        }
        break;
      }
      case "G": {
        const race = map && map.mode === "race";
        if (race) {
          drawFinish(ctx, x, y, map, c, r);
        } else {
          const locked = map && map.keys.length && !(world && world.unlocked);
          ctx.fillStyle = locked ? "#6b4f2a" : "#3d7a37";
          ctx.fillRect(x + 1, y, T - 2, T);
          ctx.fillStyle = locked ? "#4a3620" : "#15230f";
          ctx.fillRect(x + 5, y + 4, T - 10, T - 4);
          if (locked && (!map || at(map, c, r + 1) !== "G")) {
            ctx.fillStyle = "#f0c419";
            ctx.beginPath();
            ctx.arc(x + T / 2, y + 14, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillRect(x + T / 2 - 2, y + 16, 4, 9);
          }
        }
        break;
      }
      case "F": {
        const hit = world && world.flagsHit && world.flagsHit.has(c + "," + r);
        ctx.fillStyle = pal.spike;
        ctx.fillRect(x + 8, y + 2, 3, T - 2);
        ctx.fillStyle = hit ? "#57a05a" : "#9aa0a6";
        ctx.beginPath();
        ctx.moveTo(x + 11, y + 3);
        ctx.lineTo(x + 27, y + 9);
        ctx.lineTo(x + 11, y + 15);
        ctx.fill();
        break;
      }
      case "k":
        if (editor) drawKey(ctx, x + T / 2, y + T / 2);
        break;
      case "S":
        if (editor) {
          ctx.strokeStyle = pal.ink;
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(x + (T - PW) / 2, y + T - PH, PW, PH);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          ctx.fillStyle = pal.ink;
          ctx.font = "700 12px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("S", x + T / 2, y + T - 9);
        }
        break;
    }
  }

  function drawFinish(ctx, x, y) {
    const s = 8;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        ctx.fillStyle = (i + j) % 2 ? "#1a1a1b" : "#ffffff";
        ctx.fillRect(x + i * s, y + j * s, s, s);
      }
    }
  }

  function drawKey(ctx, x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "#f0c419";
    ctx.strokeStyle = "#8a6d00";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(-6, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(-1, -2, 13, 4);
    ctx.fillRect(7, 2, 3, 5);
    ctx.fillRect(3, 2, 3, 4);
    ctx.fillStyle = "#8a6d00";
    ctx.beginPath();
    ctx.arc(-6, 0, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // p: { x, y, w, h, face } ; o: { color, name, alpha, attack, label, key, dark }
  function drawPlayer(ctx, p, o) {
    // not rounded: with a scaled canvas, whole game pixels would make movement step
    const x = p.x;
    const y = p.y;
    ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
    ctx.fillStyle = o.color;
    roundRect(ctx, x, y, PW, PH, 6);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(x + 3, y + PH - 5, PW - 6, 3);
    // eyes look where you are heading
    const ex = x + PW / 2 + p.face * 3;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ex - 4, y + 10, 3.4, 0, Math.PI * 2);
    ctx.arc(ex + 4, y + 10, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1a1b";
    ctx.beginPath();
    ctx.arc(ex - 4 + p.face * 1.3, y + 10.5, 1.7, 0, Math.PI * 2);
    ctx.arc(ex + 4 + p.face * 1.3, y + 10.5, 1.7, 0, Math.PI * 2);
    ctx.fill();

    if (o.attack) {
      // a quick swoosh in front
      ctx.strokeStyle = o.dark ? "#fff" : "#1a1a1b";
      ctx.lineWidth = 3;
      ctx.beginPath();
      const cx = x + PW / 2 + p.face * 16;
      const mid = p.face > 0 ? 0 : Math.PI;
      ctx.arc(cx, y + PH / 2, 16, mid - 1.1, mid + 1.1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (o.key) drawKey(ctx, x + PW / 2 + 2, y - 10);
    if (o.label) {
      ctx.font = "700 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = o.dark ? "#f2f2f3" : "#1a1a1b";
      ctx.fillText(o.label, x + PW / 2, y - (o.key ? 22 : 7));
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  window.PF = {
    T,
    PW,
    PH,
    TILES,
    SWITCH_COLORS,
    parse,
    problems,
    at,
    solid,
    makePlayer,
    step,
    overlap,
    touching,
    pressed,
    palette,
    drawTiles,
    drawTile,
    drawKey,
    drawPlayer,
  };
})();
