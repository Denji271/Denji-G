// Nonogram — a picture grid that can always be solved by logic, never by guessing.
(function () {
  "use strict";

  const SIZES = [
    { id: "small", name: "5 x 5", n: 5, density: 0.55 },
    { id: "classic", name: "10 x 10", n: 10, density: 0.55 },
    { id: "big", name: "12 x 12", n: 12, density: 0.52 },
  ];

  const EMPTY = 0;
  const FILLED = 1;
  const MARKED = 2;

  const $ = GK.$;
  const day = WG.dayNumber();

  let size = SIZES[1];
  let mode = "daily";
  let seed = day;
  let n = 10;
  let answer = [];
  let rowClues = [];
  let colClues = [];
  let cells = [];
  let fillMode = FILLED;
  let rightButton = false;
  let paintWith = null;
  let finished = false;
  let clock;

  WG.setupDialogs();
  init();

  function init() {
    const params = WG.params();
    const wanted = SIZES.find((s) => s.id === params.get("size"));
    if (wanted) size = wanted;
    const p = params.get("p");
    if (p !== null && /^\d+$/.test(p)) {
      mode = "endless";
      seed = Number(p);
    }
    n = size.n;

    answer = makePuzzle(WG.seedFrom("nonogram", size.id, seed));
    rowClues = rows().map(clueOf);
    colClues = cols().map(clueOf);
    cells = new Array(n * n).fill(EMPTY);

    const saved = WG.store.get(stateKey(), null);
    if (saved && Array.isArray(saved.cells) && saved.cells.length === n * n) cells = saved.cells;
    finished = solved();

    $("subtitle").textContent = GK.subtitle(mode, day);
    $("sizeName").textContent = size.name;
    $("target").textContent = answer.filter(Boolean).length;
    clock = GK.timer($("clock"));
    clock.reset(saved && saved.ms ? saved.ms : 0);
    if (!finished) clock.start();

    build();
    buildLevels();
    render();

    $("modeBtn").addEventListener("click", toggleMode);
    $("clearBtn").addEventListener("click", clear);
    $("newBtn").addEventListener("click", () => newPuzzle(size.id));
    $("againBtn").addEventListener("click", () => newPuzzle(size.id));
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    window.addEventListener("beforeunload", save);
    if (finished) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "nonogram:" + size.id + ":" + (mode === "daily" ? "d:" + day : "v:" + seed);
  }

  function save() {
    WG.store.set(stateKey(), { cells, ms: clock.value(), done: finished });
  }

  function rows() {
    return [...Array(n).keys()].map((r) => [...Array(n).keys()].map((c) => answer[r * n + c]));
  }

  function cols() {
    return [...Array(n).keys()].map((c) => [...Array(n).keys()].map((r) => answer[r * n + c]));
  }

  function clueOf(line) {
    const out = [];
    let run = 0;
    line.forEach((v) => {
      if (v) run++;
      else if (run) {
        out.push(run);
        run = 0;
      }
    });
    if (run) out.push(run);
    return out.length ? out : [0];
  }

  /* ---------- Generating ---------- */

  // Draws random pictures until one can be solved by row and column logic alone.
  function makePuzzle(s) {
    const rand = WG.rng(s);
    for (let attempt = 0; attempt < 200; attempt++) {
      const grid = [...Array(n * n)].map(() => (rand() < size.density ? 1 : 0));
      if (grid.every((v) => !v)) continue;
      const rowLines = [...Array(n).keys()].map((r) => clueOf(grid.slice(r * n, r * n + n)));
      const colLines = [...Array(n).keys()].map((c) =>
        clueOf([...Array(n).keys()].map((r) => grid[r * n + c]))
      );
      if (logicSolvable(rowLines, colLines)) return grid;
    }
    return [...Array(n * n)].map(() => (WG.rng(s + 1)() < 0.5 ? 1 : 0));
  }

  // Classic line solver: repeatedly pin down whatever every possible arrangement agrees on.
  function logicSolvable(rowLines, colLines) {
    const state = new Array(n * n).fill(-1); // -1 unknown, 0 empty, 1 filled
    for (let round = 0; round < 40; round++) {
      let changed = false;
      for (let r = 0; r < n; r++) {
        const line = [...Array(n).keys()].map((c) => state[r * n + c]);
        const fixed = pinDown(rowLines[r], line);
        if (!fixed) return false;
        fixed.forEach((v, c) => {
          if (v !== -1 && state[r * n + c] === -1) {
            state[r * n + c] = v;
            changed = true;
          }
        });
      }
      for (let c = 0; c < n; c++) {
        const line = [...Array(n).keys()].map((r) => state[r * n + c]);
        const fixed = pinDown(colLines[c], line);
        if (!fixed) return false;
        fixed.forEach((v, r) => {
          if (v !== -1 && state[r * n + c] === -1) {
            state[r * n + c] = v;
            changed = true;
          }
        });
      }
      if (state.every((v) => v !== -1)) return true;
      if (!changed) return false;
    }
    return false;
  }

  // All arrangements of one line that fit the clue and the cells we already know.
  function pinDown(clue, known) {
    const options = [];
    const blocks = clue[0] === 0 ? [] : clue;

    function walk(at, index, line) {
      if (options.length > 4000) return;
      if (index === blocks.length) {
        const rest = line.concat(new Array(n - line.length).fill(0));
        if (fits(rest, known)) options.push(rest);
        return;
      }
      const need = blocks.slice(index).reduce((a, b) => a + b, 0) + blocks.length - index - 1;
      for (let start = at; start + need <= n; start++) {
        const next = line.concat(new Array(start - line.length).fill(0), new Array(blocks[index]).fill(1));
        if (!fits(next, known, true)) continue;
        const after = index === blocks.length - 1 ? next : next.concat([0]);
        walk(after.length, index + 1, after);
      }
    }
    walk(0, 0, []);
    if (!options.length) return null;

    const result = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const first = options[0][i];
      if (options.every((o) => o[i] === first)) result[i] = first;
    }
    return result;
  }

  function fits(line, known, partial) {
    for (let i = 0; i < line.length; i++) {
      if (known[i] !== -1 && known[i] !== line[i]) return false;
    }
    return partial || line.length === n;
  }

  /* ---------- Drawing ---------- */

  function build() {
    const wrap = $("wrap");
    wrap.style.setProperty("--ng", n);

    const colBox = $("colClues");
    colBox.innerHTML = "";
    colClues.forEach((clue, c) => {
      const box = GK.el("div", "ng-clue ng-col");
      box.dataset.c = c;
      clue.forEach((num) => box.appendChild(GK.el("span", "", num)));
      colBox.appendChild(box);
    });

    const rowBox = $("rowClues");
    rowBox.innerHTML = "";
    rowClues.forEach((clue, r) => {
      const box = GK.el("div", "ng-clue ng-row");
      box.dataset.r = r;
      clue.forEach((num) => box.appendChild(GK.el("span", "", num)));
      rowBox.appendChild(box);
    });

    const grid = $("grid");
    grid.innerHTML = "";
    for (let i = 0; i < n * n; i++) {
      const cell = GK.el("div", "ng-cell");
      cell.dataset.i = i;
      const r = Math.floor(i / n);
      const c = i % n;
      if (c % 5 === 4 && c !== n - 1) cell.classList.add("edge-right");
      if (r % 5 === 4 && r !== n - 1) cell.classList.add("edge-bottom");
      grid.appendChild(cell);
    }
    grid.addEventListener("contextmenu", (e) => e.preventDefault());
    // The capture phase runs before dragSelect, so onDown already knows which button it was.
    grid.addEventListener("mousedown", (e) => (rightButton = e.button === 2), true);
    grid.addEventListener("touchstart", () => (rightButton = false), true);
    GK.dragSelect(grid, ".ng-cell", { start: onDown, move: onMove, end: onUp });
  }

  function buildLevels() {
    const row = $("levels");
    row.innerHTML = "";
    SIZES.forEach((s) => {
      const b = GK.el("button", "btn small" + (s.id === size.id ? " primary" : ""), s.name);
      b.type = "button";
      b.addEventListener("click", () => newPuzzle(s.id));
      row.appendChild(b);
    });
  }

  function render() {
    $("grid")
      .querySelectorAll(".ng-cell")
      .forEach((cell, i) => {
        cell.classList.toggle("on", cells[i] === FILLED);
        cell.classList.toggle("off", cells[i] === MARKED);
      });
    $("filled").textContent = cells.filter((v) => v === FILLED).length;
    $("modeBtn").textContent = "Mode: " + (fillMode === FILLED ? "fill" : "mark");

    // a clue fades once its line matches
    $("rowClues")
      .querySelectorAll(".ng-clue")
      .forEach((box, r) => {
        const line = [...Array(n).keys()].map((c) => (cells[r * n + c] === FILLED ? 1 : 0));
        box.classList.toggle("done", same(clueOf(line), rowClues[r]));
      });
    $("colClues")
      .querySelectorAll(".ng-clue")
      .forEach((box, c) => {
        const line = [...Array(n).keys()].map((r) => (cells[r * n + c] === FILLED ? 1 : 0));
        box.classList.toggle("done", same(clueOf(line), colClues[c]));
      });
  }

  function same(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  /* ---------- Input ---------- */

  function onDown(cell) {
    if (finished) return;
    const i = Number(cell.dataset.i);
    // left button fills, right button marks, whatever the mode button says
    const paint = rightButton ? MARKED : fillMode;
    const want = cells[i] === paint ? EMPTY : paint;
    paintWith = want;
    apply(i, want);
  }

  function onMove(cell) {
    if (finished || paintWith === null) return;
    apply(Number(cell.dataset.i), paintWith);
  }

  function onUp() {
    paintWith = null;
    rightButton = false;
    save();
    if (solved()) win();
  }

  function apply(i, value) {
    if (cells[i] === value) return;
    cells[i] = value;
    render();
  }

  function toggleMode() {
    fillMode = fillMode === FILLED ? MARKED : FILLED;
    render();
  }

  function clear() {
    if (finished) return;
    cells = new Array(n * n).fill(EMPTY);
    save();
    render();
  }

  function solved() {
    return answer.every((v, i) => (v === 1) === (cells[i] === FILLED));
  }

  function win() {
    finished = true;
    clock.stop();
    save();
    WG.stats.record("nonogram:" + size.id + ":" + mode, { won: true, daily: mode === "daily", day });
    WG.toast("Picture complete — " + clock.text(), 2400);
    setTimeout(openStats, 1200);
  }

  function newPuzzle(sizeId) {
    location.href = WG.pageUrl("nonogram.html", { size: sizeId, p: Math.floor(Math.random() * 100000) });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const s = WG.stats.load("nonogram:" + size.id + ":" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? "Solved" : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished ? size.name + " · " + clock.text() : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    const picture = [...Array(n).keys()]
      .map((r) =>
        [...Array(n).keys()].map((c) => (answer[r * n + c] ? "⬛" : "⬜")).join("")
      )
      .join("\n");
    return (
      "Nonogram " + label + " (" + size.name + ") " + clock.text() + "\n\n" + picture + "\n\n" +
      WG.pageUrl("nonogram.html", mode === "daily" ? { size: size.id } : { size: size.id, p: seed })
    );
  }
})();
