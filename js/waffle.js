// Waffle — six words jumbled into a 5x5 grid, swap the letters back into place.
(function () {
  "use strict";

  const N = 5;
  const SWAPS = 15;
  const HOLES = ["1,1", "1,3", "3,1", "3,3"];

  const $ = GK.$;
  const day = WG.dayNumber();

  let mode = "daily";
  let seed = day;
  let solution = [];
  let letters = [];
  let used = 0;
  let picked = null;
  let finished = false;

  WG.setupDialogs();
  WG.loadData().then(init, (err) => WG.toast(err.message, 6000));

  function init(data) {
    const p = WG.params().get("p");
    if (p !== null && /^\d+$/.test(p)) {
      mode = "endless";
      seed = Number(p);
    }
    const answers = WG.splitWords(data.wordleAnswers).filter((w) => [...w].length === N);
    const puzzle = makePuzzle(answers, seed);
    solution = puzzle.solution;
    letters = puzzle.start;

    const saved = WG.store.get(stateKey(), null);
    if (saved && Array.isArray(saved.letters) && saved.letters.length === 25) {
      letters = saved.letters;
      used = saved.used || 0;
    }
    finished = isSolved();

    $("subtitle").textContent = GK.subtitle(mode, day);
    build();
    render();

    $("resetBtn").addEventListener("click", reset);
    $("giveUpBtn").addEventListener("click", showSolution);
    $("newBtn").addEventListener("click", newPuzzle);
    $("againBtn").addEventListener("click", newPuzzle);
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    if (finished) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "waffle:" + (mode === "daily" ? "d:" + day : "v:" + seed);
  }

  function isHole(r, c) {
    return HOLES.includes(r + "," + c);
  }

  function index(r, c) {
    return r * N + c;
  }

  /* ---------- Puzzle ---------- */

  // Three across words and three down words; the letters at the crossings must match.
  function makePuzzle(answers, s) {
    const rand = WG.rng(WG.seedFrom("waffle", s));
    const byFirst = new Map();
    const byCross = new Map();
    answers.forEach((w) => {
      const chars = [...w];
      const first = chars[0];
      if (!byFirst.has(first)) byFirst.set(first, []);
      byFirst.get(first).push(w);
      const key = chars[0] + chars[2] + chars[4];
      if (!byCross.has(key)) byCross.set(key, []);
      byCross.get(key).push(w);
    });

    for (let attempt = 0; attempt < 20000; attempt++) {
      const r0 = [...WG.pick(answers, rand)];
      const cols = [];
      let ok = true;
      for (const i of [0, 2, 4]) {
        const pool = byFirst.get(r0[i]);
        if (!pool) {
          ok = false;
          break;
        }
        cols.push([...WG.pick(pool, rand)]);
      }
      if (!ok) continue;
      const key1 = cols[0][2] + cols[1][2] + cols[2][2];
      const key2 = cols[0][4] + cols[1][4] + cols[2][4];
      const pool1 = byCross.get(key1);
      const pool2 = byCross.get(key2);
      if (!pool1 || !pool2) continue;
      const r1 = [...WG.pick(pool1, rand)];
      const r2 = [...WG.pick(pool2, rand)];
      const words = [r0, r1, r2, cols[0], cols[1], cols[2]].map((w) => w.join(""));
      if (new Set(words).size < 6) continue;

      const grid = new Array(N * N).fill("");
      [r0, r1, r2].forEach((word, i) => word.forEach((ch, c) => (grid[index(i * 2, c)] = ch)));
      cols.forEach((word, i) => word.forEach((ch, r) => (grid[index(r, i * 2)] = ch)));
      return { solution: grid, start: scramble(grid, rand) };
    }
    return { solution: new Array(N * N).fill("a"), start: new Array(N * N).fill("a") };
  }

  // Scrambles the solved grid with a few cycles, so the cost of undoing it is known.
  // An m-long cycle takes m-1 swaps to undo, which keeps the jumble under SWAPS.
  function scramble(grid, rand) {
    const out = grid.slice();
    const spots = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) if (!isHole(r, c)) spots.push(index(r, c));
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      const pool = WG.shuffle(spots, rand);
      const moved = pool.slice(0, 16);
      const cycles = [];
      let at = 0;
      while (at < moved.length) {
        const size = Math.min(2 + Math.floor(rand() * 3), moved.length - at);
        if (size < 2) break;
        cycles.push(moved.slice(at, at + size));
        at += size;
      }
      const cost = cycles.reduce((sum, cycle) => sum + cycle.length - 1, 0);
      if (!cycles.length || cost > SWAPS - 3) continue;

      const next = grid.slice();
      cycles.forEach((cycle) => {
        cycle.forEach((cell, i) => {
          next[cell] = grid[cycle[(i + 1) % cycle.length]];
        });
      });
      // if repeated letters left the grid almost untouched, try another jumble
      const changed = spots.filter((i) => next[i] !== grid[i]).length;
      if (changed >= 8) return next;
    }
    return out;
  }

  /* ---------- Colouring ---------- */

  // Rows and columns are scored Wordle-style; a crossing cell keeps the better colour.
  function colours() {
    const rank = { absent: 0, present: 1, correct: 2 };
    const state = new Array(N * N).fill("absent");
    const set = (i, value) => {
      if (rank[value] > rank[state[i]]) state[i] = value;
    };
    for (const line of lines()) {
      const left = {};
      line.forEach((i) => {
        if (letters[i] === solution[i]) set(i, "correct");
        else left[solution[i]] = (left[solution[i]] || 0) + 1;
      });
      line.forEach((i) => {
        if (letters[i] === solution[i]) return;
        if (left[letters[i]] > 0) {
          set(i, "present");
          left[letters[i]]--;
        } else {
          set(i, "absent");
        }
      });
    }
    return state;
  }

  function lines() {
    const out = [];
    for (const r of [0, 2, 4]) out.push([0, 1, 2, 3, 4].map((c) => index(r, c)));
    for (const c of [0, 2, 4]) out.push([0, 1, 2, 3, 4].map((r) => index(r, c)));
    return out;
  }

  function isSolved() {
    return letters.every((ch, i) => ch === solution[i] || !solution[i]);
  }

  function solvedWords() {
    return lines().filter((line) => line.every((i) => letters[i] === solution[i])).length;
  }

  /* ---------- Drawing ---------- */

  function build() {
    const box = $("waffle");
    box.innerHTML = "";
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (isHole(r, c)) {
          box.appendChild(GK.el("div", "wf-hole"));
          continue;
        }
        const i = index(r, c);
        const cell = GK.el("button", "wf-cell");
        cell.type = "button";
        cell.dataset.i = i;
        cell.addEventListener("click", () => onCell(i));
        cell.addEventListener("mousedown", (e) => e.preventDefault());
        box.appendChild(cell);
      }
    }
  }

  function render() {
    const state = colours();
    $("waffle")
      .querySelectorAll(".wf-cell")
      .forEach((cell) => {
        const i = Number(cell.dataset.i);
        cell.textContent = letters[i];
        cell.className = "wf-cell " + state[i] + (picked === i ? " picked" : "");
      });
    $("left").textContent = Math.max(0, SWAPS - used);
    $("solved").textContent = solvedWords();
  }

  /* ---------- Swapping ---------- */

  function onCell(i) {
    if (finished) return;
    if (picked === null) {
      picked = i;
      render();
      return;
    }
    if (picked === i) {
      picked = null;
      render();
      return;
    }
    const a = picked;
    picked = null;
    if (letters[a] === letters[i]) {
      render();
      return WG.toast("Those two letters are the same");
    }
    [letters[a], letters[i]] = [letters[i], letters[a]];
    used++;
    finished = isSolved();
    WG.store.set(stateKey(), { letters, used, done: finished });
    render();

    if (finished) {
      WG.stats.record("waffle:" + mode, { won: true, daily: mode === "daily", day });
      WG.toast(used <= 10 ? "Flawless — " + used + " swaps!" : "Solved in " + used + " swaps", 2200);
      setTimeout(openStats, 1200);
    } else if (used >= SWAPS) {
      finished = true;
      WG.stats.record("waffle:" + mode, { won: false, daily: mode === "daily", day });
      WG.toast("Out of swaps", 2200);
      setTimeout(openStats, 1200);
    }
  }

  function reset() {
    if (!confirm("Start this puzzle over?")) return;
    WG.store.set(stateKey(), null);
    location.reload();
  }

  function showSolution() {
    letters = solution.slice();
    finished = true;
    render();
    WG.toast("Answer: " + lines().slice(0, 3).map((l) => l.map((i) => solution[i]).join("")).join(", "), 5000);
  }

  function newPuzzle() {
    location.href = WG.pageUrl("waffle.html", { p: Math.floor(Math.random() * 100000) });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const solved = isSolved();
    const s = WG.stats.load("waffle:" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = solved ? "Solved" : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = solved ? used + " swaps used, " + Math.max(0, SWAPS - used) + " left" : "Out of swaps";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const state = colours();
    const rows = [];
    for (let r = 0; r < N; r++) {
      let row = "";
      for (let c = 0; c < N; c++) {
        if (isHole(r, c)) row += "⬜";
        else row += state[index(r, c)] === "correct" ? "🟩" : state[index(r, c)] === "present" ? "🟨" : "⬛";
      }
      rows.push(row);
    }
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    return (
      "Waffle " + label + " " + (isSolved() ? used + " swaps" : "X") + "\n\n" +
      rows.join("\n") + "\n\n" +
      WG.pageUrl("waffle.html", mode === "daily" ? {} : { p: seed })
    );
  }
})();
