// Sudoku — a generated grid with a single solution, in three difficulty levels.
(function () {
  "use strict";

  const N = 9;
  const LEVELS = [
    { id: "easy", name: "Easy", clues: 42 },
    { id: "medium", name: "Medium", clues: 34 },
    { id: "hard", name: "Hard", clues: 27 },
  ];

  const $ = GK.$;
  const day = WG.dayNumber();

  let level = LEVELS[1];
  let mode = "daily";
  let seed = day;
  let puzzle = [];
  let solution = [];
  let cells = [];
  let notes = [];
  let picked = null;
  let noteMode = false;
  let wrong = new Set();
  let finished = false;
  let clock;

  WG.setupDialogs();
  init();

  function init() {
    const params = WG.params();
    const wanted = LEVELS.find((l) => l.id === params.get("level"));
    if (wanted) level = wanted;
    const p = params.get("p");
    if (p !== null && /^\d+$/.test(p)) {
      mode = "endless";
      seed = Number(p);
    }

    const made = makePuzzle(WG.seedFrom("sudoku", level.id, seed), level.clues);
    puzzle = made.puzzle;
    solution = made.solution;
    cells = puzzle.slice();
    notes = puzzle.map(() => []);

    const saved = WG.store.get(stateKey(), null);
    if (saved && Array.isArray(saved.cells) && saved.cells.length === 81) {
      cells = saved.cells.map((v, i) => (puzzle[i] ? puzzle[i] : v || 0));
      if (Array.isArray(saved.notes)) notes = saved.notes;
    }
    finished = cells.every((v, i) => v === solution[i]);

    $("subtitle").textContent = GK.subtitle(mode, day);
    $("levelName").textContent = level.name;
    clock = GK.timer($("clock"));
    clock.reset(saved && saved.ms ? saved.ms : 0);
    if (!finished) clock.start();

    build();
    buildPad();
    buildLevels();
    render();

    document.addEventListener("keydown", onKey);
    $("noteBtn").addEventListener("click", toggleNotes);
    $("eraseBtn").addEventListener("click", () => setValue(0));
    $("checkBtn").addEventListener("click", check);
    $("newBtn").addEventListener("click", () => newPuzzle(level.id));
    $("againBtn").addEventListener("click", () => newPuzzle(level.id));
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    window.addEventListener("beforeunload", save);
    if (finished) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "sudoku:" + level.id + ":" + (mode === "daily" ? "d:" + day : "v:" + seed);
  }

  function save() {
    WG.store.set(stateKey(), { cells, notes, ms: clock.value(), done: finished });
  }

  /* ---------- Generating ---------- */

  function makePuzzle(s, clues) {
    const rand = WG.rng(s);
    const full = new Array(81).fill(0);
    fill(full, rand);
    const grid = full.slice();
    // Take numbers out one by one, keeping the solution unique.
    const order = WG.shuffle([...Array(81).keys()], rand);
    let left = 81;
    for (const i of order) {
      if (left <= clues) break;
      const keep = grid[i];
      grid[i] = 0;
      if (countSolutions(grid.slice(), 2) === 1) left--;
      else grid[i] = keep;
    }
    return { puzzle: grid, solution: full };
  }

  function fill(grid, rand) {
    const spot = grid.indexOf(0);
    if (spot === -1) return true;
    for (const value of WG.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rand)) {
      if (!allowed(grid, spot, value)) continue;
      grid[spot] = value;
      if (fill(grid, rand)) return true;
      grid[spot] = 0;
    }
    return false;
  }

  function countSolutions(grid, cap) {
    const spot = grid.indexOf(0);
    if (spot === -1) return 1;
    let found = 0;
    for (let value = 1; value <= 9; value++) {
      if (!allowed(grid, spot, value)) continue;
      grid[spot] = value;
      found += countSolutions(grid, cap - found);
      grid[spot] = 0;
      if (found >= cap) break;
    }
    return found;
  }

  function allowed(grid, spot, value) {
    const r = Math.floor(spot / N);
    const c = spot % N;
    const boxR = Math.floor(r / 3) * 3;
    const boxC = Math.floor(c / 3) * 3;
    for (let i = 0; i < N; i++) {
      if (grid[r * N + i] === value) return false;
      if (grid[i * N + c] === value) return false;
      const br = boxR + Math.floor(i / 3);
      const bc = boxC + (i % 3);
      if (grid[br * N + bc] === value) return false;
    }
    return true;
  }

  // Digits that clash with another one in the same row, column or box.
  function clashes() {
    const bad = new Set();
    for (let i = 0; i < 81; i++) {
      if (!cells[i]) continue;
      const r = Math.floor(i / N);
      const c = i % N;
      for (let j = 0; j < 81; j++) {
        if (j === i || cells[j] !== cells[i]) continue;
        const r2 = Math.floor(j / N);
        const c2 = j % N;
        const sameBox = Math.floor(r / 3) === Math.floor(r2 / 3) && Math.floor(c / 3) === Math.floor(c2 / 3);
        if (r === r2 || c === c2 || sameBox) bad.add(i);
      }
    }
    return bad;
  }

  /* ---------- Drawing ---------- */

  function build() {
    const box = $("grid");
    box.innerHTML = "";
    for (let i = 0; i < 81; i++) {
      const cell = GK.el("button", "sk-cell");
      cell.type = "button";
      cell.dataset.i = i;
      const c = i % N;
      const r = Math.floor(i / N);
      if (c % 3 === 2 && c !== 8) cell.classList.add("edge-right");
      if (r % 3 === 2 && r !== 8) cell.classList.add("edge-bottom");
      cell.setAttribute("aria-label", "Row " + (r + 1) + ", column " + (c + 1));
      cell.addEventListener("click", () => {
        picked = i;
        render();
      });
      cell.addEventListener("mousedown", (e) => e.preventDefault());
      box.appendChild(cell);
    }
  }

  function buildPad() {
    const pad = $("pad");
    pad.innerHTML = "";
    for (let v = 1; v <= 9; v++) {
      const b = GK.el("button", "sk-key", String(v));
      b.type = "button";
      b.addEventListener("click", () => setValue(v));
      b.addEventListener("mousedown", (e) => e.preventDefault());
      pad.appendChild(b);
    }
  }

  function buildLevels() {
    const row = $("levels");
    row.innerHTML = "";
    LEVELS.forEach((l) => {
      const b = GK.el("button", "btn small" + (l.id === level.id ? " primary" : ""), l.name);
      b.type = "button";
      b.addEventListener("click", () => newPuzzle(l.id));
      row.appendChild(b);
    });
  }

  function render() {
    const bad = clashes();
    const focus = picked === null ? null : cells[picked];
    $("grid")
      .querySelectorAll(".sk-cell")
      .forEach((cell, i) => {
        const value = cells[i];
        const r = Math.floor(i / N);
        const c = i % N;
        const classes = ["sk-cell"];
        if (c % 3 === 2 && c !== 8) classes.push("edge-right");
        if (r % 3 === 2 && r !== 8) classes.push("edge-bottom");
        if (puzzle[i]) classes.push("given");
        if (picked === i) classes.push("picked");
        if (bad.has(i)) classes.push("bad");
        if (wrong.has(i)) classes.push("wrong");
        if (value && focus && value === focus && picked !== i) classes.push("same");
        cell.className = classes.join(" ");
        if (value) {
          cell.textContent = value;
        } else if (notes[i] && notes[i].length) {
          cell.innerHTML = '<span class="sk-notes">' + notes[i].slice().sort().join(" ") + "</span>";
        } else {
          cell.textContent = "";
        }
      });
    $("emptyCount").textContent = cells.filter((v) => !v).length;
    $("noteBtn").textContent = "Notes: " + (noteMode ? "on" : "off");
  }

  /* ---------- Input ---------- */

  function onKey(e) {
    if (WG.anyDialogOpen() || e.metaKey || e.ctrlKey) return;
    if (/^[1-9]$/.test(e.key)) {
      setValue(Number(e.key));
    } else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") {
      setValue(0);
    } else if (e.key === "n") {
      toggleNotes();
    } else if (e.key.startsWith("Arrow") && picked !== null) {
      e.preventDefault();
      const r = Math.floor(picked / N);
      const c = picked % N;
      const dr = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      const dc = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
      picked = WG.mod(r + dr, N) * N + WG.mod(c + dc, N);
      render();
    }
  }

  function toggleNotes() {
    noteMode = !noteMode;
    render();
  }

  function setValue(value) {
    if (finished || picked === null || puzzle[picked]) return;
    wrong.delete(picked);
    if (noteMode && value) {
      const list = notes[picked] || (notes[picked] = []);
      const at = list.indexOf(value);
      at === -1 ? list.push(value) : list.splice(at, 1);
      cells[picked] = 0;
    } else {
      cells[picked] = value;
      notes[picked] = [];
    }
    save();
    render();
    if (value && cells.every((v, i) => v === solution[i])) win();
  }

  function check() {
    wrong = new Set();
    cells.forEach((v, i) => {
      if (v && v !== solution[i]) wrong.add(i);
    });
    render();
    const n = wrong.size;
    WG.toast(n ? n + " wrong " + (n === 1 ? "square" : "squares") : "Everything fits so far", 2200);
  }

  function win() {
    finished = true;
    clock.stop();
    save();
    WG.stats.record("sudoku:" + level.id + ":" + mode, { won: true, daily: mode === "daily", day });
    WG.toast("Solved in " + clock.text(), 2400);
    setTimeout(openStats, 1200);
  }

  function newPuzzle(levelId) {
    location.href = WG.pageUrl("sudoku.html", { level: levelId, p: Math.floor(Math.random() * 100000) });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const s = WG.stats.load("sudoku:" + level.id + ":" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? "Solved" : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished ? level.name + " · " + clock.text() : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    return (
      "Sudoku " + label + " (" + level.name + ")\n" +
      "Solved in " + clock.text() + "\n\n" +
      WG.pageUrl("sudoku.html", mode === "daily" ? { level: level.id } : { level: level.id, p: seed })
    );
  }
})();
