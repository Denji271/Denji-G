// Mastermind — four hidden colours, ten guesses, feedback after every try.
(function () {
  "use strict";

  const SLOTS = 4;
  const COLORS = 6;
  const ROWS = 10;
  const NAMES = ["red", "yellow", "green", "blue", "purple", "orange"];
  const SHARE_DOT = ["🔴", "🟡", "🟢", "🔵", "🟣", "🟠"];

  const $ = GK.$;
  const boardEl = $("board");
  const paletteEl = $("palette");

  let day = WG.dayNumber();
  let mode = "daily";
  let seed = 0;
  let code = [];
  let rows = [];
  let current = [];
  let finished = false;
  let won = false;

  WG.setupDialogs();
  init();

  function init() {
    const p = WG.params().get("p");
    if (p !== null && /^\d+$/.test(p)) {
      mode = "endless";
      seed = Number(p);
    } else {
      mode = "daily";
      seed = day;
    }
    code = makeCode(seed);
    $("subtitle").textContent = GK.subtitle(mode, day);

    const saved = WG.store.get(stateKey(), null);
    rows = saved && Array.isArray(saved.rows) ? saved.rows.filter(valid).slice(0, ROWS) : [];
    won = rows.some((g) => score(g).exact === SLOTS);
    finished = won || rows.length === ROWS;

    buildBoard();
    buildPalette();
    render();

    $("submitBtn").addEventListener("click", submit);
    $("clearBtn").addEventListener("click", () => {
      current = [];
      render();
    });
    $("newBtn").addEventListener("click", newGame);
    $("againBtn").addEventListener("click", newGame);
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    document.addEventListener("keydown", onKey);

    if (finished) setTimeout(openStats, 400);
  }

  function valid(g) {
    return Array.isArray(g) && g.length === SLOTS && g.every((c) => c >= 0 && c < COLORS);
  }

  function makeCode(s) {
    const rand = WG.rng(WG.seedFrom("mastermind", s));
    return Array.from({ length: SLOTS }, () => Math.floor(rand() * COLORS));
  }

  function stateKey() {
    return "mastermind:" + (mode === "daily" ? "d:" + day : "v:" + seed);
  }

  function statsKey() {
    return "mastermind:" + mode;
  }

  /* ---------- Scoring ---------- */

  function score(guess) {
    const left = new Array(COLORS).fill(0);
    const mine = new Array(COLORS).fill(0);
    let exact = 0;
    guess.forEach((c, i) => {
      if (c === code[i]) exact++;
      else {
        left[code[i]]++;
        mine[c]++;
      }
    });
    let color = 0;
    for (let c = 0; c < COLORS; c++) color += Math.min(left[c], mine[c]);
    return { exact, color };
  }

  /* ---------- Drawing ---------- */

  function buildBoard() {
    boardEl.innerHTML = "";
    for (let r = 0; r < ROWS; r++) {
      const row = GK.el("div", "mm-row");
      row.setAttribute("role", "listitem");
      const pegs = GK.el("div", "mm-pegs");
      for (let i = 0; i < SLOTS; i++) {
        const peg = GK.el("button", "peg");
        peg.type = "button";
        peg.dataset.slot = i;
        peg.addEventListener("click", () => {
          if (finished || r !== rows.length) return;
          // clicking a peg that is already down cycles through the colours
          current[i] = current[i] === undefined ? 0 : (current[i] + 1) % COLORS;
          render();
        });
        pegs.appendChild(peg);
      }
      const marks = GK.el("div", "mm-marks");
      for (let i = 0; i < SLOTS; i++) marks.appendChild(GK.el("span", "mark"));
      row.append(pegs, marks);
      boardEl.appendChild(row);
    }
  }

  function buildPalette() {
    paletteEl.innerHTML = "";
    for (let c = 0; c < COLORS; c++) {
      const b = GK.el("button", "peg pick c" + c);
      b.type = "button";
      b.textContent = c + 1;
      b.title = NAMES[c];
      b.setAttribute("aria-label", NAMES[c]);
      b.addEventListener("click", () => addColor(c));
      b.addEventListener("mousedown", (e) => e.preventDefault());
      paletteEl.appendChild(b);
    }
  }

  function paintRow(rowIndex, guess, marks) {
    const row = boardEl.children[rowIndex];
    const pegs = row.firstChild.children;
    for (let i = 0; i < SLOTS; i++) {
      const c = guess[i];
      pegs[i].className = "peg" + (c === undefined ? "" : " c" + c);
      pegs[i].textContent = c === undefined ? "" : c + 1;
    }
    const marksEl = row.lastChild.children;
    for (let i = 0; i < SLOTS; i++) {
      marksEl[i].className =
        "mark" + (!marks ? "" : i < marks.exact ? " exact" : i < marks.exact + marks.color ? " color" : "");
    }
  }

  function render() {
    for (let r = 0; r < ROWS; r++) {
      if (r < rows.length) paintRow(r, rows[r], score(rows[r]));
      else if (r === rows.length && !finished) paintRow(r, current, null);
      else paintRow(r, [], null);
      boardEl.children[r].classList.toggle("active", r === rows.length && !finished);
    }
    $("tries").textContent = rows.length;
    const active = boardEl.children[Math.min(rows.length, ROWS - 1)];
    if (active && rows.length > 4) active.scrollIntoView({ block: "nearest" });
  }

  /* ---------- Input ---------- */

  function addColor(c) {
    if (finished) return;
    if (current.length >= SLOTS) current = [];
    current.push(c);
    render();
  }

  function onKey(e) {
    if (WG.anyDialogOpen() || e.metaKey || e.ctrlKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finished ? newGame() : submit();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      current.pop();
      render();
    } else if (/^[1-6]$/.test(e.key)) {
      addColor(Number(e.key) - 1);
    }
  }

  function submit() {
    if (finished) return;
    if (current.length < SLOTS || current.some((c) => c === undefined)) {
      const row = boardEl.children[rows.length];
      row.classList.remove("shake");
      void row.offsetWidth;
      row.classList.add("shake");
      return WG.toast("Four pegs, please");
    }
    const guess = current.slice();
    rows.push(guess);
    current = [];
    const s = score(guess);
    won = s.exact === SLOTS;
    finished = won || rows.length === ROWS;
    WG.store.set(stateKey(), { rows, done: finished });
    render();

    if (!finished) return;
    WG.stats.record(statsKey(), { won, daily: mode === "daily", day });
    WG.toast(won ? "Cracked it in " + rows.length + "!" : "Out of guesses", 2200);
    setTimeout(openStats, 1200);
  }

  function newGame() {
    const next = Math.floor(Math.random() * 100000);
    location.href = WG.pageUrl("mastermind.html", { p: next });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const s = WG.stats.load(statsKey());
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? (won ? "Cracked" : "Out of guesses") : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished
      ? won
        ? rows.length + "/" + ROWS
        : "The code was " + code.map((c) => c + 1).join(" ")
      : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    const grid = rows
      .map((g) => {
        const s = score(g);
        return (
          g.map((c) => SHARE_DOT[c]).join("") +
          " " +
          "●".repeat(s.exact) +
          "○".repeat(s.color)
        );
      })
      .join("\n");
    return (
      "Mastermind " + label + " " + (won ? rows.length : "X") + "/" + ROWS + "\n\n" + grid + "\n\n" +
      WG.pageUrl("mastermind.html", mode === "daily" ? {} : { p: seed })
    );
  }
})();
