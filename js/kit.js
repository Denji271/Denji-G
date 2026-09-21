// Shared building blocks for the newer games: keypad, stats panel, clock, grid helpers.
(function () {
  "use strict";

  const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M21 5H9l-6 7 6 7h12V5Z"/><path d="m12 9 6 6M18 9l-6 6"/></svg>';
  const ENTER_KEY = "⏎";
  const BACK_KEY = "⌫";
  const LETTER_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // rows: array of strings, one button per character.
  // GK.ENTER becomes the Enter key, GK.BACK becomes the backspace key.
  function keypad(container, rows, handlers) {
    container.innerHTML = "";
    rows.forEach((row) => {
      const line = el("div", "kb-row");
      [...row].forEach((ch) => {
        const key = el("button", "key");
        key.type = "button";
        if (ch === ENTER_KEY) {
          key.classList.add("wide");
          key.textContent = "Enter";
          key.addEventListener("click", handlers.enter);
        } else if (ch === BACK_KEY) {
          key.classList.add("wide");
          key.innerHTML = ICON_BACK;
          key.setAttribute("aria-label", "Backspace");
          key.addEventListener("click", handlers.delete);
        } else {
          key.textContent = ch;
          key.dataset.key = ch;
          key.addEventListener("click", () => handlers.key(ch));
        }
        // keep focus off the keys, otherwise Enter would press the last one again
        key.addEventListener("mousedown", (e) => e.preventDefault());
        line.appendChild(key);
      });
      container.appendChild(line);
    });
  }

  // The same layout Wordle uses, with Enter and backspace on the bottom row.
  function letterRows(alphabet) {
    const rows = LETTER_ROWS.map((row) => [...row].filter((ch) => !alphabet || alphabet.has(ch)).join("")).filter(
      (row) => row.length
    );
    rows[rows.length - 1] = ENTER_KEY + rows[rows.length - 1] + BACK_KEY;
    return rows;
  }

  function markKey(container, ch, state) {
    const key = container.querySelector('[data-key="' + ch + '"]');
    if (!key) return;
    const rank = { absent: 1, present: 2, correct: 3 };
    const prev = key.dataset.state;
    if (prev && rank[prev] >= rank[state]) return;
    key.dataset.state = state;
    key.classList.remove("absent", "present", "correct");
    key.classList.add(state);
  }

  // Fills the four numbers in the stats dialog (same layout as Wordle's).
  function fillStats(s, daily, day) {
    $("stPlayed").textContent = s.played;
    $("stWin").textContent = s.played ? Math.round((100 * s.wins) / s.played) : 0;
    $("stStreak").textContent = WG.stats.current(s, daily, day);
    $("stMax").textContent = s.maxStreak;
  }

  function timer(node) {
    let start = 0;
    let elapsed = 0;
    let ticker = null;
    function value() {
      return elapsed + (start ? Date.now() - start : 0);
    }
    function text() {
      const t = Math.floor(value() / 1000);
      return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
    }
    function draw() {
      if (node) node.textContent = text();
    }
    return {
      start() {
        if (!start) start = Date.now();
        clearInterval(ticker);
        ticker = setInterval(draw, 500);
        draw();
      },
      stop() {
        elapsed = value();
        start = 0;
        clearInterval(ticker);
        draw();
      },
      reset(ms) {
        elapsed = ms || 0;
        start = 0;
        clearInterval(ticker);
        draw();
      },
      value,
      text,
    };
  }

  // "#42" or "∞" — shows in the header which puzzle you are on.
  function subtitle(mode, day) {
    return mode === "daily" ? "#" + (day + 1) : "∞";
  }

  // Grid dragging that works with a mouse and with a finger alike.
  function dragSelect(container, cellSelector, callbacks) {
    let active = false;
    const cellAt = (x, y) => {
      const node = document.elementFromPoint(x, y);
      return node && node.closest ? node.closest(cellSelector) : null;
    };
    const down = (e) => {
      const point = e.touches ? e.touches[0] : e;
      const cell = cellAt(point.clientX, point.clientY);
      if (!cell) return;
      active = true;
      callbacks.start(cell);
      e.preventDefault();
    };
    const move = (e) => {
      if (!active) return;
      const point = e.touches ? e.touches[0] : e;
      const cell = cellAt(point.clientX, point.clientY);
      if (cell) callbacks.move(cell);
      e.preventDefault();
    };
    const up = () => {
      if (!active) return;
      active = false;
      callbacks.end();
    };
    container.addEventListener("mousedown", down);
    container.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("mousemove", move);
    container.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);
  }

  window.GK = {
    ENTER: ENTER_KEY,
    BACK: BACK_KEY,
    $,
    el,
    keypad,
    letterRows,
    markKey,
    fillStats,
    timer,
    subtitle,
    dragSelect,
  };
})();
