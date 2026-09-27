// Map Maker — draw platformer levels, try them out, keep them and share them as a code.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const T = PF.T;
  const MAPS_KEY = "pf:maps";
  const CODE_PREFIX = "PF1.";
  const MAX_SPAWNS = 4;
  const PALETTE = ["#", "=", "^", "*", "S", "G", "F", "k", "a", "A", "b", "B", "c", "C", "."];

  const canvas = $("edCanvas");
  const ctx = canvas.getContext("2d");
  const scroller = $("edScroll");

  let grid = []; // rows of characters
  let name = "";
  let mode = "coop";
  let currentId = null; // the saved map being edited
  let saved = true;
  let edited = false; // changed by hand since the last load or save
  let tool = "#";
  let zoom = 0.75;
  let map = null; // parsed copy of the grid, rebuilt after every change
  let dirty = true;
  const history = [];
  let test = null; // the running test, if any

  ARC.input.enabled = false; // the arrow keys only steer during a test

  /* ---------- Maps ---------- */

  function blankGrid(w, h, m) {
    const g = [];
    for (let r = 0; r < h; r++) g.push(new Array(w).fill("."));
    if (m === "brawl") {
      const r = h - 4;
      for (let c = 4; c < w - 4; c++) {
        g[r][c] = "#";
        g[r + 1][c] = "#";
      }
      g[r - 1][6] = "S";
      g[r - 1][w - 7] = "S";
    } else {
      for (let c = 0; c < w; c++) {
        g[0][c] = "#";
        g[h - 1][c] = "#";
      }
      for (let r = 0; r < h; r++) {
        g[r][0] = "#";
        g[r][w - 1] = "#";
      }
      g[h - 2][1] = "S";
      g[h - 2][2] = "S";
      g[h - 2][w - 3] = "G";
      g[h - 3][w - 3] = "G";
    }
    return g;
  }

  function level() {
    return { name: name.trim() || "My map", mode, rows: grid.map((row) => row.join("")) };
  }

  function load(lv, id) {
    grid = lv.rows.map((r) => r.split(""));
    const w = Math.max(...grid.map((r) => r.length));
    grid.forEach((r) => {
      while (r.length < w) r.push(".");
    });
    name = lv.name || "";
    mode = lv.mode in { coop: 1, race: 1, brawl: 1 } ? lv.mode : "coop";
    currentId = id || null;
    saved = !!id;
    edited = false;
    history.length = 0;
    syncInputs();
    changed(true);
  }

  function markEdited() {
    saved = false;
    edited = true;
  }

  // Only ask before throwing work away when somebody actually drew something.
  function unsavedWork() {
    return edited && !saved;
  }

  function myMaps() {
    const list = WG.store.get(MAPS_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function save() {
    const lv = level();
    const list = myMaps();
    if (!currentId) currentId = Date.now().toString(36);
    const entry = { id: currentId, name: lv.name, mode: lv.mode, rows: lv.rows, updated: Date.now() };
    const i = list.findIndex((m) => m.id === currentId);
    if (i >= 0) list[i] = entry;
    else list.unshift(entry);
    WG.store.set(MAPS_KEY, list);
    saved = true;
    edited = false;
    status();
    return entry;
  }

  function encode(lv) {
    const json = JSON.stringify({ n: lv.name, m: lv.mode, r: lv.rows });
    let bin = "";
    new TextEncoder().encode(json).forEach((b) => (bin += String.fromCharCode(b)));
    return CODE_PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decode(code) {
    const clean = String(code).trim().replace(/\s+/g, "");
    if (!clean.startsWith(CODE_PREFIX)) return null;
    try {
      const bin = atob(clean.slice(CODE_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/"));
      const json = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
      const d = JSON.parse(json);
      if (!Array.isArray(d.r) || !d.r.length || d.r.length > 40 || d.r.some((r) => typeof r !== "string" || r.length > 150)) return null;
      return { name: String(d.n || "Imported map").slice(0, 30), mode: d.m, rows: d.r };
    } catch (e) {
      return null;
    }
  }

  /* ---------- Editing ---------- */

  function changed(resize) {
    map = PF.parse(level());
    if (resize) sizeCanvas();
    dirty = true;
    status();
  }

  function remember() {
    history.push(grid.map((r) => r.slice()));
    if (history.length > 40) history.shift();
  }

  function undo() {
    if (!history.length || test) return;
    const prev = history.pop();
    const resize = prev.length !== grid.length || prev[0].length !== grid[0].length;
    grid = prev;
    markEdited();
    syncInputs();
    changed(resize);
  }

  function paint(c, r, ch) {
    if (r < 0 || c < 0 || r >= grid.length || c >= grid[0].length) return;
    if (grid[r][c] === ch) return;
    if (ch === "k") {
      // one key per map
      grid.forEach((row) => row.forEach((x, i) => x === "k" && (row[i] = ".")));
    }
    if (ch === "S" && grid.flat().filter((x) => x === "S").length >= MAX_SPAWNS) {
      WG.toast("Up to " + MAX_SPAWNS + " spawn points");
      return;
    }
    grid[r][c] = ch;
    markEdited();
    changed(false);
  }

  function resizeGrid(w, h) {
    w = Math.max(10, Math.min(120, w | 0));
    h = Math.max(8, Math.min(30, h | 0));
    if (w === grid[0].length && h === grid.length) return;
    remember();
    // grow and shrink at the top, so the floor stays where it is
    while (grid.length < h) grid.unshift(new Array(grid[0].length).fill("."));
    while (grid.length > h) grid.shift();
    grid.forEach((row) => {
      while (row.length < w) row.push(".");
      row.length = w;
    });
    markEdited();
    changed(true);
  }

  function tileAt(e) {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * map.pw;
    const y = ((e.clientY - rect.top) / rect.height) * map.ph;
    return { c: Math.floor(x / T), r: Math.floor(y / T) };
  }

  let stroke = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (test) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    stroke = e.button === 2 ? "." : tool;
    remember();
    const t = tileAt(e);
    paint(t.c, t.r, stroke);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!stroke) {
      hover = tileAt(e);
      dirty = true;
      return;
    }
    const t = tileAt(e);
    paint(t.c, t.r, stroke);
  });
  canvas.addEventListener("pointerup", () => (stroke = null));
  canvas.addEventListener("pointercancel", () => (stroke = null));
  canvas.addEventListener("pointerleave", () => {
    hover = null;
    dirty = true;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  let hover = null;

  /* ---------- Toolbar ---------- */

  function buildPalette() {
    const box = $("palette");
    const pal = PF.palette(ARC.colors.dark);
    box.innerHTML = "";
    PALETTE.forEach((ch) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ed-tile" + (ch === tool ? " on" : "");
      b.title = ch === "." ? "Eraser" : PF.TILES[ch];
      b.setAttribute("aria-label", b.title);
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 64;
      const x = c.getContext("2d");
      x.scale(2, 2);
      x.fillStyle = pal.sky;
      x.fillRect(0, 0, T, T);
      if (ch === ".") {
        x.strokeStyle = "#e05c4a";
        x.lineWidth = 3;
        x.beginPath();
        x.moveTo(9, 9);
        x.lineTo(23, 23);
        x.moveTo(23, 9);
        x.lineTo(9, 23);
        x.stroke();
      } else {
        PF.drawTile(x, ch, 0, 0, { mode, keys: [], grid: [[ch]], w: 1, h: 1 }, { open: {} }, pal, 0, 0, true);
      }
      b.appendChild(c);
      b.addEventListener("click", () => {
        tool = ch;
        buildPalette();
      });
      box.appendChild(b);
    });
  }

  function syncInputs() {
    $("edName").value = name;
    $("edMode").value = mode;
    $("edW").value = grid[0].length;
    $("edH").value = grid.length;
    buildPalette();
  }

  function status(text) {
    const el = $("edStatus");
    el.classList.remove("bad");
    if (text) {
      el.textContent = text;
      return;
    }
    const problems = PF.problems(level());
    const state = saved ? "Saved." : "Not saved yet.";
    if (problems.length) {
      el.classList.add("bad");
      el.textContent = problems[0] + " " + state;
    } else {
      el.textContent = "Looks playable — press Test to try it. " + state;
    }
    $("subtitle").textContent = name.trim() || "";
  }

  $("edName").addEventListener("input", () => {
    name = $("edName").value;
    saved = false;
    status();
  });
  $("edMode").addEventListener("change", () => {
    mode = $("edMode").value;
    saved = false;
    buildPalette();
    changed(false);
  });
  $("edW").addEventListener("change", () => resizeGrid(Number($("edW").value), grid.length));
  $("edH").addEventListener("change", () => resizeGrid(grid[0].length, Number($("edH").value)));
  $("edZoom").addEventListener("change", () => {
    zoom = Number($("edZoom").value);
    sizeCanvas();
  });
  $("edUndo").addEventListener("click", undo);
  $("edNew").addEventListener("click", () => {
    if (unsavedWork() && !confirm("Start a new map? Unsaved changes are lost.")) return;
    load({ name: "", mode, rows: blankGrid(40, 15, mode).map((r) => r.join("")) });
  });
  $("edSave").addEventListener("click", () => {
    save();
    WG.toast("Saved to My maps");
  });
  $("edHost").addEventListener("click", () => {
    const problems = PF.problems(level());
    if (problems.length) {
      WG.toast(problems[0], 2600);
      return;
    }
    const entry = save();
    location.href = WG.pageUrl("platformer.html", { mode: entry.mode, map: entry.id });
  });
  $("edExport").addEventListener("click", async () => {
    const ok = await WG.copyText(encode(level()));
    WG.toast(ok ? "Map code copied — send it to a friend!" : "Could not copy", 2400);
  });
  $("edImport").addEventListener("click", () => {
    $("importText").value = "";
    $("importError").textContent = "";
    WG.openDialog("importDlg");
  });
  $("importForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const lv = decode($("importText").value);
    if (!lv) {
      $("importError").textContent = "That does not look like a map code.";
      return;
    }
    $("importDlg").close();
    load(lv, null);
    saved = false;
    status();
    WG.toast("Map loaded — press Save to keep it");
  });
  $("edMaps").addEventListener("click", showMaps);
  $("edRandom").addEventListener("click", () => {
    if (test) stopTest();
    if (unsavedWork() && !confirm("Replace your map with a random one? Unsaved changes are lost.")) return;
    const lv = PFGEN.random(mode, Number($("edDiff").value));
    load({ name: lv.name, mode, rows: lv.rows }, null);
    status("A fresh " + { coop: "co-op level", race: "race course", brawl: "arena" }[mode] + ", checked by the robot. Test it, change it, or Save it.");
  });
  $("edCheck").addEventListener("click", () => {
    if (test) stopTest();
    const res = PFGEN.report(level());
    status(res.text);
    $("edStatus").classList.toggle("bad", !res.ok);
  });
  $("edTest").addEventListener("click", () => (test ? stopTest() : startTest()));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && test) {
      e.preventDefault();
      stopTest();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
      e.preventDefault();
      undo();
    }
  });

  const MODE_NAMES = { coop: "Co-op", race: "Race", brawl: "Brawl" };

  function showMaps() {
    const list = $("mapsList");
    list.innerHTML = "";
    const maps = myMaps();
    if (!maps.length) {
      const li = document.createElement("li");
      li.className = "muted center";
      li.textContent = "No saved maps yet.";
      list.appendChild(li);
    }
    maps.forEach((m) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "name";
      label.textContent = m.name;
      const tag = document.createElement("small");
      tag.className = "muted";
      tag.textContent = " " + (MODE_NAMES[m.mode] || m.mode);
      label.appendChild(tag);
      const edit = button("Edit", () => {
        if (unsavedWork() && currentId !== m.id && !confirm("Open this map? Unsaved changes are lost.")) return;
        load(m, m.id);
        $("mapsDlg").close();
      });
      const host = button("Host", () => {
        location.href = WG.pageUrl("platformer.html", { mode: m.mode, map: m.id });
      });
      const del = button("Delete", () => {
        if (!confirm('Delete "' + m.name + '" for good?')) return;
        WG.store.set(
          MAPS_KEY,
          myMaps().filter((x) => x.id !== m.id)
        );
        if (currentId === m.id) {
          currentId = null;
          saved = false;
          status();
        }
        showMaps();
      });
      li.append(label, edit, host, del);
      list.appendChild(li);
    });
    WG.openDialog("mapsDlg");
  }

  function button(text, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn small";
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  }

  /* ---------- Test play ---------- */

  function startTest() {
    if (!map.spawns.length || !grid.flat().includes("S")) {
      WG.toast("Place a spawn point (S) first");
      return;
    }
    const k = map.keys[0];
    test = {
      p: PF.makePlayer(map.spawns[0]),
      spawn: map.spawns[0],
      world: { open: {}, unlocked: !k, flagsHit: new Set() },
      key: k ? { x: k.x, y: k.y, home: { x: k.x, y: k.y } } : null,
      carrying: false,
      dead: 0,
      start: performance.now(),
      done: false,
    };
    ARC.input.enabled = true;
    ARC.input.reset();
    $("edTest").textContent = "■ Stop test";
    canvas.classList.add("testing");
    status("Testing — arrows or WASD to move, Space to jump, Esc to stop.");
    canvas.focus();
  }

  function stopTest() {
    test = null;
    ARC.input.enabled = false;
    ARC.input.reset();
    $("edTest").textContent = "▶ Test";
    canvas.classList.remove("testing");
    dirty = true;
    status();
  }

  function testStep(dt) {
    const t = test;
    if (t.dead > 0) {
      t.dead -= dt;
      if (t.dead <= 0) Object.assign(t.p, PF.makePlayer(t.spawn));
      return;
    }
    t.world.open = PF.pressed(map, [t.p]);
    const ev = PF.step(
      t.p,
      {
        left: ARC.input.held("left"),
        right: ARC.input.held("right"),
        jump: ARC.input.held("jump"),
        jumpHit: ARC.input.hit("jump"),
        down: ARC.input.held("down"),
      },
      map,
      t.world,
      [],
      dt,
      { bounds: mode === "brawl" }
    );
    if (ev.died) {
      t.dead = 0.6;
      if (t.carrying) {
        t.carrying = false;
        t.key.x = t.key.home.x;
        t.key.y = t.key.home.y;
      }
      if (mode === "brawl") t.spawn = map.spawns[Math.floor(Math.random() * map.spawns.length)];
      return;
    }
    if (t.key && !t.carrying && !t.world.unlocked) {
      if (PF.overlap(t.p, { x: t.key.x - 12, y: t.key.y - 12, w: 24, h: 24 })) t.carrying = true;
    }
    const f = PF.touching(t.p, map, "F");
    if (f && !t.world.flagsHit.has(f.c + "," + f.r)) {
      t.world.flagsHit.add(f.c + "," + f.r);
      t.spawn = { x: f.c * T + (T - PF.PW) / 2, y: (f.r + 1) * T - PF.PH };
      WG.toast("Checkpoint!", 900);
    }
    if (PF.touching(t.p, map, "G") && !t.done) {
      if (mode === "race") {
        t.done = true;
        WG.toast("Finished in " + ((performance.now() - t.start) / 1000).toFixed(2) + " s", 2600);
      } else if (mode === "coop") {
        if (t.carrying) {
          t.carrying = false;
          t.world.unlocked = true;
        }
        if (t.world.unlocked && ARC.input.hit("up")) {
          t.done = true;
          WG.toast("You made it! In a real game everybody has to get in.", 2800);
        }
      }
    }
    follow(t.p);
  }

  // keep the player in view while testing a map larger than the screen
  function follow(p) {
    const s = canvas.getBoundingClientRect().width / map.pw;
    const px = (p.x + PF.PW / 2) * s;
    const py = (p.y + PF.PH / 2) * s;
    const margin = 120;
    if (px - scroller.scrollLeft < margin) scroller.scrollLeft = px - margin;
    else if (px - scroller.scrollLeft > scroller.clientWidth - margin) scroller.scrollLeft = px - scroller.clientWidth + margin;
    if (py - scroller.scrollTop < margin) scroller.scrollTop = py - margin;
    else if (py - scroller.scrollTop > scroller.clientHeight - margin) scroller.scrollTop = py - scroller.clientHeight + margin;
  }

  /* ---------- Drawing ---------- */

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = map.pw * zoom;
    const h = map.ph * zoom;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    dirty = true;
  }

  function draw() {
    if (!dirty && !test) return;
    dirty = false;
    const dark = ARC.colors.dark;
    const pal = PF.palette(dark);
    const s = canvas.width / map.pw;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = pal.sky;
    ctx.fillRect(0, 0, map.pw, map.ph);

    if (!test) {
      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c <= map.w; c++) {
        ctx.moveTo(c * T + 0.5, 0);
        ctx.lineTo(c * T + 0.5, map.ph);
      }
      for (let r = 0; r <= map.h; r++) {
        ctx.moveTo(0, r * T + 0.5);
        ctx.lineTo(map.pw, r * T + 0.5);
      }
      ctx.stroke();
    }

    const world = test ? test.world : { open: {}, unlocked: false, flagsHit: new Set() };
    PF.drawTiles(ctx, map, world, { x: 0, y: 0, w: map.pw, h: map.ph }, dark, !test);

    if (test) {
      const t = test;
      if (t.key && !t.carrying && !t.world.unlocked) PF.drawKey(ctx, t.key.x, t.key.y + Math.sin(performance.now() / 300) * 3);
      if (t.dead <= 0) PF.drawPlayer(ctx, t.p, { color: "#e05c4a", key: t.carrying, dark });
    } else if (hover && hover.c >= 0 && hover.r >= 0 && hover.c < map.w && hover.r < map.h) {
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 2;
      ctx.strokeRect(hover.c * T + 1, hover.r * T + 1, T - 2, T - 2);
    }
  }

  function update(dt) {
    if (test) testStep(dt);
  }

  ARC.loop(update, draw).start();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    buildPalette();
    dirty = true;
  });

  WG.setupDialogs();

  // Open the map from ?edit=id, otherwise start with a fresh one.
  const editId = WG.params().get("edit");
  const existing = editId && myMaps().find((m) => m.id === editId);
  if (existing) load(existing, existing.id);
  else load({ name: "", mode: "coop", rows: blankGrid(40, 15, "coop").map((r) => r.join("")) });
})();
