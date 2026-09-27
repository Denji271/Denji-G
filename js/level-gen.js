// Level generator for the platformer: race courses, co-op puzzles and brawl arenas from a seed.
// Nothing leaves this file untested: a little robot plays every generated level with the real
// physics first (solve), and a level it cannot finish is thrown away and rolled again.
(function () {
  "use strict";

  const T = PF.T;
  const DT = 1 / 60;
  const LEVELS = 50; // numbered levels per game

  /* ---------- Building blocks ---------- */

  // Levels are built column by column: floor[c] is the row of the top floor tile (null = a pit),
  // everything below it is solid. Walls, spikes, platforms and the like go on top as extras.
  function Builder(height) {
    this.H = height;
    this.floor = [];
    this.extra = [];
  }
  Builder.prototype.add = function (n, row) {
    const start = this.floor.length;
    for (let i = 0; i < n; i++) this.floor.push(row);
    return start;
  };
  Builder.prototype.put = function (c, r, ch) {
    this.extra.push([c, r, ch]);
  };
  Builder.prototype.column = function (c, r0, r1, ch) {
    for (let r = r0; r <= r1; r++) this.put(c, r, ch);
  };
  Builder.prototype.rows = function () {
    const W = this.floor.length;
    const g = [];
    for (let r = 0; r < this.H; r++) g.push(new Array(W).fill("."));
    this.floor.forEach((top, c) => {
      if (top === null) return;
      for (let r = top; r < this.H; r++) g[r][c] = "#";
    });
    this.extra.forEach(([c, r, ch]) => {
      if (r >= 0 && r < this.H && c >= 0 && c < W) g[r][c] = ch;
    });
    for (let c = 0; c < W; c++) g[0][c] = "#";
    for (let r = 0; r < this.H; r++) {
      g[r][0] = "#";
      g[r][W - 1] = "#";
    }
    return g.map((row) => row.join(""));
  };

  function dice(seed) {
    const rand = WG.rng(seed);
    const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
    const chance = (p) => rand() < p;
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const weighted = (table) => {
      const total = table.reduce((s, [, w]) => s + w, 0);
      let x = rand() * total;
      for (const [v, w] of table) {
        x -= w;
        if (x < 0) return v;
      }
      return table[table.length - 1][0];
    };
    return { rand, int, chance, pick, weighted };
  }

  /* ---------- Race ---------- */

  // d: difficulty from 0 (gentle) to 1 (mean)
  function race(seed, d) {
    const R = dice(seed);
    const H = 15;
    const b = new Builder(H);
    let gy = 12; // floor row under the runner
    let sinceFlag = 0;
    const target = 40 + Math.round(70 * d);

    const flat = (n) => b.add(n, gy);
    const start = flat(6);
    for (let c = 1; c <= 4; c++) b.put(start + c, gy - 1, "S");

    const table = [
      ["flat", 3],
      ["up", 3],
      ["down", 3],
      ["pit", 3 + 3 * d],
      ["spikes", 2 + 3 * d],
      ["bed", 3 * d],
      ["spring", 0.5 + 2 * d],
      ["climb", 0.5 + 2 * d],
      ["islands", 3 * d],
      ["tunnel", 2 * d],
    ];

    while (b.floor.length < target) {
      if (sinceFlag > 24) {
        const c = flat(3);
        b.put(c + 1, gy - 1, "F");
        sinceFlag = 0;
        continue;
      }
      const before = b.floor.length;
      const kind = R.weighted(table);
      if (kind === "flat") {
        flat(R.int(2, 5));
      } else if (kind === "up") {
        const dy = R.int(1, d < 0.35 ? 2 : 3);
        if (gy - dy < 6) continue;
        gy -= dy;
        flat(R.int(2, 4));
      } else if (kind === "down") {
        const dy = R.int(1, 3);
        if (gy + dy > 13) continue;
        gy += dy;
        flat(R.int(2, 4));
      } else if (kind === "pit") {
        let w = R.int(2, 2 + Math.round(2 * d));
        const dh = R.int(-2, 2); // negative: the far side is higher
        if (dh <= -2) w = Math.min(w, 2);
        else if (dh === -1) w = Math.min(w, 3);
        if (gy + dh < 6 || gy + dh > 13) continue;
        b.add(w, null);
        gy += dh;
        flat(R.int(2, 3));
      } else if (kind === "spikes") {
        flat(2);
        const n = R.int(1, 1 + Math.round(2 * d));
        const c = flat(n);
        for (let i = 0; i < n; i++) b.put(c + i, gy - 1, "^");
        flat(2);
      } else if (kind === "bed") {
        // a long bed of spikes with wooden platforms to hop across
        if (gy - 3 < 4) continue;
        flat(2);
        const n = R.int(5, 5 + Math.round(3 * d));
        const c = flat(n);
        for (let i = 0; i < n; i++) b.put(c + i, gy - 1, "^");
        let pos = c;
        while (pos < c + n - 1) {
          const w = R.int(2, 3);
          for (let i = 0; i < w && pos + i < c + n; i++) b.put(pos + i, gy - 3, "=");
          pos += w + R.int(1, 2);
        }
        flat(3);
      } else if (kind === "spring") {
        const h = R.int(4, 6);
        if (gy < h + 4) continue;
        flat(2);
        const c = flat(1);
        b.put(c, gy - 1, "*");
        flat(2);
        if (R.chance(0.5)) {
          b.add(2, gy - h); // a tall wall, back down on the far side
          flat(3);
        } else {
          gy -= h; // a cliff: the course carries on up there
          flat(3);
        }
      } else if (kind === "climb") {
        // wooden steps up to a higher shelf
        const steps = R.int(2, 3);
        if (gy - 3 * steps < 4) continue;
        flat(2);
        let row = gy;
        for (let i = 1; i <= steps; i++) {
          row = gy - 3 * i;
          const c = flat(3);
          for (let k = 0; k < 3; k++) b.put(c + k, row, "=");
          flat(R.int(1, 2));
        }
        gy = row;
        flat(R.int(2, 4));
      } else if (kind === "islands") {
        const n = R.int(2, 3 + Math.round(d));
        for (let i = 0; i < n; i++) {
          b.add(R.int(2, 2 + Math.round(d)), null);
          gy = Math.max(6, Math.min(13, gy + R.int(-1, 1)));
          b.add(R.int(2, 3), gy);
        }
        b.add(2, null);
        flat(3);
      } else if (kind === "tunnel") {
        // low ceiling with a few spikes: short hops only
        if (gy - 5 < 2) continue;
        const n = R.int(7, 10);
        const c = flat(n);
        for (let i = 0; i < n; i++) b.put(c + i, gy - 5, "#");
        let pos = c + 2;
        while (pos < c + n - 3) {
          const w = R.int(1, 2);
          for (let k = 0; k < w; k++) b.put(pos + k, gy - 1, "^");
          pos += w + R.int(3, 4);
        }
        flat(2);
      }
      sinceFlag += b.floor.length - before;
    }

    const end = flat(6);
    b.put(end + 3, gy - 1, "G");
    b.put(end + 3, gy - 2, "G");
    return { mode: "race", rows: b.rows() };
  }

  /* ---------- Co-op ---------- */

  // Every co-op room needs teamwork and has been checked to work with two players:
  //   boost  – a 4-high wall: one stands on the other's head, holds the switch up there for the door below
  //   relay  – a door with a switch on both sides: take turns holding it
  //   ledge  – the key sits on a ledge only reachable standing on somebody
  //   spring – a 4-high cliff above a step; the one up top opens a door over a spring for the rest
  function coop(seed, d) {
    const R = dice(seed);
    let count = 1 + Math.floor(d * 3) + (R.chance(0.3 + 0.3 * d) ? 1 : 0);
    count = d < 0.02 ? 1 : Math.min(4, count);

    const rooms = [];
    const pool = d < 0.02 ? ["boost"] : ["boost", "relay", "boost", "relay", "ledge", "spring"];
    while (rooms.length < count) {
      const r = R.pick(pool);
      if ((r === "ledge" || r === "spring") && rooms.includes(r)) continue;
      if (r !== "ledge" && rooms.filter((x) => x !== "ledge").length >= 3) continue;
      rooms.push(r);
    }
    const tall = rooms.includes("spring");
    const H = tall ? 22 : 15;
    const b = new Builder(H);
    let fr = H - 1; // floor row
    const letters = ["a", "b", "c"];
    let hasKey = false;

    const flat = (n) => b.add(n, fr);
    const start = flat(6);
    for (let c = 1; c <= 4; c++) b.put(start + c, fr - 1, "S");

    // Before a room that needs a boost, no hills or planks: from those you could make it alone.
    const filler = (flatOnly) => {
      const roll = R.rand();
      if (roll < 0.35 + 0.3 * d || (flatOnly && roll < 0.6)) {
        flat(2);
        const n = R.int(1, 1 + Math.round(2 * d));
        const c = flat(n);
        for (let i = 0; i < n; i++) b.put(c + i, fr - 1, "^");
        flat(2);
      } else if (flatOnly) {
        flat(R.int(3, 5));
      } else if (roll < 0.6) {
        // a small hill everybody can climb alone
        const h = R.int(1, 2);
        flat(2);
        const c = flat(R.int(3, 5));
        for (let i = c; i < b.floor.length; i++) b.column(i, fr - h, fr - 1, "#");
        flat(2);
      } else {
        const c = flat(R.int(4, 6));
        if (R.chance(0.5) && fr - 4 > 3) for (let i = c + 1; i < c + 4; i++) b.put(i, fr - 4, "=");
      }
    };

    rooms.forEach((room) => {
      filler(room !== "relay");
      if (room === "boost") {
        const L = letters.shift();
        flat(3);
        const c = flat(3);
        for (let i = 0; i < 3; i++) {
          b.column(c + i, fr - 4, fr - 3, "#");
          b.column(c + i, fr - 2, fr - 1, L.toUpperCase());
        }
        b.put(c + 1, fr - 5, L);
        const back = flat(1); // a step, so whoever lands on this side can climb back up
        b.put(back, fr - 1, "#");
        flat(3);
      } else if (room === "relay") {
        const L = letters.shift();
        const c0 = flat(R.int(2, 3));
        b.put(c0 + 1, fr - 1, L);
        flat(R.int(1, 2));
        const door = flat(1);
        b.column(door, 1, fr - 5, "#");
        b.column(door, fr - 4, fr - 1, L.toUpperCase());
        flat(R.int(1, 2));
        const c1 = flat(3);
        b.put(c1 + 1, fr - 1, L);
        flat(1);
      } else if (room === "ledge") {
        hasKey = true;
        flat(3);
        const c = flat(4);
        for (let i = 0; i < 4; i++) b.column(c + i, fr - 4, fr - 2, "#");
        b.put(c + 1 + R.int(0, 1), fr - 5, "k");
        flat(3);
      } else if (room === "spring") {
        const L = letters.shift();
        flat(3);
        b.add(6, fr - 3); // the step, three high
        const pit = flat(2);
        b.put(pit, fr - 1, "*");
        b.put(pit, fr - 2, L.toUpperCase());
        fr -= 7; // the cliff: from here on the level runs up here
        const top = flat(4);
        b.put(top + 2, fr - 1, L);
      }
    });

    // a key on an easy little block if no ledge room hid one
    if (!hasKey && R.chance(0.6)) {
      flat(2);
      const c = flat(2);
      b.column(c, fr - 2, fr - 1, "#");
      b.column(c + 1, fr - 2, fr - 1, "#");
      b.put(c + R.int(0, 1), fr - 3, "k");
      hasKey = true;
    }
    filler();
    const end = flat(5);
    b.put(end + 2, fr - 1, "G");
    b.put(end + 2, fr - 2, "G");
    return { mode: "coop", rows: b.rows(), hasKey };
  }

  /* ---------- Brawl ---------- */

  function brawl(seed) {
    const R = dice(seed);
    const W = 30;
    const H = 17;
    const g = [];
    for (let r = 0; r < H; r++) g.push(new Array(W).fill("."));
    const both = (c, r, ch) => {
      g[r][c] = ch;
      g[r][W - 1 - c] = ch;
    };
    const hw = R.int(7, 11); // half the main stage
    const split = R.chance(0.35) ? R.int(1, 2) : 0;
    for (let c = 15 - hw; c < 15; c++) {
      if (c >= 15 - split) continue;
      both(c, 12, "#");
      both(c, 13, "#");
    }
    if (R.chance(0.3) && hw <= 9) {
      // low side ledges
      for (let c = 15 - hw - 5; c < 15 - hw - 1; c++) both(c, 14, "#");
    }
    // wooden platforms above, always in reach of the one below
    const a = R.int(1, 5);
    const w = R.int(3, 5);
    for (let c = 14 - a - w + 1; c <= 14 - a; c++) both(c, 9, "=");
    if (a <= 3 && R.chance(0.7)) {
      const cw = R.int(2, 3);
      for (let c = 15 - cw; c < 15; c++) both(c, 6, "=");
    } else if (R.chance(0.5)) {
      for (let c = 14 - a - w - 2; c <= 14 - a - w + 1; c++) if (c > 0) both(c, 6, "=");
    }
    if (R.chance(0.3)) both(15 - hw, 11, "*");
    else if (R.chance(0.3) && hw >= 9) both(15 - hw + 3, 11, "#");
    // spawn points on solid ground
    const spots = [];
    for (let c = 15 - hw + 1; c < 15 - split; c++) if (g[12][c] === "#" && g[11][c] === ".") spots.push(c);
    const left = [spots[0], spots[Math.floor(spots.length / 2)]].filter((c) => c !== undefined);
    left.forEach((c) => both(c, 11, "S"));
    return { mode: "brawl", rows: g.map((row) => row.join("")) };
  }

  /* ---------- The robot tester ---------- */

  const POLICIES = (function () {
    const list = [];
    [-1, 1].forEach((dir) => {
      [0, 1].forEach((run) => {
        list.push({ dir, run, jump: 99 }); // full jump
        list.push({ dir, run, jump: 7 }); // short hop
        list.push({ dir, run, jump: 99, turn: 16 }); // jump, then brake
        list.push({ dir, run, jump: 99, turn: 28 });
      });
      list.push({ dir, run: 0, jump: 99, delay: 12 }); // straight up first, then sideways
      list.push({ dir, run: 0, jump: 99, delay: 22 });
    });
    list.push({ dir: 0, run: 0, jump: 99 });
    return list;
  })();

  function inWall(map, world, x, y) {
    const c0 = Math.floor(x / T);
    const c1 = Math.floor((x + PF.PW - 0.01) / T);
    const r0 = Math.floor(y / T);
    const r1 = Math.floor((y + PF.PH - 0.01) / T);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (PF.solid(map, world, c, r)) return true;
    return false;
  }

  // Plays one move from a standing spot; returns "goal", a landing spot, or null (died / nowhere).
  function play(map, world, x, y, pol, goal) {
    const p = PF.makePlayer({ x, y });
    p.ground = true;
    p.vx = pol.run ? 260 * pol.dir : 0;
    for (let f = 0; f < 150; f++) {
      let dir = f < (pol.delay || 0) ? 0 : pol.dir;
      if (pol.turn && f >= pol.turn) dir = f < pol.turn + 10 ? -pol.dir : 0;
      const ev = PF.step(
        p,
        { left: dir < 0, right: dir > 0, jump: f < pol.jump, jumpHit: f === 0, down: false },
        map,
        world,
        null,
        DT,
        {}
      );
      if (ev.died) return null;
      if (PF.touching(p, map, goal)) return "goal";
      if (f > 1 && p.ground) return { x: p.x, y: p.y };
    }
    return null;
  }

  // Lets the player drop from (x, y) until they stand somewhere.
  function settle(map, world, x, y, goal) {
    const p = PF.makePlayer({ x, y });
    for (let f = 0; f < 90; f++) {
      const ev = PF.step(p, { left: false, right: false, jump: false, jumpHit: false, down: false }, map, world, null, DT, {});
      if (ev.died) return null;
      if (goal && PF.touching(p, map, goal)) return "goal";
      if (p.ground) return { x: p.x, y: p.y };
    }
    return null;
  }

  // Can a player get from the start to a tile of kind `goal`?
  // open: all doors open; stack: may jump from a friend's head anywhere.
  function reachable(map, goal, open, stack) {
    const world = { open: open ? { a: true, b: true, c: true } : {} };
    const seen = new Set();
    const todo = [];
    const key = (s) => Math.round(s.x / 8) + "," + Math.round(s.y);
    const visit = (s) => {
      if (!s || s === "goal") return s === "goal";
      const k = key(s);
      if (seen.has(k)) return false;
      seen.add(k);
      todo.push(s);
      return false;
    };
    for (const sp of map.spawns) if (visit(settle(map, world, sp.x, sp.y, goal))) return true;
    while (todo.length && seen.size < 5000) {
      const s = todo.pop();
      const found = [];
      const tryFrom = (x, y) => {
        for (const pol of POLICIES) {
          const res = play(map, world, x, y, pol, goal);
          if (res === "goal") return true;
          if (res) found.push(res);
        }
        return false;
      };
      if (tryFrom(s.x, s.y)) return true;
      if (stack && !inWall(map, world, s.x, s.y - PF.PH) && tryFrom(s.x, s.y - PF.PH)) return true;
      for (const dx of [-16, 16]) {
        if (inWall(map, world, s.x + dx, s.y)) continue;
        const res = settle(map, world, s.x + dx, s.y - 1, goal);
        if (res === "goal") return true;
        if (res) found.push(res);
      }
      // rightmost first: courses mostly run left to right, so the robot heads that way
      found.sort((a, b) => a.x - b.x).forEach((s2) => visit(s2));
    }
    return false;
  }

  function verify(level) {
    const map = PF.parse(level);
    if (level.mode === "race") return reachable(map, "G", false, false);
    if (level.mode === "coop") {
      // together it has to be possible…
      if (!reachable(map, "G", true, true)) return false;
      if (map.keys.length && !reachable(map, "k", true, true)) return false;
      // …and alone it must not be: either the exit or the key stays out of reach
      const soloExit = reachable(map, "G", false, false);
      const soloKey = !map.keys.length || reachable(map, "k", false, false);
      return !(soloExit && soloKey);
    }
    // brawl: everybody has to start on solid ground
    const world = { open: {} };
    return map.spawns.length >= 2 && map.spawns.every((sp) => {
      const s = settle(map, world, sp.x, sp.y, null);
      return s && Math.abs(s.y - sp.y) < T;
    });
  }

  /* ---------- Names ---------- */

  const ADJ = ["Mossy", "Rusty", "Windy", "Sunny", "Frosty", "Shady", "Dusty", "Misty", "Stormy", "Quiet",
    "Wobbly", "Crooked", "Lazy", "Hidden", "Sleepy", "Tricky", "Bouncy", "Spiky", "Lonely", "Golden",
    "Silver", "Crumbly", "Twisty", "Echoing", "Breezy", "Muddy", "Starry", "Rocky", "Hollow", "Wild"];
  const NOUN = {
    coop: ["Stairs", "Tower", "Doors", "Cellar", "Bridge", "Garden", "Keep", "Vault", "Tunnels", "Workshop", "Attic", "Mill"],
    race: ["Dash", "Run", "Sprint", "Road", "Rush", "Track", "Alley", "Hills", "Canyon", "Express", "Valley", "Ridge"],
    brawl: ["Arena", "Ring", "Stage", "Pit", "Dome", "Deck", "Court", "Island", "Roof", "Square", "Summit", "Yard"],
  };

  function title(mode, seed) {
    const R = dice(seed ^ 0x5bd1e995);
    return R.pick(ADJ) + " " + R.pick(NOUN[mode]);
  }

  /* ---------- Public ---------- */

  function build(mode, seed, d) {
    if (mode === "race") return race(seed, d);
    if (mode === "coop") return coop(seed, d);
    return brawl(seed);
  }

  // Rolls seeds until the robot manages the level.
  function make(mode, seeds, d) {
    for (let i = 0; i < 40; i++) {
      const seed = seeds(i);
      const lv = build(mode, seed, d);
      if (verify(lv)) return { mode, rows: lv.rows, seed, name: title(mode, seed) };
    }
    const fallback = PLATFORM_LEVELS[mode][0];
    return { mode, rows: fallback.rows, name: fallback.name };
  }

  const cache = {};

  // Numbered levels 1–50: always the same level for the same number, getting harder as you go.
  function numbered(mode, n) {
    const k = mode + n;
    if (!cache[k]) {
      const d = LEVELS > 1 ? (n - 1) / (LEVELS - 1) : 0;
      const lv = make(mode, (i) => WG.seedFrom("pf-level", mode, n, i), d);
      lv.name = (mode === "brawl" ? "Arena " : "Level ") + n + " · " + lv.name;
      cache[k] = lv;
    }
    return cache[k];
  }

  // A brand new level; d defaults to something middling.
  function random(mode, d) {
    const base = Math.floor(Math.random() * 2 ** 31);
    return make(mode, (i) => base + i * 7919, d === undefined ? 0.3 + Math.random() * 0.5 : d);
  }

  // Can one player alone (no friend to stand on, doors shut) reach the exit?
  function soloFinish(level) {
    return reachable(PF.parse(level), "G", false, false);
  }

  // The Map Maker's robot check: plays somebody's own map and says how it went.
  function report(level) {
    const problems = PF.problems(level);
    if (problems.length) return { ok: false, text: problems[0] };
    const map = PF.parse(level);
    if (level.mode === "race") {
      return reachable(map, "G", false, false)
        ? { ok: true, text: "The robot made it to the finish — your course works!" }
        : { ok: false, text: "The robot could not reach the finish. A jump climbs 3 blocks and crosses about 4." };
    }
    if (level.mode === "coop") {
      const together = reachable(map, "G", true, true) && (!map.keys.length || reachable(map, "k", true, true));
      if (!together) {
        return { ok: false, text: "Even as a team the robot could not reach the exit or the key. A friend's head gets you 4 blocks high, not more." };
      }
      const alone = reachable(map, "G", false, false) && (!map.keys.length || reachable(map, "k", false, false));
      return alone
        ? { ok: true, text: "Playable — but one player could finish it alone. A 4-high wall or a door makes teamwork necessary." }
        : { ok: true, text: "Playable together and impossible alone — a real co-op level!" };
    }
    return verify(level)
      ? { ok: true, text: "Every spawn point stands on solid ground — ready to brawl!" }
      : { ok: false, text: "Some spawn points are not on solid ground." };
  }

  window.PFGEN = { LEVELS, numbered, random, verify, build, soloFinish, report };
})();
