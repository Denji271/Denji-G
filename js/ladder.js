// Word Ladder — change one letter at a time to get from the first word to the last.
(function () {
  "use strict";

  const LEN = 4;
  const MIN_PATH = 3;
  const MAX_PATH = 5;

  const $ = GK.$;
  const day = WG.dayNumber();

  let words = [];
  let wordSet = new Set();
  let alphabet = new Set();
  let neighbours = new Map();
  let mode = "daily";
  let seed = day;
  let start = "";
  let target = "";
  let best = 0;
  let chain = [];
  let current = "";
  let finished = false;

  WG.setupDialogs();
  WG.loadData().then(init, (err) => WG.toast(err.message, 6000));

  function init(data) {
    words = WG.splitWords(data.beeWords).filter((w) => [...w].length === LEN);
    wordSet = new Set(words);
    words.forEach((w) => [...w].forEach((ch) => alphabet.add(ch)));
    buildGraph();

    const p = WG.params().get("p");
    if (p !== null && /^\d+$/.test(p)) {
      mode = "endless";
      seed = Number(p);
    }
    const puzzle = makePuzzle(seed);
    start = puzzle.start;
    target = puzzle.target;
    best = puzzle.length;

    $("subtitle").textContent = GK.subtitle(mode, day);
    $("best").textContent = best + " steps";

    const saved = WG.store.get(stateKey(), null);
    chain = [start];
    if (saved && Array.isArray(saved.chain)) {
      saved.chain.forEach((w) => {
        if (w !== start && isStep(chain[chain.length - 1], w)) chain.push(w);
      });
    }
    finished = chain[chain.length - 1] === target;

    GK.keypad($("keyboard"), GK.letterRows(alphabet), {
      key: addLetter,
      enter: submit,
      delete: backspace,
    });
    render();

    document.addEventListener("keydown", onKey);
    $("undoBtn").addEventListener("click", undo);
    $("giveUpBtn").addEventListener("click", giveUp);
    $("newBtn").addEventListener("click", newPuzzle);
    $("againBtn").addEventListener("click", newPuzzle);
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    if (finished) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "ladder:" + (mode === "daily" ? "d:" + day : "v:" + seed);
  }

  /* ---------- Word graph ---------- */

  function buildGraph() {
    const buckets = new Map();
    words.forEach((w) => {
      for (let i = 0; i < LEN; i++) {
        const key = w.slice(0, i) + "*" + w.slice(i + 1);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(w);
      }
    });
    words.forEach((w) => neighbours.set(w, new Set()));
    buckets.forEach((list) => {
      list.forEach((a) => {
        list.forEach((b) => {
          if (a !== b) neighbours.get(a).add(b);
        });
      });
    });
  }

  function isStep(from, to) {
    if (!wordSet.has(to) || [...to].length !== LEN) return false;
    let diff = 0;
    for (let i = 0; i < LEN; i++) if (from[i] !== to[i]) diff++;
    return diff === 1;
  }

  // Breadth-first search: returns a route to the target, or null.
  function shortestPath(from, to) {
    const prev = new Map([[from, null]]);
    let queue = [from];
    while (queue.length) {
      const next = [];
      for (const w of queue) {
        if (w === to) {
          const path = [];
          for (let node = to; node !== null; node = prev.get(node)) path.unshift(node);
          return path;
        }
        neighbours.get(w).forEach((n) => {
          if (prev.has(n)) return;
          prev.set(n, w);
          next.push(n);
        });
      }
      queue = next;
    }
    return null;
  }

  // Looks for a pair whose shortest route is between MIN_PATH and MAX_PATH steps.
  function makePuzzle(s) {
    const rand = WG.rng(WG.seedFrom("ladder", s));
    const pool = words.filter((w) => neighbours.get(w).size >= 2);
    for (let i = 0; i < 400 && pool.length; i++) {
      const from = WG.pick(pool, rand);
      const reach = bfsDistances(from);
      const good = [];
      reach.forEach((dist, word) => {
        if (dist >= MIN_PATH && dist <= MAX_PATH) good.push(word);
      });
      if (good.length) {
        const to = WG.pick(good.sort(), rand);
        return { start: from, target: to, length: reach.get(to) };
      }
    }
    // fallback: any neighbouring pair
    const from = pool[0] || words[0];
    const to = [...neighbours.get(from)][0] || from;
    return { start: from, target: to, length: 1 };
  }

  function bfsDistances(from) {
    const dist = new Map([[from, 0]]);
    let queue = [from];
    let d = 0;
    while (queue.length && d < MAX_PATH) {
      const next = [];
      d++;
      for (const w of queue) {
        neighbours.get(w).forEach((n) => {
          if (dist.has(n)) return;
          dist.set(n, d);
          next.push(n);
        });
      }
      queue = next;
    }
    return dist;
  }

  /* ---------- Drawing ---------- */

  function render() {
    const box = $("ladder");
    box.innerHTML = "";
    chain.forEach((word, i) => box.appendChild(rowOf(word, i === 0 ? "start" : "done")));
    if (!finished) box.appendChild(rowOf(current.padEnd(LEN, " "), "typing"));
    box.appendChild(rowOf(target, "target"));
    $("steps").textContent = chain.length - 1;
    $("undoBtn").disabled = chain.length < 2;
  }

  function rowOf(word, kind) {
    const row = GK.el("div", "ladder-row " + kind);
    [...word].forEach((ch, i) => {
      const tile = GK.el("div", "tile");
      if (ch !== " ") tile.textContent = ch;
      if (kind === "typing") {
        if (ch !== " ") tile.classList.add("filled");
      } else if (kind === "target") {
        tile.classList.add("correct");
      } else if (ch === target[i]) {
        tile.classList.add("correct");
      } else {
        tile.classList.add("filled");
      }
      row.appendChild(tile);
    });
    return row;
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
      if (alphabet.has(ch)) addLetter(ch);
    }
  }

  function addLetter(ch) {
    if (finished || [...current].length >= LEN) return;
    current += ch;
    render();
  }

  function backspace() {
    if (finished || !current) return;
    current = [...current].slice(0, -1).join("");
    render();
  }

  function shake() {
    const row = $("ladder").querySelector(".typing");
    if (!row) return;
    row.classList.remove("shake");
    void row.offsetWidth;
    row.classList.add("shake");
  }

  function submit() {
    if (finished) return;
    const word = current;
    const last = chain[chain.length - 1];
    let message = null;
    if ([...word].length < LEN) message = "Four letters, please";
    else if (word === last) message = "That is the same word";
    else if (chain.includes(word)) message = "Already used";
    else if (!wordSet.has(word)) message = "Not in word list";
    else if (!isStep(last, word)) message = "Change exactly one letter";

    if (message) {
      WG.toast(message);
      shake();
      return;
    }

    chain.push(word);
    current = "";
    finished = word === target;
    WG.store.set(stateKey(), { chain, done: finished });
    render();

    if (!finished) return;
    const steps = chain.length - 1;
    WG.stats.record("ladder:" + mode, { won: true, daily: mode === "daily", day });
    WG.toast(steps === best ? "Perfect — " + steps + " steps!" : "Done in " + steps + " steps", 2200);
    setTimeout(openStats, 1200);
  }

  function undo() {
    if (chain.length < 2 || finished) return;
    chain.pop();
    current = "";
    WG.store.set(stateKey(), { chain, done: false });
    render();
  }

  function giveUp() {
    const path = shortestPath(chain[chain.length - 1], target);
    if (!path) return WG.toast("No route to the target from here", 2600);
    WG.toast("One possible route: " + path.join(" → "), 6000);
  }

  function newPuzzle() {
    location.href = WG.pageUrl("ladder.html", { p: Math.floor(Math.random() * 100000) });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const s = WG.stats.load("ladder:" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? "Solved" : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished ? chain.length - 1 + " steps (shortest: " + best + ")" : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    return (
      "Word Ladder " + label + "\n" +
      start.toUpperCase() + " → " + target.toUpperCase() + ": " + (chain.length - 1) + " steps " +
      "(shortest: " + best + ")\n\n" +
      WG.pageUrl("ladder.html", mode === "daily" ? {} : { p: seed })
    );
  }
})();
