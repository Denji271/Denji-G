// Letter Boxed — chain words around a square without using one side twice in a row.
(function () {
  "use strict";

  const SIDES = 4;
  const PER_SIDE = 3;
  const MIN_LEN = 3;
  // Where each of the twelve letters sits, in percent of the board.
  const SPOTS = [
    [30, 8], [50, 8], [70, 8],
    [92, 30], [92, 50], [92, 70],
    [70, 92], [50, 92], [30, 92],
    [8, 70], [8, 50], [8, 30],
  ];

  const $ = GK.$;
  const day = WG.dayNumber();

  let words = new Set();
  let mode = "daily";
  let seed = day;
  let letters = [];
  let sideOf = {};
  let answer = [];
  let chain = [];
  let entry = "";
  let finished = false;

  WG.setupDialogs();
  WG.loadData().then(init, (err) => WG.toast(err.message, 6000));

  function init(data) {
    const list = WG.splitWords(data.beeWords);
    words = new Set(list);

    const p = WG.params().get("p");
    if (p !== null && /^\d+$/.test(p)) {
      mode = "endless";
      seed = Number(p);
    }
    const puzzle = makePuzzle(list, seed);
    letters = puzzle.letters;
    sideOf = puzzle.sideOf;
    answer = puzzle.answer;

    const saved = WG.store.get(stateKey(), null);
    if (saved && Array.isArray(saved.chain)) saved.chain.forEach(replay);
    finished = usedLetters().size === 12;

    $("subtitle").textContent = GK.subtitle(mode, day);
    build();
    render();

    $("deleteBtn").addEventListener("click", backspace);
    $("enterBtn").addEventListener("click", submit);
    $("giveUpBtn").addEventListener("click", showAnswer);
    $("newBtn").addEventListener("click", newPuzzle);
    $("againBtn").addEventListener("click", newPuzzle);
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    document.addEventListener("keydown", onKey);
    if (finished) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "letterboxed:" + (mode === "daily" ? "d:" + day : "v:" + seed);
  }

  function replay(word) {
    if (typeof word === "string" && problem(word) === null) chain.push(word);
  }

  /* ---------- Puzzle ---------- */

  // Two chained words that cover twelve distinct letters, split over four sides.
  function makePuzzle(list, s) {
    const rand = WG.rng(WG.seedFrom("letterboxed", s));
    const pool = list.filter((w) => w.length >= 5 && w.length <= 9 && new Set(w).size >= 5 && !doubled(w));
    const byFirst = new Map();
    pool.forEach((w) => {
      const key = w[0];
      if (!byFirst.has(key)) byFirst.set(key, []);
      byFirst.get(key).push(w);
    });

    for (let attempt = 0; attempt < 6000; attempt++) {
      const first = WG.pick(pool, rand);
      const set1 = new Set(first);
      if (set1.size < 6 || set1.size > 9) continue;
      const seconds = byFirst.get(first[first.length - 1]);
      if (!seconds) continue;
      for (let take = 0; take < 40; take++) {
        const second = WG.pick(seconds, rand);
        const union = new Set([...set1, ...second]);
        if (union.size !== SIDES * PER_SIDE) continue;
        const sides = splitSides([...union].sort(), edges([first, second]), rand);
        if (!sides) continue;
        return { letters: order(sides), sideOf: sides, answer: [first, second] };
      }
    }
    return { letters: [], sideOf: {}, answer: [] };
  }

  function doubled(word) {
    return [...word].some((ch, i) => i && ch === word[i - 1]);
  }

  // Letter pairs that follow each other in a word, so they need different sides.
  function edges(list) {
    const out = new Set();
    list.forEach((word) => {
      for (let i = 1; i < word.length; i++) out.add(word[i - 1] + word[i]);
    });
    return out;
  }

  // Colours the twelve letters with four sides, three letters each (backtracking).
  function splitSides(all, pairs, rand) {
    const order2 = WG.shuffle(all, rand);
    const sides = {};
    const count = [0, 0, 0, 0];
    const clash = (ch, side) =>
      order2.some((other) => sides[other] === side && (pairs.has(ch + other) || pairs.has(other + ch)));

    function step(i) {
      if (i === order2.length) return true;
      const ch = order2[i];
      for (let side = 0; side < SIDES; side++) {
        if (count[side] >= PER_SIDE || clash(ch, side)) continue;
        sides[ch] = side;
        count[side]++;
        if (step(i + 1)) return true;
        delete sides[ch];
        count[side]--;
      }
      return false;
    }
    return step(0) ? sides : null;
  }

  // Letters listed clockwise: top side first, then right, bottom, left.
  function order(sides) {
    const out = [];
    for (let side = 0; side < SIDES; side++) {
      Object.keys(sides)
        .filter((ch) => sides[ch] === side)
        .forEach((ch) => out.push(ch));
    }
    return out;
  }

  /* ---------- Rules ---------- */

  function usedLetters() {
    const used = new Set();
    chain.forEach((w) => [...w].forEach((ch) => used.add(ch)));
    return used;
  }

  // Returns an error message, or null when the word is playable.
  function problem(word) {
    if (word.length < MIN_LEN) return "At least three letters";
    if ([...word].some((ch) => sideOf[ch] === undefined)) return "That letter is not on the board";
    for (let i = 1; i < word.length; i++) {
      if (sideOf[word[i]] === sideOf[word[i - 1]]) return "Two letters from the same side";
    }
    if (chain.length && word[0] !== chain[chain.length - 1].slice(-1)) {
      return "Start with " + chain[chain.length - 1].slice(-1).toUpperCase();
    }
    if (chain.includes(word)) return "Already used";
    if (!words.has(word)) return "Not in word list";
    return null;
  }

  /* ---------- Drawing ---------- */

  function build() {
    const board = $("board");
    board.querySelectorAll(".lb-letter").forEach((b) => b.remove());
    letters.forEach((ch, i) => {
      const b = GK.el("button", "lb-letter", ch);
      b.type = "button";
      b.dataset.letter = ch;
      b.style.left = SPOTS[i][0] + "%";
      b.style.top = SPOTS[i][1] + "%";
      b.addEventListener("click", () => addLetter(ch));
      b.addEventListener("mousedown", (e) => e.preventDefault());
      board.appendChild(b);
    });
  }

  function spotOf(ch) {
    return SPOTS[letters.indexOf(ch)];
  }

  function render() {
    const used = usedLetters();
    $("usedLetters").textContent = used.size;
    $("wordCount").textContent = chain.length;
    $("chain").textContent = chain.join(" – ").toUpperCase();
    $("entry").textContent = entry.toUpperCase();

    $("board")
      .querySelectorAll(".lb-letter")
      .forEach((b) => {
        const ch = b.dataset.letter;
        b.classList.toggle("used", used.has(ch));
        b.classList.toggle("active", entry.includes(ch));
      });

    const svg = $("lines");
    svg.innerHTML = "";
    chain.forEach((word) => svg.appendChild(pathOf(word, "lb-old")));
    if (entry.length > 1) svg.appendChild(pathOf(entry, "lb-now"));
  }

  function pathOf(word, className) {
    const points = [...word].map((ch) => spotOf(ch)).filter(Boolean);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", points.map((p) => p.join(",")).join(" "));
    line.setAttribute("class", className);
    return line;
  }

  /* ---------- Input ---------- */

  function onKey(e) {
    if (WG.anyDialogOpen() || e.metaKey || e.ctrlKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      backspace();
    } else if (e.key.length === 1) {
      const ch = WG.normalizeLetter(e.key);
      if (sideOf[ch] !== undefined) addLetter(ch);
    }
  }

  function addLetter(ch) {
    if (finished) return;
    if (entry.length && sideOf[ch] === sideOf[entry.slice(-1)]) {
      shake();
      return WG.toast("Not twice from the same side");
    }
    entry += ch;
    render();
  }

  function backspace() {
    if (entry) {
      entry = entry.slice(0, -1);
    } else if (chain.length && !finished) {
      chain.pop();
      WG.store.set(stateKey(), { chain });
    }
    render();
  }

  function shake() {
    const box = $("entry");
    box.classList.remove("shake");
    void box.offsetWidth;
    box.classList.add("shake");
  }

  function submit() {
    if (finished || !entry) return;
    const message = problem(entry);
    if (message) {
      shake();
      return WG.toast(message);
    }
    chain.push(entry);
    // the next word carries on from the last letter
    entry = entry.slice(-1);
    finished = usedLetters().size === 12;
    WG.store.set(stateKey(), { chain, done: finished });
    if (finished) entry = "";
    render();

    if (!finished) return;
    WG.stats.record("letterboxed:" + mode, { won: true, daily: mode === "daily", day });
    WG.toast(chain.length <= 2 ? "Solved in " + chain.length + " words!" : "Solved in " + chain.length + " words", 2200);
    setTimeout(openStats, 1200);
  }

  function showAnswer() {
    WG.toast("One solution: " + answer.join(" – ").toUpperCase(), 6000);
  }

  function newPuzzle() {
    location.href = WG.pageUrl("letterboxed.html", { p: Math.floor(Math.random() * 100000) });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const s = WG.stats.load("letterboxed:" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? "Solved" : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished ? chain.length + " words" : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    return (
      "Letter Boxed " + label + "\n" +
      chain.length + " words, " + chain.reduce((sum, w) => sum + w.length, 0) + " letters\n\n" +
      WG.pageUrl("letterboxed.html", mode === "daily" ? {} : { p: seed })
    );
  }
})();
