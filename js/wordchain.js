// Word Chain — take turns naming words that start with the last letter of the previous one.
// The host keeps the dictionary, the clock and the lives; everybody else just shows them.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SHOWN = 8; // words of the chain on screen

  let room = null;
  let view = null; // latest state from the host: { chain, players, turn, letter, limit, round }
  let turnEnd = 0; // local clock time when the current turn runs out
  let turnMs = 1;

  // host only
  let game = null;
  let dict = null;

  LOBBY.init({
    game: "wordchain",
    title: "Word Chain",
    blurb: "Take turns naming English words that start with the last letter of the word before. 2–4 players.",
    lateNote: "A match is on right now — you are in from the next one.",
    settings: [
      {
        key: "time",
        label: "Time per turn",
        value: 10,
        options: [
          { value: 15, label: "Relaxed (15 s)" },
          { value: 10, label: "Normal (10 s)" },
          { value: 7, label: "Quick (7 s)" },
        ],
      },
      {
        key: "lives",
        label: "Lives",
        value: 3,
        options: [
          { value: 1, label: "1" },
          { value: 2, label: "2" },
          { value: 3, label: "3" },
        ],
      },
      {
        key: "min",
        label: "Shortest word",
        value: 3,
        options: [
          { value: 3, label: "3 letters" },
          { value: 4, label: "4 letters" },
          { value: 5, label: "5 letters" },
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

  const loop = ARC.loop(update, drawTimer);
  loop.start();

  $("wordForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const word = $("wordInput").value.trim().toLowerCase();
    if (!room || !myTurn() || !word) return;
    room.to(room.hostId, "wc.word", word);
  });

  let lastTyped = "";
  $("wordInput").addEventListener("input", () => {
    const text = $("wordInput").value.slice(0, 24);
    if (!room || !myTurn() || text === lastTyped) return;
    lastTyped = text;
    room.share("wc.type", text);
  });

  function onRoom(r) {
    room = r;
    room.on("wc.state", (d) => {
      const fresh = !view || d.total !== view.total;
      view = d;
      if (d.players.some((p) => p.id === room.myId)) LOBBY.hide();
      render(fresh);
    });
    room.on("wc.turn", onTurn);
    room.on("wc.type", (text, from) => {
      if (view && from === view.turn) showTyping(text);
    });
    room.on("wc.no", (reason) => {
      WG.toast(reason, 1800);
      const input = $("wordInput");
      input.classList.remove("shake");
      void input.offsetWidth;
      input.classList.add("shake");
      input.select();
    });
    room.on("wc.fail", (d) => {
      const p = view && view.players.find((x) => x.id === d.id);
      if (!p) return;
      WG.toast(d.id === room.myId ? (d.out ? "Out of time — you are out!" : "Out of time — you lose a life") : p.name + (d.out ? " is out!" : " ran out of time"), 2000);
    });
    room.on("players", renderHud);

    if (room.isHost) {
      room.on("wc.word", onWord);
      room.on("leave", (p) => {
        if (!game) return;
        const g = game.players.find((x) => x.id === p.id);
        if (!g || g.lives === 0) return;
        g.lives = 0;
        g.outAt = game.round;
        game.outOrder.push(g.id);
        if (game.turn === p.id) nextTurn();
        else if (!checkEnd()) broadcast();
      });
    }
  }

  function myTurn() {
    return !!(view && room && view.turn === room.myId);
  }

  /* ---------- Host ---------- */

  async function startMatch(settings) {
    if (!dict) {
      try {
        const data = await WG.loadScript("data/chain.js", () => window.WORDGAME_DATA && window.WORDGAME_DATA.chain, "dictionary");
        dict = { words: new Set(WG.splitWords(data.words)), starts: WG.splitWords(data.starts) };
      } catch (e) {
        WG.toast("Could not load the dictionary", 2400);
        return;
      }
    }
    const first = WG.pick(dict.starts);
    game = {
      settings,
      players: WG.shuffle(room.players).map((p) => ({ id: p.id, name: p.name, color: p.color, lives: settings.lives, words: 0, outAt: 0 })),
      chain: [{ word: first, color: -1 }],
      used: new Set([first]),
      turn: null,
      letter: first[first.length - 1],
      limit: settings.time * 1000,
      round: 1,
      started: room.players.length,
      outOrder: [],
      deadline: 0,
    };
    game.turn = game.players[0].id;
    startTurn();
  }

  function broadcast() {
    const d = {
      chain: game.chain.slice(-SHOWN - 1),
      total: game.chain.length,
      players: game.players.map((p) => ({ id: p.id, name: p.name, color: p.color, lives: p.lives, words: p.words })),
      turn: game.turn,
      letter: game.letter,
      round: game.round,
      maxLives: game.settings.lives,
    };
    room.send("wc.state", d);
    room.emit("wc.state", d, room.myId);
  }

  function startTurn() {
    game.deadline = performance.now() + game.limit;
    broadcast();
    const d = { id: game.turn, letter: game.letter, ms: game.limit };
    room.send("wc.turn", d);
    onTurn(d);
  }

  function alive() {
    return game.players.filter((p) => p.lives > 0);
  }

  // Moves on to the next player still in the game; a lap past the first seat shortens the clock.
  function nextTurn() {
    if (checkEnd()) return;
    const order = game.players;
    let i = order.findIndex((p) => p.id === game.turn);
    for (let step = 0; step < order.length; step++) {
      i = (i + 1) % order.length;
      if (i === 0) {
        game.round++;
        const floor = Math.max(4000, (game.settings.time * 1000) / 2);
        game.limit = Math.max(floor, game.limit - 1000);
      }
      if (order[i].lives > 0) break;
    }
    game.turn = order[i].id;
    startTurn();
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
      note: p.lives > 0 ? p.lives + (p.lives === 1 ? " life left" : " lives left") : "out in round " + p.outAt,
    }));
    const title = left.length ? ranked[0].name + " wins!" : "Game over — " + (game.chain.length - 1) + " words";
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
    else if (word[0] !== game.letter) problem = "It has to start with " + game.letter.toUpperCase();
    else if (word.length < game.settings.min) problem = "At least " + game.settings.min + " letters";
    else if (game.used.has(word)) problem = "Already used!";
    else if (!dict.words.has(word)) problem = "Not in the word list";
    if (problem) {
      room.to(from, "wc.no", problem);
      return;
    }
    const p = game.players.find((x) => x.id === from);
    p.words++;
    game.used.add(word);
    game.chain.push({ word, color: p.color });
    game.letter = word[word.length - 1];
    nextTurn();
  }

  function update() {
    if (!room || !room.isHost || !game) return;
    if (performance.now() < game.deadline) return;
    const p = game.players.find((x) => x.id === game.turn);
    p.lives--;
    if (p.lives <= 0) {
      p.lives = 0;
      p.outAt = game.round;
      game.outOrder.push(p.id);
    }
    const d = { id: p.id, out: p.lives === 0 };
    room.send("wc.fail", d);
    room.emit("wc.fail", d, room.myId);
    nextTurn();
  }

  /* ---------- Everybody ---------- */

  function onTurn(d) {
    turnEnd = performance.now() + d.ms;
    turnMs = d.ms;
    showTyping("");
    lastTyped = "";
    const input = $("wordInput");
    input.value = "";
    const mine = d.id === room.myId;
    input.disabled = !mine;
    $("sendBtn").disabled = !mine;
    input.placeholder = mine ? "Your word, starting with " + d.letter.toUpperCase() + "…" : "Wait for your turn…";
    if (mine) setTimeout(() => input.focus(), 30);
  }

  function showTyping(text) {
    $("typing").textContent = text ? text.toUpperCase() : "";
  }

  function render(fresh) {
    renderHud();
    const chain = $("chain");
    chain.innerHTML = "";
    if (!view) {
      ["who", "letter", "typing"].forEach((id) => ($(id).textContent = ""));
      return;
    }
    const words = view.chain.slice(-SHOWN);
    words.forEach((w, i) => {
      const li = document.createElement("li");
      if (w.color >= 0) li.style.setProperty("--pc", NET.color(w.color));
      else li.classList.add("start");
      li.append(w.word.slice(0, -1).toUpperCase());
      const last = document.createElement("b");
      last.textContent = w.word.slice(-1).toUpperCase();
      li.appendChild(last);
      if (fresh && i === words.length - 1) li.classList.add("new");
      chain.appendChild(li);
    });
    chain.scrollLeft = chain.scrollWidth;

    const current = view.players.find((p) => p.id === view.turn);
    const mine = current && current.id === room.myId;
    $("who").textContent = current ? (mine ? "Your turn!" : current.name + "'s turn") : "";
    $("who").style.setProperty("--pc", current ? NET.color(current.color) : "transparent");
    $("letter").textContent = view.letter.toUpperCase();
  }

  function renderHud() {
    if (!view) {
      ARC.scoreboard($("hud"), []);
      return;
    }
    const rows = view.players.map((p) => ({
      name: p.name,
      color: p.color,
      value: "♥".repeat(p.lives) + "♡".repeat(Math.max(0, view.maxLives - p.lives)),
      out: p.lives === 0,
      me: room && p.id === room.myId,
    }));
    rows.push({ name: "Round", color: -1, value: view.round });
    ARC.scoreboard($("hud"), rows);
  }

  function drawTimer() {
    const bar = $("timerBar");
    if (!view) {
      bar.style.width = "0";
      return;
    }
    const left = Math.max(0, turnEnd - performance.now());
    const frac = left / turnMs;
    bar.style.width = (frac * 100).toFixed(1) + "%";
    bar.classList.toggle("low", frac < 0.3);
  }
})();
