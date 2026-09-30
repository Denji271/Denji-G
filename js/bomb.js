// Word Bomb — type a word containing the letters on the bomb before it goes off in your hands.
// The host keeps the dictionary, the secret fuse and the lives; everybody else just shows them.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const BONUS = "abcdefghilmnoprstuv"; // use all of these to win back a life
  const MIN_TURN = 2000; // the bomb never goes off sooner than this after it reaches somebody
  const RECENT = 15; // letter groups that do not come back straight away
  const LEVELS = {
    easy: { min: 400, max: Infinity },
    normal: { min: 120, max: Infinity },
    hard: { min: 40, max: 600 },
  };
  const FUSES = { short: [6, 12], normal: [10, 20], long: [15, 28] };

  let room = null;
  let view = null; // latest state from the host: { players, turn, turnNo, syl, bomb, last, total, maxLives }
  let bombLit = 0; // local time the current bomb was lit
  let lastTyped = "";
  let phase = 0; // bomb wobble

  // host only
  let game = null;
  let dict = null; // { words: Set, list: [], counts: Map }

  LOBBY.init({
    game: "bomb",
    title: "Word Bomb",
    blurb: "Type a word containing the letters on the bomb, then pass it on before it explodes. 2–4 players.",
    minPlayers: 2,
    lateNote: "A match is on right now — you are in from the next one.",
    settings: [
      {
        key: "level",
        label: "Letters",
        value: "normal",
        options: [
          { value: "easy", label: "Easy" },
          { value: "normal", label: "Normal" },
          { value: "hard", label: "Hard" },
        ],
      },
      {
        key: "fuse",
        label: "Fuse",
        value: "normal",
        options: [
          { value: "short", label: "Short" },
          { value: "normal", label: "Normal" },
          { value: "long", label: "Long" },
        ],
      },
      {
        key: "lives",
        label: "Lives",
        value: 2,
        options: [
          { value: 1, label: "1" },
          { value: 2, label: "2" },
          { value: 3, label: "3" },
        ],
      },
    ],
    onRoom,
    onStart: startMatch,
    onLobby: () => {
      game = null;
      view = null;
      render();
    },
  });

  const loop = ARC.loop(update, drawBomb);
  loop.start();

  $("wordForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const word = $("wordInput").value.trim().toLowerCase();
    if (!room || !myTurn() || !word) return;
    room.to(room.hostId, "wb.word", word);
  });

  $("wordInput").addEventListener("input", () => {
    const text = $("wordInput").value.slice(0, 30);
    if (!room || !myTurn() || text === lastTyped) return;
    lastTyped = text;
    room.share("wb.type", text);
  });

  function onRoom(r) {
    room = r;
    room.on("wb.state", onState);
    room.on("wb.type", (text, from) => {
      if (view && from === view.turn) showTyping(text);
    });
    room.on("wb.no", (reason) => {
      WG.toast(reason, 1800);
      const input = $("wordInput");
      input.classList.remove("shake");
      void input.offsetWidth;
      input.classList.add("shake");
      input.select();
    });
    room.on("wb.boom", onBoom);
    room.on("wb.bonus", (id) => {
      const p = view && view.players.find((x) => x.id === id);
      if (p) WG.toast(id === room.myId ? "Every letter used — you win a life back!" : p.name + " used every letter and wins a life", 2200);
    });
    room.on("players", renderHud);

    if (room.isHost) {
      room.on("wb.word", onWord);
      room.on("leave", (p) => {
        if (!game) return;
        const g = game.players.find((x) => x.id === p.id);
        if (!g || g.lives === 0) return;
        g.lives = 0;
        g.outAt = g.words;
        game.outOrder.push(g.id);
        if (checkEnd()) return;
        if (game.turn === p.id) nextTurn();
        else broadcast();
      });
    }
  }

  function myTurn() {
    return !!(view && room && view.turn === room.myId);
  }

  /* ---------- Host ---------- */

  async function loadDict() {
    if (dict) return dict;
    const data = await WG.loadScript("data/chain.js", () => window.WORDGAME_DATA && window.WORDGAME_DATA.chain, "dictionary");
    const list = WG.splitWords(data.words).filter((w) => /^[a-z]+$/.test(w));
    // how many words each group of two or three letters turns up in
    const counts = new Map();
    list.forEach((w) => {
      const seen = new Set();
      for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) seen.add(w.slice(i, i + n));
      seen.forEach((s) => counts.set(s, (counts.get(s) || 0) + 1));
    });
    dict = { words: new Set(list), list, counts };
    return dict;
  }

  async function startMatch(settings) {
    try {
      await loadDict();
    } catch (e) {
      WG.toast("Could not load the dictionary", 2400);
      return;
    }
    const lv = LEVELS[settings.level] || LEVELS.normal;
    const pool = [];
    dict.counts.forEach((n, s) => {
      if (n >= lv.min && n <= lv.max) pool.push(s);
    });
    game = {
      settings,
      pool,
      players: WG.shuffle(room.players).map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        lives: settings.lives,
        words: 0,
        letters: new Set(),
        outAt: 0,
      })),
      used: new Set(),
      recent: [],
      turn: null,
      turnNo: 0,
      syl: "",
      bomb: 0,
      blowAt: 0,
      last: null,
      total: 0,
      started: room.players.length,
      outOrder: [],
    };
    game.turn = game.players[0].id;
    newBomb();
    broadcast();
  }

  function pickSyl() {
    let syl = "";
    for (let tries = 0; tries < 30; tries++) {
      syl = WG.pick(game.pool);
      if (!game.recent.includes(syl)) break;
    }
    game.recent.push(syl);
    if (game.recent.length > RECENT) game.recent.shift();
    return syl;
  }

  function newBomb() {
    const [lo, hi] = FUSES[game.settings.fuse] || FUSES.normal;
    game.bomb++;
    game.blowAt = performance.now() + (lo + Math.random() * (hi - lo)) * 1000;
    game.syl = pickSyl();
  }

  function broadcast() {
    const d = {
      players: game.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        lives: p.lives,
        words: p.words,
        letters: [...p.letters].sort().join(""),
      })),
      turn: game.turn,
      turnNo: game.turnNo,
      syl: game.syl,
      bomb: game.bomb,
      last: game.last,
      total: game.total,
      maxLives: game.settings.lives,
    };
    room.send("wb.state", d);
    room.emit("wb.state", d, room.myId);
  }

  function alive() {
    return game.players.filter((p) => p.lives > 0);
  }

  // The bomb moves on to the next player still in the game.
  function nextTurn() {
    const order = game.players;
    let i = order.findIndex((p) => p.id === game.turn);
    for (let step = 0; step < order.length; step++) {
      i = (i + 1) % order.length;
      if (order[i].lives > 0) break;
    }
    game.turn = order[i].id;
    game.turnNo++;
    game.blowAt = Math.max(game.blowAt, performance.now() + MIN_TURN);
    broadcast();
  }

  function checkEnd() {
    const left = alive();
    const over = game.started > 1 ? left.length <= 1 : left.length === 0;
    if (!over) return false;
    const ranked = left
      .slice()
      .sort((a, b) => b.lives - a.lives || b.words - a.words)
      .concat(game.outOrder.slice().reverse().map((id) => game.players.find((p) => p.id === id)));
    const rows = ranked.map((p) => ({
      name: p.name,
      color: p.color,
      value: p.words + (p.words === 1 ? " word" : " words"),
      note: p.lives > 0 ? p.lives + (p.lives === 1 ? " life left" : " lives left") : "",
    }));
    const title = left.length ? ranked[0].name + " wins!" : "Game over — " + game.total + " words";
    game = null;
    view = null;
    render();
    LOBBY.results(rows, title);
    return true;
  }

  function onWord(raw, from) {
    if (!game || from !== game.turn) return;
    const word = String(raw).toLowerCase().trim();
    let problem = "";
    if (!/^[a-z]+$/.test(word)) problem = "Letters only, please";
    else if (!word.includes(game.syl)) problem = "It has to contain " + game.syl.toUpperCase();
    else if (game.used.has(word)) problem = "Already used!";
    else if (!dict.words.has(word)) problem = "Not in the word list";
    if (problem) {
      room.to(from, "wb.no", problem);
      return;
    }
    const p = game.players.find((x) => x.id === from);
    p.words++;
    game.total++;
    game.used.add(word);
    game.last = { word, syl: game.syl, color: p.color };
    [...word].forEach((ch) => {
      if (BONUS.includes(ch)) p.letters.add(ch);
    });
    if (p.letters.size === BONUS.length) {
      p.letters.clear();
      if (p.lives < game.settings.lives) {
        p.lives++;
        room.send("wb.bonus", p.id);
        room.emit("wb.bonus", p.id, room.myId);
      }
    }
    game.syl = pickSyl();
    nextTurn();
  }

  // An example the holder could have typed, so everybody learns a word.
  function example(syl) {
    const list = dict.list;
    const start = Math.floor(Math.random() * list.length);
    for (let k = 0; k < list.length; k++) {
      const w = list[(start + k) % list.length];
      if (w.length <= 9 && w.includes(syl) && !game.used.has(w)) return w;
    }
    return "";
  }

  function update() {
    if (!room || !room.isHost || !game) return;
    if (performance.now() < game.blowAt) return;
    const p = game.players.find((x) => x.id === game.turn);
    p.lives = Math.max(0, p.lives - 1);
    if (p.lives === 0) {
      p.outAt = p.words;
      game.outOrder.push(p.id);
    }
    const d = { id: p.id, out: p.lives === 0, syl: game.syl, example: example(game.syl) };
    room.send("wb.boom", d);
    room.emit("wb.boom", d, room.myId);
    if (checkEnd()) return;
    newBomb();
    nextTurn();
  }

  /* ---------- Everybody ---------- */

  function onState(d) {
    const newTurn = !view || d.turnNo !== view.turnNo;
    if (!view || d.bomb !== view.bomb) bombLit = performance.now();
    view = d;
    if (d.players.some((p) => p.id === room.myId)) LOBBY.hide();
    if (newTurn) startTurn();
    render();
  }

  function startTurn() {
    showTyping("");
    lastTyped = "";
    const input = $("wordInput");
    input.value = "";
    const mine = myTurn();
    input.disabled = !mine;
    $("sendBtn").disabled = !mine;
    input.placeholder = mine ? "A word with " + view.syl.toUpperCase() + " in it…" : "Wait for your turn…";
    if (mine) setTimeout(() => input.focus(), 30);
    const syl = $("syl");
    syl.classList.remove("new");
    void syl.offsetWidth;
    syl.classList.add("new");
  }

  function onBoom(d) {
    const p = view && view.players.find((x) => x.id === d.id);
    const bomb = $("bomb");
    bomb.classList.remove("boom");
    void bomb.offsetWidth;
    bomb.classList.add("boom");
    ARC.banner("BOOM!", 900);
    if (!p) return;
    const who = d.id === room.myId ? (d.out ? "You are out!" : "You lose a life!") : p.name + (d.out ? " is out!" : " loses a life");
    WG.toast(d.example ? who + " — " + d.syl.toUpperCase() + " is in " + d.example.toUpperCase() : who, 2600);
  }

  function showTyping(text) {
    $("typing").textContent = text ? text.toUpperCase() : "";
  }

  function render() {
    renderHud();
    const ring = $("ring");
    ring.innerHTML = "";
    if (!view) {
      ["who", "syl", "typing", "last", "letters"].forEach((id) => ($(id).textContent = ""));
      $("bomb").hidden = true;
      return;
    }
    $("bomb").hidden = false;
    view.players.forEach((p) => {
      const li = document.createElement("li");
      li.style.setProperty("--pc", NET.color(p.color));
      if (p.id === view.turn) li.classList.add("turn");
      if (p.lives === 0) li.classList.add("out");
      const dot = document.createElement("span");
      dot.className = "dot";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.name + (p.id === room.myId ? " (you)" : "");
      const lives = document.createElement("span");
      lives.className = "lives";
      lives.textContent = "♥".repeat(p.lives) + "♡".repeat(Math.max(0, view.maxLives - p.lives));
      li.append(dot, name, lives);
      ring.appendChild(li);
    });

    const current = view.players.find((p) => p.id === view.turn);
    const mine = current && current.id === room.myId;
    $("who").textContent = current ? (mine ? "Your turn!" : current.name + "'s turn") : "";
    $("who").style.setProperty("--pc", current ? NET.color(current.color) : "transparent");
    $("syl").textContent = view.syl.toUpperCase();

    // the last good word, with the letters it needed picked out
    const last = $("last");
    last.innerHTML = "";
    if (view.last) {
      const w = view.last.word.toUpperCase();
      const at = view.last.word.indexOf(view.last.syl);
      last.style.setProperty("--pc", NET.color(view.last.color));
      const hit = document.createElement("b");
      hit.textContent = w.slice(at, at + view.last.syl.length);
      last.append(w.slice(0, at), hit, w.slice(at + view.last.syl.length));
    }

    const me = view.players.find((p) => p.id === room.myId);
    const box = $("letters");
    box.innerHTML = "";
    if (me) {
      [...BONUS].forEach((ch) => {
        const s = document.createElement("span");
        s.textContent = ch;
        if (me.letters.includes(ch)) s.className = "on";
        box.appendChild(s);
      });
    }
  }

  function renderHud() {
    if (!view) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = view.players.map((p) => ({
      name: p.name,
      color: p.color,
      value: p.words,
      out: p.lives === 0,
      me: room && p.id === room.myId,
    }));
    rows.push({ name: "Words", color: -1, value: view.total });
    ARC.scoreboard($("hud"), rows);
  }

  // The bomb wobbles faster the longer it has been lit — but never says when it will go.
  let lastFrame = 0;
  function drawBomb() {
    const now = performance.now();
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    if (!view) return;
    const lit = (now - bombLit) / 1000;
    phase += dt * (5 + lit * 0.9);
    const svg = $("bomb").firstElementChild;
    svg.style.transform = "scale(" + (1 + 0.035 * Math.sin(phase)).toFixed(3) + ") rotate(" + (2.5 * Math.sin(phase * 0.5)).toFixed(2) + "deg)";
    $("spark").style.opacity = (0.55 + Math.random() * 0.45).toFixed(2);
  }
})();
