// Draw & Guess — one player draws a word, the others race to guess it in the chat.
// The host picks the words, checks the guesses and keeps the score; the drawer's strokes go to everybody.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const W = 800;
  const H = 600;
  const CHOOSE_MS = 12000;
  const REVEAL_MS = 4500;
  const FLUSH_MS = 50; // how often the drawer sends new points
  const CHAT_MAX = 80;
  const PAPER = "#ffffff";
  const COLORS = ["#1a1a1b", "#8a8a8e", "#e05c4a", "#f08c2e", "#f0c419", "#57a05a", "#2f6fde", "#9a5bd6", "#8b5a2b", "#f28cb1"];
  const SIZES = [4, 10, 22];

  const pad = ARC.view($("game"), W, H);
  const canvas = pad.canvas;

  let room = null;
  let st = null; // latest state from the host: { match, turnNo, phase, drawer, round, rounds, mask, word, players… }
  let turnEnd = 0;
  let turnTotal = 1;
  let choices = null; // the three words, when I am the one choosing
  let myWord = ""; // the word I am drawing

  // the picture: [{ s: id, c: colour, w: width, p: [x, y, x, y…], drawn: coords already painted }]
  let strokes = [];
  let full = true; // repaint everything on the next frame
  const pending = new Set(); // strokes with new points to paint
  let lastSize = "";

  // my pen
  let color = COLORS[0];
  let size = SIZES[1];
  let erasing = false;
  let current = null; // the stroke under my finger
  let unsent = []; // its points the others have not had yet
  let strokeSeq = 0;
  const flushDue = ARC.every(FLUSH_MS);

  // host only
  let game = null;
  let words = null;
  let turnCounter = 0;
  let matchCounter = 0;

  LOBBY.init({
    game: "draw",
    title: "Draw & Guess",
    blurb: "Take turns drawing a word while the others race to guess it. English or Hungarian words. 2–4 players.",
    minPlayers: 2,
    lateNote: "A game is on right now — you can guess from the next turn.",
    settings: [
      {
        key: "lang",
        label: "Words",
        value: "en",
        options: [
          { value: "en", label: "English" },
          { value: "hu", label: "Magyar" },
        ],
      },
      {
        key: "rounds",
        label: "Rounds",
        value: 2,
        options: [
          { value: 1, label: "1 (everybody draws once)" },
          { value: 2, label: "2" },
          { value: 3, label: "3" },
        ],
      },
      {
        key: "time",
        label: "Drawing time",
        value: 80,
        options: [
          { value: 60, label: "60 seconds" },
          { value: 80, label: "80 seconds" },
          { value: 100, label: "100 seconds" },
        ],
      },
    ],
    onRoom,
    onStart: startMatch,
    onLobby: () => {
      game = null;
      st = null;
      strokes = [];
      full = true;
      render();
    },
  });

  const loop = ARC.loop(update, draw);
  loop.start();
  buildTools();
  render();

  function onRoom(r) {
    room = r;
    room.on("dg.state", onState);
    room.on("dg.choose", (list) => {
      choices = Array.isArray(list) ? list.slice(0, 3).map(String) : null;
      renderOverlay();
    });
    room.on("dg.word", (w) => {
      myWord = String(w);
      renderBar();
    });
    room.on("dg.pts", onPoints);
    room.on("dg.undo", onUndo);
    room.on("dg.clear", onClear);
    room.on("dg.chat", addChat);
    room.on("dg.sync", (d) => {
      if (!st || !d || d.turnNo !== st.turnNo || !Array.isArray(d.strokes)) return;
      strokes = d.strokes.map(cleanStroke);
      full = true;
    });
    room.on("players", renderHud);

    if (room.isHost) {
      room.on("dg.pick", onPick);
      room.on("dg.guess", onGuess);
      room.on("join", onJoin);
      room.on("leave", onLeave);
    }
  }

  /* ---------- Host ---------- */

  async function loadWords() {
    if (words) return words;
    const data = await WG.loadScript("data/draw-words.js", () => window.WORDGAME_DATA && window.WORDGAME_DATA.draw, "word list");
    words = { en: WG.splitWords(data.en), hu: WG.splitWords(data.hu) };
    return words;
  }

  async function startMatch(settings) {
    try {
      await loadWords();
    } catch (e) {
      WG.toast("Could not load the word list", 2400);
      return;
    }
    game = {
      match: ++matchCounter,
      settings,
      list: words[settings.lang] || words.en,
      used: new Set(),
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: 0 })),
      started: room.players.length,
      round: 0,
      queue: [],
      drawer: null,
      turnNo: 0,
      phase: "",
      word: "",
      choices: [],
      deadline: 0,
      drawStart: 0,
      guessed: new Set(),
      revealed: [],
      hints: 0,
      note: "",
    };
    nextTurn();
  }

  function inGame() {
    return game.players.filter((p) => room.player(p.id));
  }

  function enoughPlayers() {
    return inGame().length >= (game.started > 1 ? 2 : 1);
  }

  function nextTurn() {
    for (;;) {
      if (!game.queue.length) {
        if (!enoughPlayers()) return endMatch();
        game.round++;
        if (game.round > game.settings.rounds) return endMatch();
        game.queue = inGame().map((p) => p.id);
      }
      const id = game.queue.shift();
      if (room.player(id)) {
        game.drawer = id;
        break;
      }
    }
    game.turnNo = ++turnCounter;
    game.phase = "choose";
    game.word = "";
    game.guessed = new Set();
    game.revealed = [];
    game.hints = 0;
    game.note = "";
    game.choices = pickWords(3);
    game.deadline = performance.now() + CHOOSE_MS;
    broadcast();
    room.to(game.drawer, "dg.choose", game.choices);
  }

  function pickWords(n) {
    let fresh = game.list.filter((w) => !game.used.has(w));
    if (fresh.length < n) {
      game.used.clear();
      fresh = game.list;
    }
    return WG.shuffle(fresh).slice(0, n);
  }

  function onPick(i, from) {
    if (!game || game.phase !== "choose" || from !== game.drawer) return;
    const word = game.choices[Number(i)];
    if (word) startDrawing(word);
  }

  function startDrawing(word) {
    const now = performance.now();
    game.word = word;
    game.used.add(word);
    game.phase = "draw";
    game.drawStart = now;
    game.deadline = now + game.settings.time * 1000;
    broadcast();
    room.to(game.drawer, "dg.word", word);
    const p = room.player(game.drawer);
    if (p) chat({ kind: "system", text: p.name + " is drawing now" });
  }

  function reveal(note) {
    game.phase = "reveal";
    game.note = note || "";
    game.deadline = performance.now() + REVEAL_MS;
    broadcast();
  }

  function hint() {
    const hidden = [];
    [...game.word].forEach((ch, i) => {
      if (!game.revealed.includes(i)) hidden.push(i);
    });
    game.hints++;
    if (hidden.length > 1) {
      game.revealed.push(WG.pick(hidden));
      broadcast();
    }
  }

  function maskOf() {
    return [...game.word].map((ch, i) => (game.phase === "reveal" || game.revealed.includes(i) ? ch : "_")).join("");
  }

  function broadcast() {
    const d = {
      match: game.match,
      turnNo: game.turnNo,
      phase: game.phase,
      drawer: game.drawer,
      round: game.round,
      rounds: game.settings.rounds,
      mask: game.phase === "choose" ? "" : maskOf(),
      word: game.phase === "reveal" ? game.word : "",
      note: game.note,
      endsIn: Math.max(0, game.deadline - performance.now()),
      total: game.phase === "draw" ? game.settings.time * 1000 : game.phase === "choose" ? CHOOSE_MS : REVEAL_MS,
      players: inGame().map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, got: game.guessed.has(p.id) })),
    };
    room.send("dg.state", d);
    onState(d);
  }

  function chat(m) {
    room.send("dg.chat", m);
    addChat(m);
  }

  // Compared without accents and case, so "gorogdinnye" counts for "görögdinnye".
  function plain(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  // One letter added, missing or changed.
  function oneOff(a, b) {
    if (Math.abs(a.length - b.length) > 1 || a === b) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }

  function everyoneGuessed() {
    const guessers = inGame().filter((p) => p.id !== game.drawer);
    return guessers.length > 0 && guessers.every((p) => game.guessed.has(p.id));
  }

  function onGuess(text, from) {
    if (!game) return;
    const said = String(text || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const p = game.players.find((x) => x.id === from);
    if (!said || !p) return;
    if (game.phase !== "draw") {
      chat({ kind: "guess", id: from, text: said });
      return;
    }
    if (from === game.drawer || game.guessed.has(from)) return;
    const guess = plain(said);
    const word = plain(game.word);
    if (guess === word) {
      game.guessed.add(from);
      const left = Math.max(0, game.deadline - performance.now()) / (game.settings.time * 1000);
      p.score += 50 + Math.round(250 * left);
      const drawer = game.players.find((x) => x.id === game.drawer);
      if (drawer) drawer.score += 50;
      chat({ kind: "correct", id: from, text: p.name + " guessed the word!" });
      if (everyoneGuessed()) reveal("Everybody got it!");
      else broadcast();
      return;
    }
    chat({ kind: "guess", id: from, text: said });
    if (word.length > 3 && oneOff(guess, word)) room.to(from, "dg.chat", { kind: "close", text: "“" + said + "” is close!" });
  }

  function onJoin(p) {
    if (!game) return;
    if (!game.players.some((x) => x.id === p.id)) game.players.push({ id: p.id, name: p.name, color: p.color, score: 0 });
    broadcast();
    room.to(p.id, "dg.sync", { turnNo: game.turnNo, strokes: strokes.map((s) => ({ s: s.s, c: s.c, w: s.w, p: s.p })) });
  }

  function onLeave(p) {
    if (!game) return;
    if (!enoughPlayers()) {
      endMatch();
      return;
    }
    if (p.id === game.drawer && game.phase === "choose") {
      chat({ kind: "system", text: p.name + " left" });
      nextTurn();
    } else if (p.id === game.drawer && game.phase === "draw") {
      reveal(p.name + " left the game");
    } else if (game.phase === "draw" && everyoneGuessed()) {
      reveal("Everybody got it!");
    } else {
      broadcast();
    }
  }

  function endMatch() {
    const ranked = inGame().sort((a, b) => b.score - a.score);
    const rows = ranked.map((p) => ({ name: p.name, color: p.color, value: p.score + " pts" }));
    const title = ranked.length ? ranked[0].name + " wins!" : "Game over";
    game = null;
    st = null;
    render();
    LOBBY.results(rows, title);
  }

  function hostUpdate() {
    if (!game) return;
    const now = performance.now();
    if (game.phase === "draw") {
      const frac = (now - game.drawStart) / (game.settings.time * 1000);
      const letters = [...game.word].length;
      if (game.hints === 0 && frac >= 0.5 && letters >= 3) hint();
      else if (game.hints === 1 && frac >= 0.75 && letters >= 5) hint();
    }
    if (now < game.deadline) return;
    if (game.phase === "choose") startDrawing(game.choices[0]);
    else if (game.phase === "draw") reveal("Time's up!");
    else if (game.phase === "reveal") nextTurn();
  }

  /* ---------- Everybody: the state ---------- */

  function onState(d) {
    const freshTurn = !st || d.turnNo !== st.turnNo;
    if (!st || d.match !== st.match) $("chat").innerHTML = "";
    st = d;
    turnEnd = performance.now() + d.endsIn;
    turnTotal = d.total || 1;
    if (freshTurn) {
      strokes = [];
      full = true;
      current = null;
      unsent = [];
      strokeSeq = 0;
      choices = null;
      myWord = "";
    }
    if (d.players.some((p) => p.id === room.myId)) LOBBY.hide();
    render();
  }

  function isDrawer() {
    return !!(st && room && st.drawer === room.myId);
  }

  function canDraw() {
    return isDrawer() && st.phase === "draw";
  }

  function nameOf(id) {
    const p = (st && st.players.find((x) => x.id === id)) || (room && room.player(id));
    return p ? p : { name: "?", color: -1 };
  }

  function render() {
    renderHud();
    renderBar();
    renderOverlay();
    renderInput();
    $("tools").classList.toggle("off", !canDraw());
  }

  function renderHud() {
    if (!st) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = st.players.map((p) => ({
      name: (p.id === st.drawer ? "✎ " : "") + p.name,
      color: p.color,
      value: p.score + (p.got ? " ✓" : ""),
      me: room && p.id === room.myId,
    }));
    ARC.scoreboard($("hud"), rows);
  }

  function renderBar() {
    const word = $("word");
    $("round").textContent = st ? "Round " + st.round + "/" + st.rounds : "";
    word.classList.remove("mask");
    if (!st) {
      word.textContent = "";
      return;
    }
    if (st.phase === "choose") {
      word.textContent = isDrawer() ? "Pick a word!" : nameOf(st.drawer).name + " is choosing…";
    } else if (st.phase === "reveal") {
      word.textContent = st.word.toUpperCase();
    } else if (isDrawer()) {
      word.textContent = myWord ? "Draw: " + myWord.toUpperCase() : "";
    } else {
      word.classList.add("mask");
      word.textContent = [...st.mask.toUpperCase()].join(" ") + "  (" + [...st.mask].length + ")";
    }
  }

  function renderOverlay() {
    const box = $("overlay");
    box.innerHTML = "";
    if (!st || st.phase === "draw") {
      box.hidden = true;
      return;
    }
    const card = document.createElement("div");
    card.className = "dg-card";
    if (st.phase === "choose" && isDrawer()) {
      const h = document.createElement("h3");
      h.textContent = "Choose a word to draw";
      const row = document.createElement("div");
      row.className = "btn-row";
      (choices || []).forEach((w, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn primary";
        b.textContent = w;
        b.addEventListener("click", () => room.to(room.hostId, "dg.pick", i));
        row.appendChild(b);
      });
      card.append(h, row);
    } else if (st.phase === "choose") {
      const p = nameOf(st.drawer);
      card.style.setProperty("--pc", NET.color(p.color));
      card.textContent = p.name + " is choosing a word…";
    } else {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = st.note;
      const line = document.createElement("div");
      line.append("The word was ");
      const b = document.createElement("b");
      b.textContent = st.word;
      line.appendChild(b);
      card.append(note, line);
    }
    box.appendChild(card);
    box.hidden = false;
  }

  function renderInput() {
    const input = $("guessInput");
    const me = st && st.players.find((p) => p.id === room.myId);
    let hint = "Your guess…";
    let off = !st;
    if (st && st.phase === "draw") {
      if (isDrawer()) {
        hint = "You are drawing!";
        off = true;
      } else if (me && me.got) {
        hint = "You got it! Wait for the others…";
        off = true;
      }
    } else if (st) {
      hint = "Say something…";
    }
    input.disabled = off;
    $("guessBtn").disabled = off;
    input.placeholder = hint;
  }

  /* ---------- Chat ---------- */

  $("guessForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("guessInput");
    const text = input.value.trim();
    if (!room || !text) return;
    room.to(room.hostId, "dg.guess", text);
    input.value = "";
  });

  function addChat(m) {
    if (!m || typeof m.text !== "string") return;
    const list = $("chat");
    const li = document.createElement("li");
    li.className = m.kind || "guess";
    if (m.kind === "guess") {
      const p = nameOf(m.id);
      const who = document.createElement("b");
      who.style.setProperty("--pc", NET.color(p.color));
      who.textContent = p.name + ": ";
      li.append(who, m.text);
    } else {
      li.textContent = m.text;
    }
    list.appendChild(li);
    while (list.children.length > CHAT_MAX) list.firstElementChild.remove();
    list.scrollTop = list.scrollHeight;
  }

  /* ---------- Drawing ---------- */

  function cleanStroke(s) {
    const p = Array.isArray(s.p) ? s.p.map((v) => Number(v) || 0) : [];
    return { s: s.s, c: /^#[0-9a-f]{6}$/i.test(s.c) ? s.c : COLORS[0], w: ARC.clamp(Number(s.w) || 4, 1, 60), p, drawn: 0 };
  }

  function onPoints(d, from) {
    if (!st || !d || d.t !== st.turnNo || from !== st.drawer || from === room.myId) return;
    let s = strokes.find((x) => x.s === d.s);
    if (!s) {
      s = cleanStroke({ s: d.s, c: d.c, w: d.w, p: [] });
      strokes.push(s);
    }
    if (Array.isArray(d.p)) for (let i = 0; i + 1 < d.p.length; i += 2) s.p.push(Number(d.p[i]) || 0, Number(d.p[i + 1]) || 0);
    pending.add(s);
  }

  function onUndo(d, from) {
    if (!st || !d || d.t !== st.turnNo || from !== st.drawer || from === room.myId) return;
    strokes = strokes.filter((s) => s.s !== d.s);
    full = true;
  }

  function onClear(d, from) {
    if (!st || !d || d.t !== st.turnNo || from !== st.drawer || from === room.myId) return;
    strokes = [];
    full = true;
  }

  function flush() {
    if (!current || !unsent.length || !st) return;
    room.share("dg.pts", { t: st.turnNo, s: current.s, c: current.c, w: current.w, p: unsent });
    unsent = [];
  }

  function addPoint(e) {
    const pt = pad.point(e);
    const x = Math.round(ARC.clamp(pt.x, 0, W));
    const y = Math.round(ARC.clamp(pt.y, 0, H));
    const p = current.p;
    if (p.length && Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) < 1.5) return;
    p.push(x, y);
    unsent.push(x, y);
    pending.add(current);
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!canDraw() || e.button > 0) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      // the pointer is already gone; the stroke still works while it stays over the canvas
    }
    current = { s: ++strokeSeq, c: erasing ? PAPER : color, w: erasing ? size * 2 : size, p: [], drawn: 0 };
    strokes.push(current);
    unsent = [];
    addPoint(e);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!current) return;
    if (!canDraw()) {
      current = null;
      return;
    }
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    (list.length ? list : [e]).forEach(addPoint);
  });

  function endStroke() {
    if (!current) return;
    flush();
    current = null;
  }
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  function buildTools() {
    const colors = $("colors");
    COLORS.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dg-swatch";
      b.style.background = c;
      b.setAttribute("aria-label", "Colour " + c);
      b.addEventListener("click", () => {
        color = c;
        erasing = false;
        markTools();
      });
      b.dataset.color = c;
      colors.appendChild(b);
    });
    const sizes = $("sizes");
    SIZES.forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dg-size";
      b.setAttribute("aria-label", "Brush size " + s);
      const dot = document.createElement("span");
      dot.style.width = dot.style.height = Math.min(22, s + 2) + "px";
      b.appendChild(dot);
      b.dataset.size = s;
      b.addEventListener("click", () => {
        size = s;
        markTools();
      });
      sizes.appendChild(b);
    });
    $("eraser").addEventListener("click", () => {
      erasing = !erasing;
      markTools();
    });
    $("undo").addEventListener("click", () => {
      if (!canDraw() || !strokes.length) return;
      endStroke();
      const last = strokes.pop();
      room.share("dg.undo", { t: st.turnNo, s: last.s });
      full = true;
    });
    $("clear").addEventListener("click", () => {
      if (!canDraw()) return;
      endStroke();
      strokes = [];
      room.share("dg.clear", { t: st.turnNo });
      full = true;
    });
    markTools();
  }

  function markTools() {
    document.querySelectorAll(".dg-swatch").forEach((b) => b.classList.toggle("on", !erasing && b.dataset.color === color));
    document.querySelectorAll(".dg-size").forEach((b) => b.classList.toggle("on", Number(b.dataset.size) === size));
    $("eraser").classList.toggle("on", erasing);
  }

  /* ---------- Loop ---------- */

  function update(dt) {
    if (current && flushDue(dt)) flush();
    if (room && room.isHost) hostUpdate();
  }

  function paint(ctx, s) {
    const p = s.p;
    if (p.length < 2) return;
    ctx.strokeStyle = s.c;
    ctx.fillStyle = s.c;
    ctx.lineWidth = s.w;
    if (p.length === 2) {
      if (!s.drawn) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], s.w / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      s.drawn = 2;
      return;
    }
    // carry on from the last point already painted
    const from = Math.max(0, s.drawn - 2);
    if (from >= p.length - 2) return;
    ctx.beginPath();
    ctx.moveTo(p[from], p[from + 1]);
    for (let i = from + 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.stroke();
    s.drawn = p.length;
  }

  function draw() {
    drawTimer();
    // resizing the canvas wipes it
    const sizeKey = canvas.width + "x" + canvas.height;
    if (sizeKey !== lastSize) {
      lastSize = sizeKey;
      full = true;
    }
    const ctx = pad.begin();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (full) {
      full = false;
      pending.clear();
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, W, H);
      strokes.forEach((s) => {
        s.drawn = 0;
        paint(ctx, s);
      });
      return;
    }
    pending.forEach((s) => paint(ctx, s));
    pending.clear();
  }

  function drawTimer() {
    const bar = $("timerBar");
    if (!st) {
      bar.style.width = "0";
      $("secs").textContent = "";
      return;
    }
    const left = Math.max(0, turnEnd - performance.now());
    const frac = left / turnTotal;
    bar.style.width = (frac * 100).toFixed(1) + "%";
    bar.classList.toggle("low", st.phase === "draw" && frac < 0.25);
    $("secs").textContent = Math.ceil(left / 1000) + " s";
  }
})();
