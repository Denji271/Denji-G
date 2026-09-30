// Minesweeper — open every square that hides no mine; a number counts the mines around a square.
// The first click is always safe, and every board can be cleared by logic alone: the mines are laid
// again until a simple solver gets through the whole field without guessing.
(function () {
  "use strict";

  const LEVELS = [
    { id: "easy", name: "Beginner", w: 9, h: 9, mines: 10 },
    { id: "medium", name: "Intermediate", w: 16, h: 16, mines: 40 },
    { id: "hard", name: "Expert", w: 30, h: 16, mines: 99 },
  ];
  const HIDDEN = 0;
  const OPEN = 1;
  const FLAG = 2;
  const MAX_TRIES = 800; // Expert boards need about 30 tries on average; the count is fixed so the daily board is the same everywhere
  const LONG_PRESS = 380;
  const FLAG_SVG =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 17.5V3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7 3.2 15.5 6.4 7 9.6z" fill="#e05c4a"/><path d="M4 17.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const MINE_SVG =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v15M2.5 10h15M4.9 4.9l10.2 10.2M15.1 4.9 4.9 15.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="10" r="5.2" fill="currentColor"/><circle cx="8.3" cy="8.3" r="1.3" fill="#fff" opacity="0.7"/></svg>';

  const $ = GK.$;
  const day = WG.dayNumber();
  const narrow = matchMedia("(max-width: 639px)");

  let level = LEVELS[0];
  let mode = "daily";
  let seed = day;
  let W = 9;
  let H = 9;
  let N = 81;
  let NB = []; // the neighbours of every square
  let first = -1; // the first square opened; it also seeds where the mines go
  let mine = null; // 1 where a mine is
  let count = []; // mines around each square
  let state = []; // HIDDEN | OPEN | FLAG
  let boom = -1; // the mine that went off
  let finished = false;
  let lost = false;
  let flagMode = false;
  let els = []; // square index -> element
  let cols = 9; // columns on screen (Expert turns on its side on a phone)
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
    W = level.w;
    H = level.h;
    N = W * H;
    NB = [...Array(N).keys()].map(neighbours);
    state = new Array(N).fill(HIDDEN);

    const saved = WG.store.get(stateKey(), null);
    if (saved && Array.isArray(saved.state) && saved.state.length === N && saved.first >= 0) {
      first = saved.first;
      layMines(first);
      state = saved.state;
      lost = !!saved.lost;
      boom = saved.boom >= 0 ? saved.boom : -1;
      finished = !!saved.done || lost;
    }

    $("subtitle").textContent = GK.subtitle(mode, day);
    $("levelName").textContent = level.name;
    clock = GK.timer($("clock"));
    clock.reset(saved && saved.ms ? saved.ms : 0);
    if (first >= 0 && !finished) clock.start();

    build();
    buildLevels();
    render();
    narrow.addEventListener("change", () => {
      build();
      render();
    });

    const grid = $("grid");
    grid.addEventListener("contextmenu", (e) => e.preventDefault());
    grid.addEventListener("pointerdown", onDown);
    grid.addEventListener("pointerup", onUp);
    grid.addEventListener("pointercancel", cancelPress);
    grid.addEventListener("pointerleave", cancelPress);
    new ResizeObserver(fitText).observe(grid);

    $("modeBtn").addEventListener("click", () => {
      flagMode = !flagMode;
      render();
    });
    $("retryBtn").addEventListener("click", retry);
    $("newBtn").addEventListener("click", () => newGame(level.id));
    $("againBtn").addEventListener("click", () => newGame(level.id));
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    window.addEventListener("beforeunload", save);
    if (finished) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "mines:" + level.id + ":" + (mode === "daily" ? "d:" + day : "v:" + seed);
  }

  function save() {
    WG.store.set(stateKey(), { first, state, ms: clock.value(), done: finished, lost, boom });
  }

  function neighbours(i) {
    const r = Math.floor(i / W);
    const c = i % W;
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if ((dr || dc) && r + dr >= 0 && r + dr < H && c + dc >= 0 && c + dc < W) out.push((r + dr) * W + c + dc);
      }
    }
    return out;
  }

  /* ---------- Laying the mines ---------- */

  // Nothing within one square of the first click, and the board has to be solvable without guessing.
  function layMines(start) {
    const rand = WG.rng(WG.seedFrom("mines", level.id, seed, start));
    const clear = new Set(NB[start].concat(start));
    const pool = [];
    for (let i = 0; i < N; i++) if (!clear.has(i)) pool.push(i);
    let m = null;
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      m = new Uint8Array(N);
      const a = pool.slice();
      for (let k = 0; k < level.mines; k++) {
        const j = k + Math.floor(rand() * (a.length - k));
        const t = a[k];
        a[k] = a[j];
        a[j] = t;
        m[a[k]] = 1;
      }
      if (logicSolves(m, start)) break;
    }
    mine = m;
    count = [...Array(N).keys()].map((i) => NB[i].reduce((s, j) => s + m[j], 0));
  }

  // Plays the board with two plain rules — "all the mines are found" and "every square left is a mine",
  // also between two overlapping numbers — and says whether that clears it.
  function logicSolves(m, start) {
    const cnt = new Uint8Array(N);
    for (let i = 0; i < N; i++) cnt[i] = NB[i].reduce((s, j) => s + m[j], 0);
    const st = new Uint8Array(N);
    let opened = 0;
    const safe = N - level.mines;
    const open = (i) => {
      const stack = [i];
      while (stack.length) {
        const k = stack.pop();
        if (st[k]) continue;
        st[k] = OPEN;
        opened++;
        if (cnt[k] === 0) NB[k].forEach((j) => st[j] || stack.push(j));
      }
    };
    open(start);
    for (;;) {
      let changed = false;
      const rules = [];
      for (let i = 0; i < N; i++) {
        if (st[i] !== OPEN || !cnt[i]) continue;
        const unknown = [];
        let flags = 0;
        NB[i].forEach((j) => {
          if (st[j] === HIDDEN) unknown.push(j);
          else if (st[j] === FLAG) flags++;
        });
        if (!unknown.length) continue;
        const need = cnt[i] - flags;
        if (need === 0) {
          unknown.forEach(open);
          changed = true;
        } else if (need === unknown.length) {
          unknown.forEach((j) => (st[j] = FLAG));
          changed = true;
        } else {
          rules.push({ set: new Set(unknown), list: unknown, need });
        }
      }
      if (!changed) {
        // one number's unknown squares all inside another's: the difference is decided
        outer: for (const a of rules) {
          for (const b of rules) {
            if (a === b || a.list.length >= b.list.length || !a.list.every((j) => b.set.has(j))) continue;
            const rest = b.list.filter((j) => !a.set.has(j));
            const dn = b.need - a.need;
            if (dn === 0) rest.forEach(open);
            else if (dn === rest.length) rest.forEach((j) => (st[j] = FLAG));
            else continue;
            changed = true;
            break outer;
          }
        }
      }
      if (!changed) break;
    }
    return opened === safe;
  }

  /* ---------- Playing ---------- */

  function flood(i) {
    const stack = [i];
    while (stack.length) {
      const k = stack.pop();
      if (state[k] !== HIDDEN) continue;
      state[k] = OPEN;
      if (count[k] === 0) NB[k].forEach((j) => state[j] === HIDDEN && stack.push(j));
    }
  }

  function dig(i) {
    if (finished || state[i] === FLAG) return;
    if (first < 0) {
      first = i;
      layMines(i);
      clock.start();
    }
    if (state[i] === OPEN) {
      chord(i);
    } else if (mine[i]) {
      explode(i);
      return;
    } else {
      flood(i);
    }
    afterMove();
  }

  // A number with all its mines flagged opens everything else around it.
  function chord(i) {
    if (!count[i]) return;
    const flags = NB[i].filter((j) => state[j] === FLAG).length;
    if (flags !== count[i]) return;
    for (const j of NB[i]) {
      if (state[j] !== HIDDEN) continue;
      if (mine[j]) {
        explode(j);
        return;
      }
      flood(j);
    }
  }

  function toggleFlag(i) {
    if (finished || state[i] === OPEN) return;
    state[i] = state[i] === FLAG ? HIDDEN : FLAG;
    save();
    render();
  }

  function afterMove() {
    if (finished) return;
    let hidden = 0;
    for (let i = 0; i < N; i++) if (state[i] !== OPEN && !mine[i]) hidden++;
    if (hidden === 0) win();
    save();
    render();
  }

  function explode(i) {
    boom = i;
    lost = true;
    finished = true;
    clock.stop();
    WG.stats.record("mines:" + level.id + ":" + mode, { won: false, daily: mode === "daily", day });
    save();
    render();
    WG.toast("Boom! That was a mine.", 2000);
    setTimeout(openStats, 1400);
  }

  function win() {
    finished = true;
    for (let i = 0; i < N; i++) if (mine[i]) state[i] = FLAG;
    clock.stop();
    WG.stats.record("mines:" + level.id + ":" + mode, { won: true, daily: mode === "daily", day });
    WG.toast("Field cleared — " + clock.text(), 2400);
    setTimeout(openStats, 1200);
  }

  // The same board again from the first click (a daily loss still counts as a loss).
  function retry() {
    if (!lost) return;
    state = new Array(N).fill(HIDDEN);
    lost = false;
    finished = false;
    boom = -1;
    flood(first);
    clock.reset(0);
    clock.start();
    save();
    render();
  }

  function newGame(levelId) {
    location.href = WG.pageUrl("minesweeper.html", { level: levelId, p: Math.floor(Math.random() * 100000) });
  }

  /* ---------- Input ---------- */

  let press = null; // { i, timer, done }

  function cellOf(e) {
    const cell = e.target.closest && e.target.closest(".ms-cell");
    return cell ? Number(cell.dataset.i) : -1;
  }

  function onDown(e) {
    const i = cellOf(e);
    if (i < 0) return;
    cancelPress();
    if (e.button === 2) {
      toggleFlag(i);
      return;
    }
    if (e.button !== 0) return;
    press = { i, done: false, timer: 0 };
    // a finger held still plants a flag
    if (e.pointerType !== "mouse") {
      press.timer = setTimeout(() => {
        if (!press) return;
        press.done = true;
        toggleFlag(press.i);
        if (navigator.vibrate) navigator.vibrate(15);
      }, LONG_PRESS);
    }
  }

  function onUp(e) {
    if (!press) return;
    const p = press;
    clearTimeout(p.timer);
    press = null;
    if (p.done || cellOf(e) !== p.i) return;
    if (flagMode && state[p.i] !== OPEN) toggleFlag(p.i);
    else dig(p.i);
  }

  function cancelPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }

  /* ---------- Drawing ---------- */

  function build() {
    // Expert is wider than tall; on a phone it is shown turned on its side
    const tall = W > H && narrow.matches;
    cols = tall ? H : W;
    const rows = tall ? W : H;
    const grid = $("grid");
    grid.style.setProperty("--ms-cols", cols);
    grid.innerHTML = "";
    els = new Array(N);
    for (let dr = 0; dr < rows; dr++) {
      for (let dc = 0; dc < cols; dc++) {
        const i = tall ? dc * W + dr : dr * W + dc;
        const cell = GK.el("div", "ms-cell");
        cell.dataset.i = i;
        els[i] = cell;
        grid.appendChild(cell);
      }
    }
    fitText();
  }

  function fitText() {
    const grid = $("grid");
    grid.style.fontSize = Math.max(10, (grid.clientWidth / cols) * 0.55).toFixed(1) + "px";
  }

  function buildLevels() {
    const row = $("levels");
    row.innerHTML = "";
    LEVELS.forEach((l) => {
      const b = GK.el("button", "btn small" + (l.id === level.id ? " primary" : ""), l.name);
      b.type = "button";
      b.addEventListener("click", () => newGame(l.id));
      row.appendChild(b);
    });
  }

  function render() {
    let flags = 0;
    for (let i = 0; i < N; i++) {
      const cell = els[i];
      const s = state[i];
      if (s === FLAG) flags++;
      let cls = "ms-cell";
      let html = "";
      if (s === OPEN) {
        cls += " open";
        if (count[i]) {
          cls += " num";
          html = String(count[i]);
        }
      } else if (lost && mine[i] && s !== FLAG) {
        cls += i === boom ? " mine boom" : " mine";
        html = MINE_SVG;
      } else if (s === FLAG) {
        cls += lost && !mine[i] ? " flag wrong" : " flag";
        html = FLAG_SVG;
      }
      if (cell.className !== cls) cell.className = cls;
      if (s === OPEN && count[i]) cell.dataset.n = count[i];
      else delete cell.dataset.n;
      if (cell.innerHTML !== html) cell.innerHTML = html;
    }
    $("minesLeft").textContent = level.mines - flags;
    $("modeBtn").textContent = "Tap: " + (flagMode ? "flag" : "dig");
    $("modeBtn").classList.toggle("primary", flagMode);
    $("retryBtn").hidden = !lost;
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const s = WG.stats.load("mines:" + level.id + ":" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? (lost ? "Boom!" : "Cleared") : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished ? level.name + " · " + (lost ? "hit a mine" : clock.text()) : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    const result = lost ? "💥" : "✅ " + clock.text();
    return (
      "Minesweeper " + label + " (" + level.name + ") " + result + "\n" +
      WG.pageUrl("minesweeper.html", mode === "daily" ? { level: level.id } : { level: level.id, p: seed })
    );
  }
})();
