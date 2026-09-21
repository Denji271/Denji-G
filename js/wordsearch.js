// Word Search — eight words hidden in eight directions in a letter grid.
(function () {
  "use strict";

  const SIZE = 11;
  const COUNT = 8;
  const DIRS = [
    [0, 1], [1, 0], [1, 1], [1, -1],
    [0, -1], [-1, 0], [-1, -1], [-1, 1],
  ];

  const $ = GK.$;
  const day = WG.dayNumber();

  let mode = "daily";
  let seed = day;
  let grid = [];
  let placed = [];
  let found = [];
  let clock;
  let anchor = null;
  let cursor = null;
  let dragging = false;

  WG.setupDialogs();
  WG.loadData().then(init, (err) => WG.toast(err.message, 6000));

  function init(data) {
    const p = WG.params().get("p");
    if (p !== null && /^\d+$/.test(p)) {
      mode = "endless";
      seed = Number(p);
    }
    const pool = WG.splitWords(data.beeWords).filter((w) => {
      const n = [...w].length;
      return n >= 4 && n <= 9 && [...w].length === w.length;
    });
    build(pool);

    $("subtitle").textContent = GK.subtitle(mode, day);
    $("totalCount").textContent = placed.length;
    clock = GK.timer($("clock"));

    const saved = WG.store.get(stateKey(), null);
    found = saved && Array.isArray(saved.found) ? saved.found.filter((w) => placed.some((p2) => p2.word === w)) : [];
    clock.reset(saved && saved.ms ? saved.ms : 0);

    drawGrid();
    drawWords();
    if (found.length < placed.length) clock.start();

    GK.dragSelect($("grid"), ".ws-cell", { start: onDragStart, move: onDragMove, end: onDragEnd });
    $("newBtn").addEventListener("click", newPuzzle);
    $("againBtn").addEventListener("click", newPuzzle);
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    window.addEventListener("beforeunload", save);
    if (found.length === placed.length) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "wordsearch:" + (mode === "daily" ? "d:" + day : "v:" + seed);
  }

  function save() {
    WG.store.set(stateKey(), { found, ms: clock.value() });
  }

  /* ---------- Building the grid ---------- */

  function build(pool) {
    const rand = WG.rng(WG.seedFrom("wordsearch", seed));
    grid = Array.from({ length: SIZE }, () => new Array(SIZE).fill(""));
    placed = [];
    const letters = new Set();
    const shuffled = WG.shuffle(pool, rand);
    let index = 0;
    while (placed.length < COUNT && index < shuffled.length) {
      const word = shuffled[index++];
      if (placed.some((p) => p.word === word)) continue;
      if (place(word, rand)) [...word].forEach((ch) => letters.add(ch));
    }
    // leftover cells get filler letters drawn from the hidden words themselves
    const fill = [...letters];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!grid[r][c]) grid[r][c] = WG.pick(fill, rand);
      }
    }
  }

  function place(word, rand) {
    const chars = [...word];
    const starts = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) starts.push([r, c]);
    const order = WG.shuffle(starts, rand);
    const dirs = WG.shuffle(DIRS, rand);
    for (const [r, c] of order) {
      for (const [dr, dc] of dirs) {
        if (fits(chars, r, c, dr, dc)) {
          const cells = [];
          chars.forEach((ch, i) => {
            grid[r + dr * i][c + dc * i] = ch;
            cells.push([r + dr * i, c + dc * i]);
          });
          placed.push({ word, cells });
          return true;
        }
      }
    }
    return false;
  }

  function fits(chars, r, c, dr, dc) {
    const endR = r + dr * (chars.length - 1);
    const endC = c + dc * (chars.length - 1);
    if (endR < 0 || endR >= SIZE || endC < 0 || endC >= SIZE) return false;
    return chars.every((ch, i) => {
      const cell = grid[r + dr * i][c + dc * i];
      return !cell || cell === ch;
    });
  }

  /* ---------- Drawing ---------- */

  function drawGrid() {
    const box = $("grid");
    box.innerHTML = "";
    box.style.setProperty("--ws-size", SIZE);
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = GK.el("div", "ws-cell", grid[r][c]);
        cell.dataset.r = r;
        cell.dataset.c = c;
        box.appendChild(cell);
      }
    }
    found.forEach(markFound);
  }

  function drawWords() {
    const list = $("wordList");
    list.innerHTML = "";
    placed.forEach((p) => {
      const li = GK.el("li", found.includes(p.word) ? "done" : "", p.word);
      list.appendChild(li);
    });
    $("foundCount").textContent = found.length;
  }

  function cellAt(r, c) {
    return $("grid").children[r * SIZE + c];
  }

  function markFound(word) {
    const entry = placed.find((p) => p.word === word);
    if (entry) entry.cells.forEach(([r, c]) => cellAt(r, c).classList.add("ws-found"));
  }

  /* ---------- Selection ---------- */

  // Two ways to mark a word: drag from the first letter to the last, or tap both ends.
  function posOf(cell) {
    return [Number(cell.dataset.r), Number(cell.dataset.c)];
  }

  function same(a, b) {
    return a && b && a[0] === b[0] && a[1] === b[1];
  }

  function onDragStart(cell) {
    const pos = posOf(cell);
    if (anchor && !same(anchor, pos)) {
      // second tap: this closes the run
      cursor = pos;
      finishSelection();
      return;
    }
    if (same(anchor, pos)) {
      anchor = null;
      cursor = null;
      clearSelection();
      return;
    }
    anchor = pos;
    cursor = pos;
    dragging = false;
    paintSelection();
  }

  function onDragMove(cell) {
    if (!anchor) return;
    const pos = posOf(cell);
    if (!same(anchor, pos)) dragging = true;
    cursor = pos;
    paintSelection();
  }

  function onDragEnd() {
    // after a plain tap the first letter stays marked until the second tap
    if (dragging) finishSelection();
  }

  function finishSelection() {
    const cells = line();
    clearSelection();
    anchor = null;
    cursor = null;
    dragging = false;
    if (cells && cells.length > 1) check(cells);
  }

  // Only straight runs count: across, down or diagonal.
  function line() {
    if (!anchor || !cursor) return null;
    const dr = Math.sign(cursor[0] - anchor[0]);
    const dc = Math.sign(cursor[1] - anchor[1]);
    const down = Math.abs(cursor[0] - anchor[0]);
    const across = Math.abs(cursor[1] - anchor[1]);
    if (dr !== 0 && dc !== 0 && down !== across) return null;
    const steps = Math.max(down, across);
    const cells = [];
    for (let i = 0; i <= steps; i++) cells.push([anchor[0] + dr * i, anchor[1] + dc * i]);
    return cells;
  }

  function paintSelection() {
    clearSelection();
    const cells = line();
    if (cells) cells.forEach(([r, c]) => cellAt(r, c).classList.add("picked"));
    else if (anchor) cellAt(anchor[0], anchor[1]).classList.add("picked");
  }

  function clearSelection() {
    $("grid").querySelectorAll(".picked").forEach((c) => c.classList.remove("picked"));
  }

  function check(cells) {
    const text = cells.map(([r, c]) => grid[r][c]).join("");
    const reversed = [...text].reverse().join("");
    const hit = placed.find(
      (p) => !found.includes(p.word) && (p.word === text || p.word === reversed) && sameCells(p.cells, cells)
    );
    if (!hit) return;
    found.push(hit.word);
    markFound(hit.word);
    drawWords();
    save();
    WG.toast(hit.word, 1200);
    if (found.length < placed.length) return;
    clock.stop();
    save();
    WG.stats.record("wordsearch:" + mode, { won: true, daily: mode === "daily", day });
    WG.toast("Every word found!", 2200);
    setTimeout(openStats, 1200);
  }

  function sameCells(a, b) {
    if (a.length !== b.length) return false;
    const key = (list) => list.map((p) => p.join(",")).sort().join("|");
    return key(a) === key(b);
  }

  /* ---------- New puzzle and stats ---------- */

  function newPuzzle() {
    location.href = WG.pageUrl("wordsearch.html", { p: Math.floor(Math.random() * 100000) });
  }

  function openStats() {
    const done = found.length === placed.length;
    const s = WG.stats.load("wordsearch:" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = done ? "Solved" : "Statistics";
    const line2 = $("resultLine");
    line2.hidden = !done;
    line2.textContent = done ? placed.length + " words in " + clock.text() : "";
    $("shareBtn").hidden = !done;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    return (
      "Word Search " + label + "\n" +
      placed.length + " words in " + clock.text() + "\n\n" +
      WG.pageUrl("wordsearch.html", mode === "daily" ? {} : { p: seed })
    );
  }
})();
