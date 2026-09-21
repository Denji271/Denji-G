// Connections — sort sixteen words into the four groups of four that belong together.
(function () {
  "use strict";

  const LIVES = 4;
  const COLOURS = ["yellow", "green", "blue", "purple"];

  const $ = GK.$;
  const day = WG.dayNumber();

  let mode = "daily";
  let index = 0;
  let puzzle = null;
  let order = [];
  let picked = [];
  let solved = [];
  let history = [];
  let lives = LIVES;
  let finished = false;

  WG.setupDialogs();
  WG.loadPacks().then(init, (err) => WG.toast(err.message, 6000));

  function init(packs) {
    const list = packs.connections;
    const p = WG.params().get("p");
    const todayIndex = WG.mod(day, list.length);
    index = p !== null && /^\d+$/.test(p) && Number(p) < list.length ? Number(p) : todayIndex;
    mode = index === todayIndex ? "daily" : "endless";
    puzzle = list[index];

    const rand = WG.rng(WG.seedFrom("connections", index));
    order = WG.shuffle(
      puzzle.groups.flatMap((g, gi) => g.words.map((w) => ({ word: w, group: gi }))),
      rand
    );

    const saved = WG.store.get(stateKey(), null);
    if (saved && Array.isArray(saved.solved)) {
      solved = saved.solved.filter((g) => g >= 0 && g < 4);
      history = Array.isArray(saved.history) ? saved.history : [];
      lives = Math.max(0, LIVES - (saved.misses || 0));
    }
    finished = solved.length === 4 || lives === 0;

    $("subtitle").textContent = GK.subtitle(mode, day);
    render();

    $("submitBtn").addEventListener("click", submit);
    $("shuffleBtn").addEventListener("click", () => {
      order = WG.shuffle(order);
      render();
    });
    $("clearBtn").addEventListener("click", () => {
      picked = [];
      render();
    });
    $("newBtn").addEventListener("click", newPuzzle);
    $("againBtn").addEventListener("click", newPuzzle);
    $("statsBtn").addEventListener("click", openStats);
    $("shareBtn").addEventListener("click", () => WG.share(shareText()));
    if (finished) setTimeout(openStats, 500);
  }

  function stateKey() {
    return "connections:p:" + index;
  }

  function save() {
    WG.store.set(stateKey(), { solved, history, misses: LIVES - lives, done: finished });
  }

  function groupOf(word) {
    const hit = order.find((o) => o.word === word);
    return hit ? hit.group : -1;
  }

  /* ---------- Drawing ---------- */

  function render() {
    const solvedBox = $("solved");
    solvedBox.innerHTML = "";
    solved.forEach((gi) => {
      const group = puzzle.groups[gi];
      const box = GK.el("div", "cn-group " + COLOURS[gi]);
      box.appendChild(GK.el("div", "cn-group-name", group.name));
      box.appendChild(GK.el("div", "cn-group-words", group.words.join(", ")));
      solvedBox.appendChild(box);
    });

    const grid = $("grid");
    grid.innerHTML = "";
    order
      .filter((o) => !solved.includes(o.group))
      .forEach((o) => {
        const b = GK.el("button", "cn-tile" + (picked.includes(o.word) ? " picked" : ""), o.word);
        b.type = "button";
        if (o.word.length > 8) b.classList.add("long");
        b.addEventListener("click", () => toggle(o.word));
        b.addEventListener("mousedown", (e) => e.preventDefault());
        grid.appendChild(b);
      });

    const dots = $("lives");
    dots.innerHTML = "";
    for (let i = 0; i < lives; i++) dots.appendChild(GK.el("span", "cn-life"));
    if (!lives) dots.textContent = "none";

    $("submitBtn").disabled = picked.length !== 4 || finished;
  }

  /* ---------- Play ---------- */

  function toggle(word) {
    if (finished) return;
    const at = picked.indexOf(word);
    if (at !== -1) picked.splice(at, 1);
    else if (picked.length < 4) picked.push(word);
    render();
  }

  function submit() {
    if (finished || picked.length !== 4) return;
    const groups = picked.map(groupOf);
    history.push(groups.slice());
    const first = groups[0];
    const hit = groups.every((g) => g === first);

    if (hit) {
      solved.push(first);
      picked = [];
      finished = solved.length === 4;
      save();
      render();
      if (finished) win();
      return;
    }

    const counts = {};
    groups.forEach((g) => (counts[g] = (counts[g] || 0) + 1));
    const closest = Math.max(...Object.values(counts));
    lives--;
    save();
    shake();
    WG.toast(closest === 3 ? "One away" : "Not a group", 1800);
    if (lives > 0) return render();

    // out of lives: reveal the rest
    finished = true;
    puzzle.groups.forEach((g, gi) => {
      if (!solved.includes(gi)) solved.push(gi);
    });
    picked = [];
    save();
    render();
    WG.stats.record("connections:" + mode, { won: false, daily: mode === "daily", day });
    setTimeout(openStats, 1400);
  }

  function shake() {
    $("grid")
      .querySelectorAll(".cn-tile.picked")
      .forEach((tile) => {
        tile.classList.remove("shake");
        void tile.offsetWidth;
        tile.classList.add("shake");
      });
  }

  function win() {
    WG.stats.record("connections:" + mode, { won: true, daily: mode === "daily", day });
    WG.toast(lives === LIVES ? "Perfect!" : "Solved with " + lives + " left", 2200);
    setTimeout(openStats, 1300);
  }

  function newPuzzle() {
    const list = window.WORDGAME_PACKS.en.connections;
    let next = index;
    while (next === index && list.length > 1) next = Math.floor(Math.random() * list.length);
    location.href = WG.pageUrl("connections.html", { p: next });
  }

  /* ---------- Stats ---------- */

  function openStats() {
    const won = solved.length === 4 && lives > 0;
    const s = WG.stats.load("connections:" + mode);
    GK.fillStats(s, mode === "daily", day);
    $("statsTitle").textContent = finished ? (won ? "Solved" : "Out of guesses") : "Statistics";
    const line = $("resultLine");
    line.hidden = !finished;
    line.textContent = finished ? (won ? LIVES - lives + " mistakes" : "Better luck tomorrow") : "";
    $("shareBtn").hidden = !finished;
    WG.openDialog("statsDlg");
  }

  function shareText() {
    const squares = ["🟨", "🟩", "🟦", "🟪"];
    const label = mode === "daily" ? "#" + (day + 1) : "#" + (index + 1);
    const grid = history.map((row) => row.map((g) => squares[g]).join("")).join("\n");
    return (
      "Connections " + label + "\n" + grid + "\n\n" +
      WG.pageUrl("connections.html", mode === "daily" ? {} : { p: index })
    );
  }
})();
