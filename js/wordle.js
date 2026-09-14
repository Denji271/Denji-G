// Wordle — magyarul és angolul, napi és végtelen módban.
(function () {
  "use strict";

  const ROWS = 6;
  const LEN = 5;
  const FLIP_MS = 300;
  // "+" = Enter, "-" = törlés
  const KEY_ROWS = {
    en: ["qwertyuiop", "asdfghjkl", "+zxcvbnm-"],
    hu: ["öüóőúéáűí", "qwertzuiop", "asdfghjkl", "+yxcvbnm-"],
  };
  const PRAISE = ["Zseniális!", "Lenyűgöző!", "Csodás!", "Szép munka!", "Ügyes!", "Huhh, meglett!"];
  const EXAMPLES = {
    hu: [["ablak", 0, "correct", "jó helyen"], ["tükör", 1, "present", "rossz helyen"], ["virág", 3, "absent", "nincs benne"]],
    en: [["weary", 0, "correct", "jó helyen"], ["pills", 1, "present", "rossz helyen"], ["vague", 3, "absent", "nincs benne"]],
  };
  const STATE_RANK = { absent: 1, present: 2, correct: 3 };
  const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M21 5H9l-6 7 6 7h12V5Z"/><path d="m12 9 6 6M18 9l-6 6"/></svg>';

  const lang = WG.getLang();
  const $ = (id) => document.getElementById(id);
  const boardEl = $("board");
  const kbEl = $("keyboard");

  let words, answers, alphabet, day;
  let mode, answer, code; // mode: "daily" | "endless" | "challenge"
  let guesses = [];
  let current = "";
  let locked = true;
  let finished = false;
  let won = false;
  let gameId = 0; // új játéknál nő, így a régi animációk nem nyúlnak bele

  WG.setupDialogs();
  WG.setupLangSwitch(lang);
  WG.loadData(lang).then(init, (err) => WG.toast(err.message, 6000));

  function init(data) {
    answers = WG.splitWords(data.wordleAnswers);
    words = new Set(WG.splitWords(data.wordleGuesses).concat(answers));
    alphabet = new Set();
    words.forEach((w) => {
      for (const ch of w) alphabet.add(ch);
    });
    day = WG.dayNumber();

    renderExamples();
    setupChallenge();
    $("statsBtn").addEventListener("click", openStats);
    $("endlessBtn").addEventListener("click", newEndlessGame);
    $("newBtn").addEventListener("click", newEndlessGame);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", sizeBoard);

    const params = WG.params();
    const c = params.get("c");
    const decoded = c ? WG.decodeWord(c) : null;
    if (isPlayable(decoded)) {
      startGame(params.has("v") ? "endless" : "challenge", decoded, c);
    } else {
      if (c) WG.toast("Hibás link", 2000);
      startGame("daily", answers[WG.mod(day, answers.length)], null);
    }
    if (finished) setTimeout(openStats, 500);
  }

  function isPlayable(w) {
    return !!w && [...w].length === LEN && [...w].every((ch) => alphabet.has(ch));
  }

  /* ---------- Játék indítása, mentés ---------- */

  function stateKey() {
    if (mode === "daily") return "wordle:" + lang + ":d:" + day;
    if (mode === "endless") return "wordle:" + lang + ":v";
    return "wordle:" + lang + ":c:" + code;
  }

  function startGame(newMode, word, newCode) {
    gameId++;
    mode = newMode;
    answer = word;
    code = newCode;
    guesses = [];
    current = "";
    finished = false;
    won = false;
    $("subtitle").textContent = lang.toUpperCase() + " · " + (mode === "daily" ? "#" + (day + 1) : mode === "endless" ? "∞" : "kihívás");
    buildBoard();
    buildKeyboard();
    sizeBoard();

    const saved = WG.store.get(stateKey(), null);
    if (saved && Array.isArray(saved.guesses) && (mode !== "endless" || saved.code === code)) {
      saved.guesses
        .filter((g) => typeof g === "string" && [...g].length === LEN)
        .slice(0, ROWS)
        .forEach((g) => {
          if (won) return;
          const result = evaluate(g, answer);
          guesses.push(g);
          paintRow(guesses.length - 1, g, result);
          updateKeys(g, result);
          won = result.every((r) => r === "correct");
        });
      finished = won || guesses.length === ROWS;
    }
    locked = false;
  }

  function newEndlessGame() {
    let w;
    do {
      w = answers[Math.floor(Math.random() * answers.length)];
    } while (w === answer && answers.length > 1);
    const c = WG.encodeWord(w);
    WG.store.set("wordle:" + lang + ":v", null);
    history.replaceState(null, "", WG.pageUrl("wordle.html", { lang, c, v: "1" }));
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    startGame("endless", w, c);
  }

  function save() {
    WG.store.set(stateKey(), { code, guesses, done: finished, won });
  }

  function evaluate(guess, target) {
    const g = [...guess];
    const t = [...target];
    const result = new Array(LEN).fill("absent");
    const remaining = {};
    for (let i = 0; i < LEN; i++) {
      if (g[i] === t[i]) result[i] = "correct";
      else remaining[t[i]] = (remaining[t[i]] || 0) + 1;
    }
    for (let i = 0; i < LEN; i++) {
      if (result[i] !== "correct" && remaining[g[i]] > 0) {
        result[i] = "present";
        remaining[g[i]]--;
      }
    }
    return result;
  }

  /* ---------- Rajzolás ---------- */

  function buildBoard() {
    boardEl.innerHTML = "";
    for (let r = 0; r < ROWS; r++) {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("role", "row");
      for (let i = 0; i < LEN; i++) {
        const tile = document.createElement("div");
        tile.className = "tile";
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
      64,
      (wrap.clientHeight - 20 - gap * (ROWS - 1)) / ROWS,
      (wrap.clientWidth - 20 - gap * (LEN - 1)) / LEN
    );
    const size = Math.max(26, Math.floor(fit));
    boardEl.style.width = size * LEN + gap * (LEN - 1) + "px";
    boardEl.style.height = size * ROWS + gap * (ROWS - 1) + "px";
    boardEl.style.fontSize = Math.round(size * 0.52) + "px";
  }

  function buildKeyboard() {
    kbEl.innerHTML = "";
    KEY_ROWS[lang].forEach((letters, rowIndex) => {
      const row = document.createElement("div");
      row.className = "kb-row";
      for (const ch of letters) {
        if (ch !== "+" && ch !== "-" && !alphabet.has(ch)) continue;
        const key = document.createElement("button");
        key.type = "button";
        key.className = "key";
        if (lang === "hu" && rowIndex === 0) key.classList.add("accent-row");
        if (ch === "+") {
          key.classList.add("wide");
          key.textContent = "Enter";
          key.addEventListener("click", onEnter);
        } else if (ch === "-") {
          key.classList.add("wide");
          key.innerHTML = ICON_BACK;
          key.setAttribute("aria-label", "Törlés");
          key.addEventListener("click", backspace);
        } else {
          key.textContent = ch;
          key.dataset.key = ch;
          key.addEventListener("click", () => addLetter(ch));
        }
        // ne kapjon fókuszt, különben az Enter újra "megnyomná" a gombot
        key.addEventListener("mousedown", (e) => e.preventDefault());
        row.appendChild(key);
      }
      kbEl.appendChild(row);
    });
  }

  function paintRow(rowIndex, guess, result) {
    const tiles = boardEl.children[rowIndex].children;
    [...guess].forEach((ch, i) => {
      tiles[i].textContent = ch;
      tiles[i].className = "tile " + result[i];
    });
  }

  function renderCurrent() {
    const tiles = boardEl.children[guesses.length].children;
    const letters = [...current];
    for (let i = 0; i < LEN; i++) {
      tiles[i].textContent = letters[i] || "";
      tiles[i].classList.toggle("filled", !!letters[i]);
    }
  }

  function updateKeys(guess, result) {
    [...guess].forEach((ch, i) => {
      const key = kbEl.querySelector('[data-key="' + ch + '"]');
      if (!key) return;
      const prev = key.dataset.state;
      if (!prev || STATE_RANK[result[i]] > STATE_RANK[prev]) {
        key.dataset.state = result[i];
        key.classList.remove("absent", "present", "correct");
        key.classList.add(result[i]);
      }
    });
  }

  function renderExamples() {
    const box = $("examples");
    box.innerHTML = "";
    EXAMPLES[lang].forEach(([word, index, state, caption]) => {
      const row = document.createElement("div");
      row.className = "example";
      [...word].forEach((ch, i) => {
        const tile = document.createElement("div");
        tile.className = "tile " + (i === index ? state : "filled");
        tile.textContent = ch;
        row.appendChild(tile);
      });
      const label = document.createElement("span");
      label.textContent = caption;
      row.appendChild(label);
      box.appendChild(row);
    });
  }

  /* ---------- Bevitel ---------- */

  function onKey(e) {
    if (WG.anyDialogOpen() || e.metaKey || (e.ctrlKey && !e.altKey)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      backspace();
    } else if (e.key.length === 1) {
      const ch = WG.normalizeLetter(e.key);
      if (alphabet.has(ch)) addLetter(ch);
    }
  }

  // Játék végén az Enter azonnal új szót indít.
  function onEnter() {
    if (finished && !locked) newEndlessGame();
    else submit();
  }

  function addLetter(ch) {
    if (locked || finished || [...current].length >= LEN) return;
    current += ch;
    renderCurrent();
  }

  function backspace() {
    if (locked || finished || !current) return;
    current = [...current].slice(0, -1).join("");
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
    if ([...current].length < LEN) return reject("Kevés a betű");
    if (!words.has(current) && current !== answer) return reject("Nincs a szólistában");

    const id = gameId;
    const guess = current;
    const result = evaluate(guess, answer);
    const rowIndex = guesses.length;
    guesses.push(guess);
    current = "";
    won = result.every((r) => r === "correct");
    finished = won || guesses.length === ROWS;
    save();
    if (finished) recordStats();

    locked = true;
    const tiles = boardEl.children[rowIndex].children;
    [...guess].forEach((ch, i) => {
      setTimeout(() => {
        tiles[i].classList.add("flip");
        setTimeout(() => {
          tiles[i].className = "tile flip " + result[i];
        }, 250);
        setTimeout(() => tiles[i].classList.remove("flip"), 520);
      }, i * FLIP_MS);
    });
    setTimeout(() => {
      if (id !== gameId) return;
      updateKeys(guess, result);
      locked = false;
      if (finished) celebrate(rowIndex, id);
    }, LEN * FLIP_MS + 260);
  }

  function celebrate(rowIndex, id) {
    if (won) {
      WG.toast(PRAISE[guesses.length - 1], 1600);
      [...boardEl.children[rowIndex].children].forEach((tile, i) => {
        setTimeout(() => tile.classList.add("bounce"), i * 100);
      });
    } else {
      WG.toast(answer.toUpperCase(), 2500);
    }
    setTimeout(() => {
      if (id === gameId) openStats();
    }, 1600);
  }

  /* ---------- Statisztika és megosztás ---------- */

  function statsKey() {
    return "wordle:" + lang + (mode === "endless" ? ":stats:v" : ":stats");
  }

  function loadStats() {
    return WG.store.get(statsKey(), null) || {
      played: 0, wins: 0, streak: 0, maxStreak: 0, dist: [0, 0, 0, 0, 0, 0], lastDay: null, lastWinDay: null,
    };
  }

  function recordStats() {
    if (mode === "challenge") return;
    const s = loadStats();
    if (mode === "daily") {
      if (s.lastDay === day) return;
      s.lastDay = day;
    }
    s.played++;
    if (won) {
      s.wins++;
      s.dist[guesses.length - 1]++;
      if (mode === "daily") {
        s.streak = s.lastWinDay === day - 1 ? s.streak + 1 : 1;
        s.lastWinDay = day;
      } else {
        s.streak++;
      }
      s.maxStreak = Math.max(s.maxStreak, s.streak);
    } else {
      s.streak = 0;
    }
    WG.store.set(statsKey(), s);
  }

  function openStats() {
    const hasStats = mode !== "challenge";
    $("statsBlock").hidden = !hasStats;
    if (hasStats) {
      const s = loadStats();
      const streakBroken = mode === "daily" && !(s.lastWinDay !== null && s.lastWinDay >= day - 1);
      $("statsHeading").textContent = mode === "daily" ? "Napi" : "Végtelen";
      $("stPlayed").textContent = s.played;
      $("stWin").textContent = s.played ? Math.round((100 * s.wins) / s.played) : 0;
      $("stStreak").textContent = streakBroken ? 0 : s.streak;
      $("stMax").textContent = s.maxStreak;

      const max = Math.max(1, ...s.dist);
      const dist = $("dist");
      dist.innerHTML = "";
      s.dist.forEach((n, i) => {
        const row = document.createElement("div");
        row.className = "dist-row";
        const label = document.createElement("span");
        label.className = "n";
        label.textContent = i + 1;
        const bar = document.createElement("div");
        bar.className = "dist-bar";
        if (finished && won && guesses.length === i + 1) bar.classList.add("hl");
        bar.style.width = Math.max(7, Math.round((100 * n) / max)) + "%";
        bar.textContent = n;
        row.append(label, bar);
        dist.appendChild(row);
      });
    }

    $("statsTitle").textContent = finished ? answer.toUpperCase() : "Statisztika";
    const resultWord = $("resultWord");
    resultWord.hidden = !finished;
    resultWord.textContent = finished ? (won ? guesses.length : "X") + "/6" : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
    if (finished) $("newBtn").focus();
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : mode === "endless" ? "∞" : "kihívás";
    const grid = guesses
      .map((g) => evaluate(g, answer).map((r) => (r === "correct" ? "🟩" : r === "present" ? "🟨" : "⬛")).join(""))
      .join("\n");
    const query = mode === "daily" ? { lang } : mode === "endless" ? { lang, c: code, v: "1" } : { lang, c: code };
    return "Wordle " + lang.toUpperCase() + " " + label + " " + (won ? guesses.length : "X") + "/6\n\n" +
      grid + "\n\n" + WG.pageUrl("wordle.html", query);
  }

  function setupChallenge() {
    const input = $("challengeInput");
    const error = $("challengeError");
    const result = $("challengeResult");
    let link = "";

    $("challengeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const w = [...input.value.trim()].map(WG.normalizeLetter).join("");
      result.hidden = true;
      error.textContent = "";
      if ([...w].length !== LEN) {
        error.textContent = "5 betű kell";
      } else if (!words.has(w)) {
        error.textContent = "Nincs a szólistában";
      } else {
        link = WG.pageUrl("wordle.html", { lang, c: WG.encodeWord(w) });
        $("challengeLink").value = link;
        result.hidden = false;
      }
    });
    $("challengeShare").addEventListener("click", () => {
      WG.share("Wordle kihívás (" + lang.toUpperCase() + "): " + link);
    });
    $("challengeDlg").addEventListener("close", () => {
      input.value = "";
      error.textContent = "";
      result.hidden = true;
    });
  }
})();
