// Wordle — napi szókitaláló, magyarul és angolul.
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
    hu: [
      ["ablak", 0, "correct", "Az <b>A</b> benne van a szóban, és jó helyen áll."],
      ["tükör", 1, "present", "Az <b>Ü</b> benne van a szóban, de nem ezen a helyen."],
      ["virág", 3, "absent", "Az <b>Á</b> nincs benne a szóban."],
    ],
    en: [
      ["weary", 0, "correct", "A <b>W</b> benne van a szóban, és jó helyen áll."],
      ["pills", 1, "present", "Az <b>I</b> benne van a szóban, de nem ezen a helyen."],
      ["vague", 3, "absent", "Az <b>U</b> nincs benne a szóban."],
    ],
  };
  const STATE_RANK = { absent: 1, present: 2, correct: 3 };
  const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M21 5H9l-6 7 6 7h12V5Z"/><path d="m12 9 6 6M18 9l-6 6"/></svg>';

  const lang = WG.getLang();
  const $ = (id) => document.getElementById(id);
  const boardEl = $("board");
  const kbEl = $("keyboard");

  let words, answers, alphabet, answer, mode, code, day, stateKey;
  let guesses = [];
  let current = "";
  let locked = true;
  let finished = false;
  let won = false;
  let countdownTimer = null;

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

    const params = WG.params();
    code = params.get("c");
    const decoded = code ? WG.decodeWord(code) : null;
    if (decoded && [...decoded].length === LEN && [...decoded].every((ch) => alphabet.has(ch))) {
      answer = decoded;
      mode = params.has("gy") ? "practice" : "challenge";
      stateKey = "wordle:" + lang + ":c:" + code;
      $("subtitle").textContent = lang.toUpperCase() + (mode === "practice" ? " · gyakorlás" : " · kihívás");
    } else {
      if (code) WG.toast("Hibás kihívás link — itt a napi szó!", 2600);
      code = null;
      mode = "daily";
      answer = answers[WG.mod(day, answers.length)];
      stateKey = "wordle:" + lang + ":d:" + day;
      $("subtitle").textContent = lang.toUpperCase() + " · #" + (day + 1);
    }

    buildBoard();
    buildKeyboard();
    renderExamples();
    setupChallenge();
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    $("practiceBtn").addEventListener("click", startPractice);
    $("dailyLink").href = WG.pageUrl("wordle.html", { lang });
    $("statsDlg").addEventListener("close", () => clearInterval(countdownTimer));
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", sizeBoard);
    sizeBoard();

    const saved = WG.store.get(stateKey, null);
    if (saved && Array.isArray(saved.guesses)) {
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

    if (finished) {
      setTimeout(openStats, 500);
    } else if (!WG.store.get("wordle:seenHelp", false)) {
      WG.store.set("wordle:seenHelp", true);
      WG.openDialog("helpDlg");
    }
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
          key.addEventListener("click", submit);
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
    EXAMPLES[lang].forEach(([word, index, state, text]) => {
      const row = document.createElement("div");
      row.className = "example";
      [...word].forEach((ch, i) => {
        const tile = document.createElement("div");
        tile.className = "tile " + (i === index ? state : "filled");
        tile.textContent = ch;
        row.appendChild(tile);
      });
      const p = document.createElement("p");
      p.innerHTML = text;
      box.append(row, p);
    });
    $("huNote").hidden = lang !== "hu";
  }

  /* ---------- Bevitel ---------- */

  function onKey(e) {
    if (WG.anyDialogOpen() || e.metaKey || (e.ctrlKey && !e.altKey)) return;
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

    const guess = current;
    const result = evaluate(guess, answer);
    const rowIndex = guesses.length;
    guesses.push(guess);
    current = "";
    won = result.every((r) => r === "correct");
    finished = won || guesses.length === ROWS;
    WG.store.set(stateKey, { guesses, done: finished, won });
    if (finished && mode === "daily") recordStats();

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
      updateKeys(guess, result);
      locked = false;
      if (finished) celebrate(rowIndex);
    }, LEN * FLIP_MS + 260);
  }

  function celebrate(rowIndex) {
    if (won) {
      WG.toast(PRAISE[guesses.length - 1], 1800);
      [...boardEl.children[rowIndex].children].forEach((tile, i) => {
        setTimeout(() => tile.classList.add("bounce"), i * 100);
      });
    } else {
      WG.toast(answer.toUpperCase(), 3000);
    }
    setTimeout(openStats, 1900);
  }

  /* ---------- Statisztika és megosztás ---------- */

  function statsKey() {
    return "wordle:" + lang + ":stats";
  }

  function loadStats() {
    return WG.store.get(statsKey(), null) || {
      played: 0, wins: 0, streak: 0, maxStreak: 0, dist: [0, 0, 0, 0, 0, 0], lastDay: null, lastWinDay: null,
    };
  }

  function recordStats() {
    const s = loadStats();
    if (s.lastDay === day) return;
    s.played++;
    s.lastDay = day;
    if (won) {
      s.wins++;
      s.dist[guesses.length - 1]++;
      s.streak = s.lastWinDay === day - 1 ? s.streak + 1 : 1;
      s.lastWinDay = day;
      s.maxStreak = Math.max(s.maxStreak, s.streak);
    } else {
      s.streak = 0;
    }
    WG.store.set(statsKey(), s);
  }

  function openStats() {
    const s = loadStats();
    const streak = s.lastWinDay !== null && s.lastWinDay >= day - 1 ? s.streak : 0;
    $("stPlayed").textContent = s.played;
    $("stWin").textContent = s.played ? Math.round((100 * s.wins) / s.played) : 0;
    $("stStreak").textContent = streak;
    $("stMax").textContent = s.maxStreak;
    $("statsHeading").textContent = "Napi Wordle · " + (lang === "hu" ? "magyar" : "angol");

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
      if (mode === "daily" && won && guesses.length === i + 1) bar.classList.add("hl");
      bar.style.width = Math.max(7, Math.round((100 * n) / max)) + "%";
      bar.textContent = n;
      row.append(label, bar);
      dist.appendChild(row);
    });

    $("statsTitle").textContent = finished ? (won ? "Szép munka! 🎉" : "Majd legközelebb!") : "Statisztika";
    const resultWord = $("resultWord");
    resultWord.hidden = !finished;
    if (finished) {
      const b = document.createElement("b");
      b.textContent = answer;
      resultWord.replaceChildren("A megoldás: ", b, won ? " — " + guesses.length + "/6" : "");
    }

    $("shareBtn").hidden = !finished;
    $("dailyLink").hidden = mode === "daily";
    $("nextBlock").hidden = !(mode === "daily" && finished);
    clearInterval(countdownTimer);
    if (mode === "daily" && finished) {
      const tick = () => ($("countdown").textContent = WG.formatCountdown(WG.msToMidnight()));
      tick();
      countdownTimer = setInterval(tick, 1000);
    }
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const L = lang.toUpperCase();
    const title = mode === "daily"
      ? "Wordle " + L + " #" + (day + 1)
      : "Wordle " + L + (mode === "practice" ? " gyakorló szó" : " kihívás");
    const grid = guesses
      .map((g) => evaluate(g, answer).map((r) => (r === "correct" ? "🟩" : r === "present" ? "🟨" : "⬛")).join(""))
      .join("\n");
    const link = mode === "daily"
      ? WG.pageUrl("wordle.html", { lang })
      : WG.pageUrl("wordle.html", mode === "practice" ? { lang, c: code, gy: "1" } : { lang, c: code });
    const invite = mode === "daily" ? "Játssz te is:" : "Próbáld ki ugyanezt a szót:";
    return title + " " + (won ? guesses.length : "X") + "/6\n\n" + grid + "\n\n" + invite + " " + link;
  }

  function startPractice() {
    let w;
    do {
      w = answers[Math.floor(Math.random() * answers.length)];
    } while (w === answer && answers.length > 1);
    location.href = WG.pageUrl("wordle.html", { lang, c: WG.encodeWord(w), gy: "1" });
  }

  function setupChallenge() {
    const input = $("challengeInput");
    const error = $("challengeError");
    const result = $("challengeResult");
    let link = "";
    input.placeholder = lang === "hu" ? "pl. ablak" : "pl. crane";

    $("challengeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const w = [...input.value.trim()].map(WG.normalizeLetter).join("");
      result.hidden = true;
      error.textContent = "";
      if ([...w].length !== LEN) {
        error.textContent = "Pontosan 5 betűs szót adj meg.";
      } else if (!words.has(w)) {
        error.textContent = "Ez a szó nincs a " + (lang === "hu" ? "magyar" : "angol") + " szólistában.";
      } else {
        link = WG.pageUrl("wordle.html", { lang, c: WG.encodeWord(w) });
        $("challengeLink").value = link;
        result.hidden = false;
      }
    });
    $("challengeShare").addEventListener("click", () => {
      WG.share("Kitalálod a szavam? 🟩🟨⬛ Wordle kihívás (" + lang.toUpperCase() + "): " + link);
    });
    $("challengeDlg").addEventListener("close", () => {
      input.value = "";
      error.textContent = "";
      result.hidden = true;
    });
  }
})();
