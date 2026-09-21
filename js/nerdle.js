// Nerdle — Wordle with numbers: guess an eight-character equation.
(function () {
  "use strict";

  const LEN = 8;
  const ROWS = 6;
  const FLIP_MS = 240;
  const DIGITS = "0123456789";
  const OPS = "+-*/";
  const PRAISE = ["Genius!", "Magnificent!", "Impressive!", "Splendid!", "Great!", "Phew!"];

  const $ = GK.$;
  const boardEl = $("board");
  const kbEl = $("keyboard");

  const day = WG.dayNumber();
  let mode = "daily";
  let seed = 0;
  let answer = "";
  let guesses = [];
  let current = "";
  let finished = false;
  let won = false;
  let locked = false;

  WG.setupDialogs();
  init();

  function init() {
    const p = WG.params().get("p");
    if (p !== null && /^\d+$/.test(p)) {
      mode = "endless";
      seed = Number(p);
    } else {
      seed = day;
    }
    answer = makeEquation(seed);
    $("subtitle").textContent = GK.subtitle(mode, day);

    buildBoard();
    GK.keypad(kbEl, [DIGITS, OPS + "=" + GK.ENTER + GK.BACK], {
      key: addChar,
      enter: onEnter,
      delete: backspace,
    });

    const saved = WG.store.get(stateKey(), null);
    if (saved && Array.isArray(saved.guesses)) {
      saved.guesses.slice(0, ROWS).forEach((g) => {
        if (won || typeof g !== "string" || g.length !== LEN) return;
        const result = evaluate(g, answer);
        guesses.push(g);
        paintRow(guesses.length - 1, g, result);
        markKeys(g, result);
        won = result.every((r) => r === "correct");
      });
      finished = won || guesses.length === ROWS;
    }

    sizeBoard();
    window.addEventListener("resize", sizeBoard);
    document.addEventListener("keydown", onKey);
    $("newBtn").addEventListener("click", newGame);
    $("againBtn").addEventListener("click", newGame);
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    if (finished) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "nerdle:" + (mode === "daily" ? "d:" + day : "v:" + seed);
  }

  /* ---------- Puzzle ---------- */

  // Keeps drawing numbers until a true equation lands on exactly eight characters.
  function makeEquation(s) {
    const rand = WG.rng(WG.seedFrom("nerdle", s));
    for (let i = 0; i < 4000; i++) {
      const parts = rand() < 0.55 ? two(rand) : three(rand);
      if (!parts) continue;
      const value = calc(parts);
      if (value === null || value < 0 || !Number.isInteger(value)) continue;
      const text = parts.join("") + "=" + value;
      if (text.length === LEN && isValid(text)) return text;
    }
    return "13+37=50";
  }

  function two(rand) {
    const op = OPS[Math.floor(rand() * OPS.length)];
    const a = 1 + Math.floor(rand() * 99);
    const b = 1 + Math.floor(rand() * 99);
    if (op === "/" && (b === 0 || a % b)) return null;
    if (op === "-" && a < b) return null;
    return [String(a), op, String(b)];
  }

  function three(rand) {
    const first = two(rand);
    if (!first) return null;
    const op = OPS[Math.floor(rand() * 2)]; // only + and -, so the numbers still fit
    const c = 1 + Math.floor(rand() * 9);
    return first.concat([op, String(c)]);
  }

  /* ---------- Evaluating an expression ---------- */

  function tokens(text) {
    const out = [];
    let num = "";
    for (const ch of text) {
      if (DIGITS.includes(ch)) {
        num += ch;
      } else if (OPS.includes(ch)) {
        if (!num) return null;
        out.push(num, ch);
        num = "";
      } else {
        return null;
      }
    }
    if (!num) return null;
    out.push(num);
    return out;
  }

  function calc(parts) {
    const list = parts.slice();
    for (const t of list) {
      if (DIGITS.includes(t[0]) && t.length > 1 && t[0] === "0") return null;
    }
    // multiplication and division first
    for (let i = 1; i < list.length; i += 2) {
      if (list[i] !== "*" && list[i] !== "/") continue;
      const a = Number(list[i - 1]);
      const b = Number(list[i + 1]);
      if (list[i] === "/" && (b === 0 || a % b)) return null;
      const v = list[i] === "*" ? a * b : a / b;
      list.splice(i - 1, 3, String(v));
      i -= 2;
    }
    let value = Number(list[0]);
    for (let i = 1; i < list.length; i += 2) {
      value = list[i] === "+" ? value + Number(list[i + 1]) : value - Number(list[i + 1]);
      if (value < 0) return null;
    }
    return value;
  }

  function isValid(text) {
    const sides = text.split("=");
    if (sides.length !== 2) return false;
    const left = tokens(sides[0]);
    const right = tokens(sides[1]);
    if (!left || !right || right.length !== 1) return false;
    if (right[0].length > 1 && right[0][0] === "0") return false;
    const value = calc(left);
    return value !== null && value === Number(right[0]);
  }

  function evaluate(guess, target) {
    const result = new Array(LEN).fill("absent");
    const left = {};
    for (let i = 0; i < LEN; i++) {
      if (guess[i] === target[i]) result[i] = "correct";
      else left[target[i]] = (left[target[i]] || 0) + 1;
    }
    for (let i = 0; i < LEN; i++) {
      if (result[i] !== "correct" && left[guess[i]] > 0) {
        result[i] = "present";
        left[guess[i]]--;
      }
    }
    return result;
  }

  /* ---------- Drawing ---------- */

  function buildBoard() {
    boardEl.innerHTML = "";
    for (let r = 0; r < ROWS; r++) {
      const row = GK.el("div", "row");
      row.setAttribute("role", "row");
      for (let i = 0; i < LEN; i++) {
        const tile = GK.el("div", "tile");
        tile.setAttribute("role", "gridcell");
        row.appendChild(tile);
      }
      boardEl.appendChild(row);
    }
  }

  function sizeBoard() {
    const wrap = boardEl.parentElement;
    const gap = 5;
    const fit = Math.min(
      58,
      (wrap.clientHeight - 20 - gap * (ROWS - 1)) / ROWS,
      (wrap.clientWidth - 16 - gap * (LEN - 1)) / LEN
    );
    const size = Math.max(24, Math.floor(fit));
    boardEl.style.width = size * LEN + gap * (LEN - 1) + "px";
    boardEl.style.height = size * ROWS + gap * (ROWS - 1) + "px";
    boardEl.style.fontSize = Math.round(size * 0.5) + "px";
  }

  function paintRow(index, guess, result) {
    const tiles = boardEl.children[index].children;
    for (let i = 0; i < LEN; i++) {
      tiles[i].textContent = guess[i];
      tiles[i].className = "tile " + result[i];
    }
  }

  function renderCurrent() {
    const tiles = boardEl.children[guesses.length].children;
    for (let i = 0; i < LEN; i++) {
      tiles[i].textContent = current[i] || "";
      tiles[i].classList.toggle("filled", !!current[i]);
    }
  }

  function markKeys(guess, result) {
    for (let i = 0; i < LEN; i++) GK.markKey(kbEl, guess[i], result[i]);
  }

  /* ---------- Input ---------- */

  function onKey(e) {
    if (WG.anyDialogOpen() || e.metaKey || e.ctrlKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      backspace();
    } else if (e.key.length === 1 && (DIGITS + OPS + "=").includes(e.key)) {
      addChar(e.key);
    }
  }

  function onEnter() {
    finished ? newGame() : submit();
  }

  function addChar(ch) {
    if (locked || finished || current.length >= LEN) return;
    current += ch;
    renderCurrent();
  }

  function backspace() {
    if (locked || finished || !current) return;
    current = current.slice(0, -1);
    renderCurrent();
  }

  function reject(message) {
    const row = boardEl.children[guesses.length];
    row.classList.remove("shake");
    void row.offsetWidth;
    row.classList.add("shake");
    WG.toast(message);
  }

  function submit() {
    if (locked || finished) return;
    if (current.length < LEN) return reject("Eight characters, please");
    if (!current.includes("=")) return reject("An equation needs an = sign");
    if (!isValid(current)) return reject("That equation is not true");

    const guess = current;
    const result = evaluate(guess, answer);
    const index = guesses.length;
    guesses.push(guess);
    current = "";
    won = result.every((r) => r === "correct");
    finished = won || guesses.length === ROWS;
    WG.store.set(stateKey(), { guesses, done: finished });
    if (finished) WG.stats.record("nerdle:" + mode, { won, daily: mode === "daily", day });

    locked = true;
    const tiles = boardEl.children[index].children;
    for (let i = 0; i < LEN; i++) {
      setTimeout(() => {
        tiles[i].classList.add("flip");
        setTimeout(() => (tiles[i].className = "tile flip " + result[i]), 200);
        setTimeout(() => tiles[i].classList.remove("flip"), 460);
      }, i * FLIP_MS);
    }
    setTimeout(() => {
      markKeys(guess, result);
      locked = false;
      if (!finished) return;
      WG.toast(won ? PRAISE[guesses.length - 1] : answer, won ? 1600 : 2600);
      setTimeout(openStats, 1500);
    }, LEN * FLIP_MS + 220);
  }

  function newGame() {
    location.href = WG.pageUrl("nerdle.html", { p: Math.floor(Math.random() * 100000) });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const s = WG.stats.load("nerdle:" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? answer : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished ? (won ? guesses.length : "X") + "/" + ROWS : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    const grid = guesses
      .map((g) =>
        evaluate(g, answer)
          .map((r) => (r === "correct" ? "🟩" : r === "present" ? "🟪" : "⬛"))
          .join("")
      )
      .join("\n");
    return (
      "Nerdle " + label + " " + (won ? guesses.length : "X") + "/" + ROWS + "\n\n" + grid + "\n\n" +
      WG.pageUrl("nerdle.html", mode === "daily" ? {} : { p: seed })
    );
  }
})();
