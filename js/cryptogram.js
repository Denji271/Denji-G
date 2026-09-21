// Cryptogram — a proverb where every letter has been swapped for another one.
(function () {
  "use strict";

  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const FREEBIES = 2;

  const $ = GK.$;
  const day = WG.dayNumber();

  let mode = "daily";
  let index = 0;
  let quote = "";
  let cipher = {};
  let guesses = {};
  let given = new Set();
  let picked = null;
  let hints = 0;
  let finished = false;
  let clock;

  WG.setupDialogs();
  WG.loadPacks().then(init, (err) => WG.toast(err.message, 6000));

  function init(packs) {
    const list = packs.quotes;
    const p = WG.params().get("p");
    const todayIndex = WG.mod(day, list.length);
    index = p !== null && /^\d+$/.test(p) && Number(p) < list.length ? Number(p) : todayIndex;
    mode = index === todayIndex ? "daily" : "endless";
    quote = list[index].toUpperCase();

    const rand = WG.rng(WG.seedFrom("cryptogram", index));
    cipher = makeCipher(rand);
    given = freebies(rand);
    guesses = {};
    given.forEach((code) => (guesses[code] = plainOf(code)));

    const saved = WG.store.get(stateKey(), null);
    if (saved && saved.guesses && typeof saved.guesses === "object") {
      Object.keys(saved.guesses).forEach((code) => {
        if (ALPHABET.includes(code)) guesses[code] = saved.guesses[code];
      });
      hints = saved.hints || 0;
    }
    finished = solved();

    $("subtitle").textContent = GK.subtitle(mode, day);
    clock = GK.timer($("clock"));
    clock.reset(saved && saved.ms ? saved.ms : 0);
    if (!finished) clock.start();

    build();
    render();

    document.addEventListener("keydown", onKey);
    $("hintBtn").addEventListener("click", hint);
    $("clearBtn").addEventListener("click", clear);
    $("newBtn").addEventListener("click", newPuzzle);
    $("againBtn").addEventListener("click", newPuzzle);
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    window.addEventListener("beforeunload", save);
    if (finished) setTimeout(openStats, 400);
  }

  function stateKey() {
    return "cryptogram:p:" + index;
  }

  function save() {
    WG.store.set(stateKey(), { guesses, hints, ms: clock.value(), done: finished });
  }

  /* ---------- The cipher ---------- */

  // A shuffled alphabet where no letter maps to itself: plain -> code.
  function makeCipher(rand) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const shuffled = WG.shuffle([...ALPHABET], rand);
      if (shuffled.every((ch, i) => ch !== ALPHABET[i])) {
        const map = {};
        [...ALPHABET].forEach((ch, i) => (map[ch] = shuffled[i]));
        return map;
      }
    }
    const map = {};
    [...ALPHABET].forEach((ch, i) => (map[ch] = ALPHABET[(i + 7) % 26]));
    return map;
  }

  function plainOf(code) {
    return Object.keys(cipher).find((plain) => cipher[plain] === code);
  }

  function coded() {
    return [...quote].map((ch) => (cipher[ch] ? cipher[ch] : ch)).join("");
  }

  // Two of the rarest letters are filled in from the start.
  function freebies(rand) {
    const counts = {};
    [...quote].forEach((ch) => {
      if (cipher[ch]) counts[ch] = (counts[ch] || 0) + 1;
    });
    const rare = Object.keys(counts).sort((a, b) => counts[a] - counts[b] || (rand() < 0.5 ? -1 : 1));
    return new Set(rare.slice(0, FREEBIES).map((plain) => cipher[plain]));
  }

  function solved() {
    return [...quote].every((ch, i) => !cipher[ch] || guesses[coded()[i]] === ch);
  }

  /* ---------- Drawing ---------- */

  function build() {
    const box = $("quote");
    box.innerHTML = "";
    const code = coded();
    quote.split(" ").forEach((word, wi, all) => {
      const wordBox = GK.el("div", "cg-word");
      let at = all.slice(0, wi).join(" ").length;
      if (wi) at += 1;
      [...word].forEach((ch, i) => {
        const spot = at + i;
        const slot = GK.el("div", "cg-slot");
        const letter = code[spot];
        if (!cipher[ch]) {
          slot.classList.add("plain");
          slot.appendChild(GK.el("span", "cg-guess", letter));
        } else {
          slot.dataset.code = letter;
          slot.appendChild(GK.el("span", "cg-guess", ""));
          slot.appendChild(GK.el("span", "cg-code", letter));
          slot.addEventListener("click", () => {
            picked = letter;
            render();
          });
        }
        wordBox.appendChild(slot);
      });
      box.appendChild(wordBox);
    });

    const keys = $("keys");
    keys.innerHTML = "";
    [...ALPHABET].forEach((ch) => {
      const b = GK.el("button", "cg-key", ch);
      b.type = "button";
      b.dataset.letter = ch;
      b.addEventListener("click", () => setGuess(ch));
      b.addEventListener("mousedown", (e) => e.preventDefault());
      keys.appendChild(b);
    });
  }

  function render() {
    const used = new Set(Object.values(guesses).filter(Boolean));
    $("quote")
      .querySelectorAll(".cg-slot")
      .forEach((slot) => {
        const code = slot.dataset.code;
        if (!code) return;
        const guess = guesses[code] || "";
        slot.querySelector(".cg-guess").textContent = guess;
        slot.classList.toggle("picked", picked === code);
        slot.classList.toggle("given", given.has(code));
        slot.classList.toggle("filled", !!guess);
      });
    $("keys")
      .querySelectorAll(".cg-key")
      .forEach((key) => key.classList.toggle("used", used.has(key.dataset.letter)));

    const codes = new Set([...coded()].filter((ch) => ALPHABET.includes(ch)));
    const left = [...codes].filter((code) => !guesses[code]).length;
    $("left").textContent = left;
    $("hintCount").textContent = hints;
  }

  /* ---------- Input ---------- */

  function onKey(e) {
    if (WG.anyDialogOpen() || e.metaKey || e.ctrlKey) return;
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      setGuess("");
    } else if (/^[a-zA-Z]$/.test(e.key)) {
      setGuess(e.key.toUpperCase());
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
    }
  }

  function step(by) {
    const codes = [...new Set([...coded()].filter((ch) => ALPHABET.includes(ch)))];
    if (!codes.length) return;
    const at = codes.indexOf(picked);
    picked = codes[WG.mod(at + by, codes.length)];
    render();
  }

  function setGuess(letter) {
    if (finished || !picked || given.has(picked)) return;
    if (letter) {
      // a letter can only stand for one code letter at a time
      Object.keys(guesses).forEach((code) => {
        if (guesses[code] === letter && !given.has(code)) delete guesses[code];
      });
      guesses[picked] = letter;
    } else {
      delete guesses[picked];
    }
    save();
    render();
    if (letter && solved()) win();
  }

  function hint() {
    if (finished) return;
    const code = [...new Set([...coded()].filter((ch) => ALPHABET.includes(ch)))].find(
      (c) => guesses[c] !== plainOf(c)
    );
    if (!code) return;
    given.add(code);
    guesses[code] = plainOf(code);
    hints++;
    save();
    render();
    if (solved()) win();
  }

  function clear() {
    if (finished) return;
    guesses = {};
    given.forEach((code) => (guesses[code] = plainOf(code)));
    save();
    render();
  }

  function win() {
    finished = true;
    clock.stop();
    save();
    WG.stats.record("cryptogram:" + mode, { won: true, daily: mode === "daily", day });
    WG.toast("Cracked it in " + clock.text(), 2400);
    setTimeout(openStats, 1200);
  }

  function newPuzzle() {
    const list = window.WORDGAME_PACKS.en.quotes;
    let next = index;
    while (next === index && list.length > 1) next = Math.floor(Math.random() * list.length);
    location.href = WG.pageUrl("cryptogram.html", { p: next });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const s = WG.stats.load("cryptogram:" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? "Solved" : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished ? clock.text() + (hints ? " · " + hints + " hints" : " · no hints") : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const label = mode === "daily" ? "#" + (day + 1) : "#" + (index + 1);
    return (
      "Cryptogram " + label + "\n" +
      "Solved in " + clock.text() + (hints ? " with " + hints + " hints" : " with no hints") + "\n\n" +
      WG.pageUrl("cryptogram.html", mode === "daily" ? {} : { p: index })
    );
  }
})();
