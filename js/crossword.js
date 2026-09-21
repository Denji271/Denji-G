// Mini Crossword — a 5x5 grid with short clues, one puzzle a day.
(function () {
  "use strict";

  const N = 5;
  const BLACK = "#";

  const $ = GK.$;
  const day = WG.dayNumber();

  let mode = "daily";
  let index = 0;
  let solution = [];
  let entries = [];
  let numbers = [];
  let slots = { across: [], down: [] };
  let letters = [];
  let wrong = new Set();
  let picked = 0;
  let direction = "across";
  let finished = false;
  let clock;

  WG.setupDialogs();
  WG.loadPacks().then(init, (err) => WG.toast(err.message, 6000));

  function init(packs) {
    const list = packs.crosswords;
    if (!list || !list.length) return WG.toast("No crosswords in this pack", 6000);
    const p = WG.params().get("p");
    const todayIndex = WG.mod(day, list.length);
    index = p !== null && /^\d+$/.test(p) && Number(p) < list.length ? Number(p) : todayIndex;
    mode = index === todayIndex ? "daily" : "endless";

    const puzzle = list[index];
    solution = puzzle.rows.flatMap((row) => [...row.toUpperCase()]);
    letters = solution.map((ch) => (ch === BLACK ? BLACK : ""));
    number();
    entries = slots.across.concat(slots.down);
    entries.forEach((slot, i) => {
      slot.clue = (slot.dir === "across" ? puzzle.across : puzzle.down)[
        (slot.dir === "across" ? slots.across : slots.down).indexOf(slot)
      ];
      slot.id = i;
    });

    const saved = WG.store.get(stateKey(), null);
    if (saved && Array.isArray(saved.letters) && saved.letters.length === N * N) {
      letters = saved.letters.map((ch, i) => (solution[i] === BLACK ? BLACK : ch || ""));
    }
    finished = letters.every((ch, i) => ch === solution[i]);
    picked = letters.findIndex((ch) => ch !== BLACK);

    $("subtitle").textContent = GK.subtitle(mode, day);
    $("total").textContent = solution.filter((ch) => ch !== BLACK).length;
    clock = GK.timer($("clock"));
    clock.reset(saved && saved.ms ? saved.ms : 0);
    if (!finished) clock.start();

    build();
    GK.keypad($("keyboard"), GK.letterRows(), { key: type, enter: nextSlot, delete: erase });
    render();

    document.addEventListener("keydown", onKey);
    $("activeClue").addEventListener("click", nextSlot);
    $("checkBtn").addEventListener("click", check);
    $("revealBtn").addEventListener("click", reveal);
    $("newBtn").addEventListener("click", newPuzzle);
    $("againBtn").addEventListener("click", newPuzzle);
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    window.addEventListener("beforeunload", save);
    if (finished) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "crossword:p:" + index;
  }

  function save() {
    WG.store.set(stateKey(), { letters, ms: clock.value(), done: finished });
  }

  /* ---------- Numbering ---------- */

  // Squares that start an across or down answer get a number, reading order.
  function number() {
    numbers = new Array(N * N).fill(0);
    slots = { across: [], down: [] };
    let next = 1;
    for (let i = 0; i < N * N; i++) {
      if (solution[i] === BLACK) continue;
      const r = Math.floor(i / N);
      const c = i % N;
      const startsAcross = c === 0 || solution[i - 1] === BLACK;
      const startsDown = r === 0 || solution[i - N] === BLACK;
      if (!startsAcross && !startsDown) continue;
      numbers[i] = next;
      if (startsAcross) slots.across.push(makeSlot(i, "across", next));
      if (startsDown) slots.down.push(makeSlot(i, "down", next));
      next++;
    }
  }

  function makeSlot(start, dir, num) {
    const step = dir === "across" ? 1 : N;
    const cells = [];
    for (let i = start; i < N * N; i += step) {
      if (solution[i] === BLACK) break;
      if (dir === "across" && Math.floor(i / N) !== Math.floor(start / N)) break;
      cells.push(i);
    }
    return { start, dir, num, cells, clue: "" };
  }

  function slotAt(cell, dir) {
    return slots[dir].find((slot) => slot.cells.includes(cell));
  }

  function currentSlot() {
    return slotAt(picked, direction) || slotAt(picked, direction === "across" ? "down" : "across");
  }

  /* ---------- Drawing ---------- */

  function build() {
    const grid = $("grid");
    grid.innerHTML = "";
    for (let i = 0; i < N * N; i++) {
      if (solution[i] === BLACK) {
        grid.appendChild(GK.el("div", "cw-cell black"));
        continue;
      }
      const cell = GK.el("button", "cw-cell");
      cell.type = "button";
      cell.dataset.i = i;
      if (numbers[i]) cell.appendChild(GK.el("span", "cw-num", numbers[i]));
      cell.appendChild(GK.el("span", "cw-letter", ""));
      cell.addEventListener("click", () => {
        if (picked === i) direction = direction === "across" ? "down" : "across";
        picked = i;
        render();
      });
      cell.addEventListener("mousedown", (e) => e.preventDefault());
      grid.appendChild(cell);
    }

    fillClueList("acrossList", slots.across, "across");
    fillClueList("downList", slots.down, "down");
  }

  function fillClueList(id, list, dir) {
    const box = $(id);
    box.innerHTML = "";
    list.forEach((slot) => {
      const li = GK.el("li", "", slot.num + ". " + slot.clue);
      li.dataset.slot = dir + ":" + slot.num;
      li.addEventListener("click", () => {
        direction = dir;
        picked = slot.cells.find((c) => !letters[c]) ?? slot.start;
        render();
      });
      box.appendChild(li);
    });
  }

  function render() {
    const slot = currentSlot();
    const active = slot ? slot.cells : [];
    $("grid")
      .querySelectorAll(".cw-cell")
      .forEach((cell) => {
        if (!cell.dataset.i) return;
        const i = Number(cell.dataset.i);
        cell.classList.toggle("picked", i === picked);
        cell.classList.toggle("active", active.includes(i) && i !== picked);
        cell.classList.toggle("wrong", wrong.has(i));
        cell.querySelector(".cw-letter").textContent = letters[i] || "";
      });

    document.querySelectorAll(".cw-clues li").forEach((li) => {
      li.classList.toggle("active", !!slot && li.dataset.slot === slot.dir + ":" + slot.num);
    });

    $("activeClue").textContent = slot ? slot.num + " " + slot.dir + " — " + slot.clue : "";
    $("filled").textContent = letters.filter((ch) => ch && ch !== BLACK).length;
  }

  /* ---------- Input ---------- */

  function onKey(e) {
    if (WG.anyDialogOpen() || e.metaKey || e.ctrlKey) return;
    if (/^[a-zA-Z]$/.test(e.key)) {
      type(e.key);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      erase();
    } else if (e.key === " " || e.key === "Tab") {
      e.preventDefault();
      e.key === " " ? (direction = direction === "across" ? "down" : "across") : nextSlot();
      render();
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      move(e.key);
    }
  }

  function type(ch) {
    if (finished) return;
    letters[picked] = ch.toUpperCase();
    wrong.delete(picked);
    save();
    advance();
    render();
    if (letters.every((v, i) => v === solution[i])) win();
  }

  function erase() {
    if (finished) return;
    if (letters[picked]) {
      letters[picked] = "";
    } else {
      stepBack();
      letters[picked] = "";
    }
    wrong.delete(picked);
    save();
    render();
  }

  // Jump to the next empty square of the answer, or the one right after.
  function advance() {
    const slot = currentSlot();
    if (!slot) return;
    const rest = slot.cells.slice(slot.cells.indexOf(picked) + 1);
    const empty = rest.find((c) => !letters[c]);
    if (empty !== undefined) picked = empty;
    else if (rest.length) picked = rest[0];
  }

  function stepBack() {
    const slot = currentSlot();
    if (!slot) return;
    const at = slot.cells.indexOf(picked);
    if (at > 0) picked = slot.cells[at - 1];
  }

  function move(key) {
    const r = Math.floor(picked / N);
    const c = picked % N;
    const dr = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
    const dc = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    if (dr) direction = "down";
    if (dc) direction = "across";
    for (let step = 1; step < N; step++) {
      const next = WG.mod(r + dr * step, N) * N + WG.mod(c + dc * step, N);
      if (solution[next] !== BLACK) {
        picked = next;
        break;
      }
    }
    render();
  }

  function nextSlot() {
    const slot = currentSlot();
    if (!slot) return;
    const all = slots.across.concat(slots.down);
    const at = all.indexOf(slot);
    const next = all[(at + 1) % all.length];
    direction = next.dir;
    picked = next.cells.find((c) => !letters[c]) ?? next.start;
    render();
  }

  function check() {
    wrong = new Set();
    letters.forEach((ch, i) => {
      if (ch && ch !== BLACK && ch !== solution[i]) wrong.add(i);
    });
    render();
    WG.toast(wrong.size ? wrong.size + " wrong " + (wrong.size === 1 ? "letter" : "letters") : "All correct so far", 2200);
  }

  function reveal() {
    const slot = currentSlot();
    if (!slot || finished) return;
    slot.cells.forEach((c) => {
      letters[c] = solution[c];
      wrong.delete(c);
    });
    save();
    render();
    if (letters.every((v, i) => v === solution[i])) win();
  }

  function win() {
    finished = true;
    clock.stop();
    save();
    WG.stats.record("crossword:" + mode, { won: true, daily: mode === "daily", day });
    WG.toast("Solved in " + clock.text(), 2400);
    setTimeout(openStats, 1200);
  }

  function newPuzzle() {
    const list = window.WORDGAME_PACKS.en.crosswords;
    let next = index;
    while (next === index && list.length > 1) next = Math.floor(Math.random() * list.length);
    location.href = WG.pageUrl("crossword.html", { p: next });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const s = WG.stats.load("crossword:" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? "Solved" : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished ? clock.text() : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "#" + (index + 1);
    return (
      "Mini Crossword " + label + "\n" + "Solved in " + clock.text() + "\n\n" +
      WG.pageUrl("crossword.html", mode === "daily" ? {} : { p: index })
    );
  }
})();
