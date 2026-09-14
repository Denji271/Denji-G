// Spelling Bee — hány szót raksz ki 7 betűből?
(function () {
  "use strict";

  // [rang neve, a maximális pontszám hány százaléka kell hozzá]
  const RANKS = [
    ["Kezdő", 0], ["Jó kezdés", 2], ["Halad", 5], ["Jó", 8], ["Szilárd", 15],
    ["Szép", 25], ["Remek", 40], ["Csodás", 50], ["Zseni", 70], ["Méhkirálynő", 100],
  ];
  const GENIUS = 8;
  const QUEEN = 9;
  const MIN_LEN = 4;
  const MAX_ENTRY = 19;

  const lang = WG.getLang();
  const $ = (id) => document.getElementById(id);
  const collator = new Intl.Collator(lang);

  let puzzles, beeWords, day, index, mode, puzzle;
  let found = [];
  let entry = "";
  let errorTimer = null;

  WG.setupDialogs();
  WG.setupLangSwitch(lang);
  WG.loadData(lang).then(init, (err) => WG.toast(err.message, 6000));

  function init(data) {
    beeWords = WG.splitWords(data.beeWords);
    puzzles = WG.splitWords(data.beePuzzles);
    day = WG.dayNumber();
    const todayIndex = WG.mod(day, puzzles.length);
    const p = WG.params().get("p");
    index = p !== null && /^\d+$/.test(p) && Number(p) < puzzles.length ? Number(p) : todayIndex;
    mode = index === todayIndex ? "daily" : "endless";
    $("subtitle").textContent = lang.toUpperCase() + " · " + (mode === "daily" ? "#" + (day + 1) : "∞");

    puzzle = makePuzzle(index);
    found = WG.store.get(stateKey(), []).filter((w) => puzzle.answerSet.has(w));

    buildHive();
    render();

    $("deleteBtn").addEventListener("click", backspace);
    $("shuffleBtn").addEventListener("click", shuffle);
    $("enterBtn").addEventListener("click", submit);
    document.querySelectorAll(".bee-controls button, .bee-actions button").forEach((b) => {
      b.addEventListener("mousedown", (e) => e.preventDefault());
    });
    $("rankBar").addEventListener("click", openRanks);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    $("ranksShare").addEventListener("click", () => WG.share(shareText()));
    $("newBtn").addEventListener("click", randomPuzzle);
    $("answersNewBtn").addEventListener("click", randomPuzzle);
    $("giveUpBtn").addEventListener("click", showAnswers);
    document.addEventListener("keydown", onKey);
  }

  function makePuzzle(i) {
    const letters = [...puzzles[i]];
    const center = letters[0];
    const letterSet = new Set(letters);
    const answers = beeWords.filter((w) => w.includes(center) && [...w].every((ch) => letterSet.has(ch)));
    return {
      center,
      outer: letters.slice(1),
      letterSet,
      answers,
      answerSet: new Set(answers),
      maxScore: answers.reduce((sum, w) => sum + wordScore(w), 0),
    };
  }

  function stateKey() {
    return "bee:" + lang + ":p:" + index;
  }

  function isPangram(w) {
    return new Set(w).size === 7;
  }

  function wordScore(w) {
    const n = [...w].length;
    return n === MIN_LEN ? 1 : n + (isPangram(w) ? 7 : 0);
  }

  function currentScore() {
    return found.reduce((sum, w) => sum + wordScore(w), 0);
  }

  function thresholds() {
    return RANKS.map(([, pct]) => Math.round((puzzle.maxScore * pct) / 100));
  }

  function rankIndex(score = currentScore()) {
    let rank = 0;
    thresholds().forEach((min, i) => {
      if (score >= min) rank = i;
    });
    return rank;
  }

  /* ---------- Rajzolás ---------- */

  function buildHive() {
    const hive = $("hive");
    hive.innerHTML = "";
    hive.appendChild(makeCell(puzzle.center, true));
    puzzle.outer.forEach((ch, i) => {
      const cell = makeCell(ch, false);
      cell.dataset.pos = i;
      hive.appendChild(cell);
    });
  }

  function makeCell(ch, isCenter) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cell" + (isCenter ? " center" : "");
    b.textContent = ch;
    b.setAttribute("aria-label", ch.toUpperCase());
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => addLetter(b.textContent));
    return b;
  }

  function render() {
    renderEntry();
    renderProgress();
    renderFound();
  }

  function renderEntry() {
    const box = $("entry");
    box.innerHTML = "";
    for (const ch of entry) {
      const span = document.createElement("span");
      if (ch === puzzle.center) span.className = "c";
      else if (!puzzle.letterSet.has(ch)) span.className = "x";
      span.textContent = ch;
      box.appendChild(span);
    }
    const caret = document.createElement("span");
    caret.className = "caret";
    box.appendChild(caret);
  }

  function renderProgress() {
    const score = currentScore();
    const rank = rankIndex(score);
    $("rankName").textContent = RANKS[rank][0];
    const pos = (Math.min(rank, GENIUS) / GENIUS) * 100;
    const track = $("rankTrack");
    track.innerHTML = "";
    const fill = document.createElement("span");
    fill.className = "fill";
    fill.style.width = pos + "%";
    track.appendChild(fill);
    for (let i = 0; i <= GENIUS; i++) {
      const dot = document.createElement("span");
      dot.className = "dot" + (i <= rank ? " on" : "");
      track.appendChild(dot);
    }
    const scoreDot = document.createElement("span");
    scoreDot.className = "score-dot";
    scoreDot.style.left = pos + "%";
    scoreDot.textContent = score;
    track.appendChild(scoreDot);
  }

  function renderFound() {
    $("foundCount").textContent = found.length + " szó";
    $("foundRecent").textContent = found.slice(-8).reverse().join(" · ");
    const list = $("foundList");
    list.innerHTML = "";
    [...found].sort(collator.compare).forEach((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      if (isPangram(w)) li.className = "pangram";
      list.appendChild(li);
    });
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
    } else if (e.key === " ") {
      e.preventDefault();
      shuffle();
    } else if (e.key.length === 1 && /\p{L}/u.test(e.key)) {
      addLetter(WG.normalizeLetter(e.key));
    }
  }

  function addLetter(ch) {
    if ([...entry].length >= MAX_ENTRY) return;
    clearTimeout(errorTimer);
    entry += ch;
    renderEntry();
  }

  function backspace() {
    entry = [...entry].slice(0, -1).join("");
    renderEntry();
  }

  function shuffle() {
    const outer = puzzle.outer;
    for (let i = outer.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [outer[i], outer[j]] = [outer[j], outer[i]];
    }
    const hive = $("hive");
    hive.classList.add("shuffling");
    setTimeout(() => {
      hive.querySelectorAll(".cell:not(.center)").forEach((cell, i) => {
        cell.textContent = outer[i];
        cell.setAttribute("aria-label", outer[i].toUpperCase());
      });
      hive.classList.remove("shuffling");
    }, 160);
  }

  function submit() {
    const w = entry;
    if (!w) return;
    const chars = [...w];
    let message = null;
    if (chars.length < MIN_LEN) message = "Túl rövid";
    else if (chars.some((ch) => !puzzle.letterSet.has(ch))) message = "Rossz betű";
    else if (!chars.includes(puzzle.center)) message = "Hiányzik a középső betű";
    else if (found.includes(w)) message = "Már megvan";
    else if (!puzzle.answerSet.has(w)) message = "Nincs a listában";

    if (message) {
      WG.toast(message);
      const box = $("entry");
      box.classList.remove("shake");
      void box.offsetWidth;
      box.classList.add("shake");
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        entry = "";
        renderEntry();
      }, 650);
      return;
    }

    const before = rankIndex();
    const points = wordScore(w);
    found.push(w);
    entry = "";
    WG.store.set(stateKey(), found);
    render();
    WG.toast(isPangram(w) ? "Pangram! +" + points : (points === 1 ? "Jó!" : points < 7 ? "Szép!" : "Fantasztikus!") + " +" + points);

    const after = rankIndex();
    if (after === QUEEN) setTimeout(() => WG.toast("👑 Méhkirálynő!", 3000), 900);
    else if (after > before) setTimeout(() => WG.toast(RANKS[after][0] + "!", 2000), 900);
  }

  /* ---------- Ablakok ---------- */

  function openRanks() {
    const score = currentScore();
    const rank = rankIndex(score);
    const mins = thresholds();
    $("ranksScore").textContent = score + " pont · " + found.length + " szó";
    const body = $("ranksBody");
    body.innerHTML = "";
    for (let i = RANKS.length - 1; i >= 0; i--) {
      const tr = document.createElement("tr");
      if (i === rank) tr.className = "current";
      const name = document.createElement("td");
      name.textContent = RANKS[i][0];
      const pts = document.createElement("td");
      pts.textContent = mins[i];
      tr.append(name, pts);
      body.appendChild(tr);
    }
    WG.openDialog("ranksDlg");
  }

  function showAnswers() {
    const letters = $("answersLetters");
    letters.innerHTML = "";
    [puzzle.center, ...[...puzzle.outer].sort(collator.compare)].forEach((ch, k) => {
      const hex = document.createElement("span");
      hex.className = "mini-hex" + (k === 0 ? " center" : "");
      hex.textContent = ch;
      letters.appendChild(hex);
    });

    const got = new Set(found);
    $("answersSummary").textContent = found.length + " / " + puzzle.answers.length;
    const list = $("answersList");
    list.innerHTML = "";
    [...puzzle.answers].sort(collator.compare).forEach((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      if (got.has(w)) li.classList.add("got");
      if (isPangram(w)) li.classList.add("pangram");
      list.appendChild(li);
    });
    WG.openDialog("answersDlg");
  }

  function randomPuzzle() {
    let i;
    do {
      i = Math.floor(Math.random() * puzzles.length);
    } while (i === index && puzzles.length > 1);
    location.href = WG.pageUrl("bee.html", { lang, p: i });
  }

  function shareText() {
    const score = currentScore();
    const rank = rankIndex(score);
    const label = mode === "daily" ? "#" + (day + 1) : "∞";
    const bar = RANKS.slice(0, GENIUS + 1).map((_, i) => (i <= rank ? "🟨" : "⬜")).join("");
    return "🐝 Spelling Bee " + lang.toUpperCase() + " " + label + "\n" +
      RANKS[rank][0] + " — " + score + " pont, " + found.length + " szó\n" + bar + "\n\n" +
      WG.pageUrl("bee.html", { lang, p: index });
  }
})();
