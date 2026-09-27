// The room screen every multiplayer game shares: create or join a room, see who is in,
// host-only settings, Start, and the results screen after a match.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let opts = null;
  let room = null;
  let values = {};
  let labels = {};
  let playing = false;
  let busy = false;

  const HTML = `
    <div class="lobby-card">
      <section data-panel="connect">
        <h2 id="lbTitle"></h2>
        <p class="muted center lobby-blurb" id="lbBlurb"></p>
        <label class="field"><span>Your name</span>
          <input class="text-input" id="lbName" maxlength="16" autocomplete="off" spellcheck="false">
        </label>
        <button class="btn primary block" type="button" id="lbCreate">Create room</button>
        <div class="lobby-or"><span>or join a friend</span></div>
        <form class="join-row" id="lbJoinForm" autocomplete="off">
          <input class="text-input code-input" id="lbCode" maxlength="4" placeholder="CODE" spellcheck="false" aria-label="Room code">
          <button class="btn" type="submit" id="lbJoin">Join</button>
        </form>
        <p class="form-error center" id="lbError"></p>
      </section>

      <section data-panel="room" hidden>
        <div class="room-code">
          <span class="muted">Room code</span>
          <b id="lbRoomCode"></b>
          <div class="btn-row tight">
            <button class="btn small" type="button" id="lbCopyCode">Copy code</button>
            <button class="btn small" type="button" id="lbCopyLink">Copy invite link</button>
          </div>
        </div>
        <ul class="player-list" id="lbPlayers"></ul>
        <div class="lobby-settings" id="lbSettings"></div>
        <p class="muted center lobby-note" id="lbNote"></p>
        <div class="btn-row">
          <button class="btn" type="button" id="lbLeave">Leave</button>
          <button class="btn primary" type="button" id="lbStart">Start</button>
        </div>
      </section>

      <section data-panel="results" hidden>
        <h2 id="lbResTitle">Results</h2>
        <ol class="results" id="lbResults"></ol>
        <p class="muted center lobby-note" id="lbResNote">Waiting for the host…</p>
        <div class="btn-row" id="lbResBtns">
          <button class="btn" type="button" id="lbToLobby">Lobby</button>
          <button class="btn primary" type="button" id="lbAgain">Play again</button>
        </div>
      </section>
    </div>`;

  const LEAVE_HTML = `
    <h2>Menu</h2>
    <p class="center muted" id="leaveText"></p>
    <div class="btn-row">
      <button class="btn" type="button" data-close>Keep playing</button>
      <button class="btn" type="button" id="leaveEnd">End match</button>
      <button class="btn primary" type="button" id="leaveYes">Leave room</button>
    </div>`;

  // o: { game, title, blurb, minPlayers, lateNote, settings: [{ key, label, value, options, show }],
  //      onRoom(room), onStart(values), onLobby(), onSettings(values) }
  function init(o) {
    opts = Object.assign({ minPlayers: 1, settings: [], onRoom() {}, onStart() {}, onLobby() {}, onSettings() {} }, o);
    const box = $("lobby");
    box.classList.add("lobby");
    box.innerHTML = HTML;

    const leave = document.createElement("dialog");
    leave.id = "leaveDlg";
    leave.innerHTML = LEAVE_HTML;
    document.body.appendChild(leave);

    $("lbTitle").textContent = opts.title;
    $("lbBlurb").textContent = opts.blurb || "";
    opts.settings.forEach((s) => {
      values[s.key] = s.value;
    });

    const nameInput = $("lbName");
    nameInput.value = WG.store.get("mp:name", "") || "";
    nameInput.addEventListener("change", () => WG.store.set("mp:name", nameInput.value.trim()));

    const codeInput = $("lbCode");
    codeInput.addEventListener("input", () => {
      codeInput.value = NET.cleanCode(codeInput.value);
    });

    $("lbCreate").addEventListener("click", create);
    $("lbJoinForm").addEventListener("submit", (e) => {
      e.preventDefault();
      join(codeInput.value);
    });
    $("lbCopyCode").addEventListener("click", async () => {
      WG.toast((await WG.copyText(room.code)) ? "Code copied" : "Could not copy");
    });
    $("lbCopyLink").addEventListener("click", async () => {
      const ok = await WG.copyText(WG.pageUrl(room.page, { join: room.code }));
      WG.toast(ok ? "Invite link copied — send it to a friend!" : "Could not copy", 2200);
    });
    $("lbLeave").addEventListener("click", () => leaveRoom());
    $("lbStart").addEventListener("click", () => startMatch());
    $("lbAgain").addEventListener("click", () => startMatch());
    $("lbToLobby").addEventListener("click", () => {
      room.send("lb.back");
      backToLobby();
    });
    $("leaveYes").addEventListener("click", () => {
      $("leaveDlg").close();
      leaveRoom();
    });
    $("leaveEnd").addEventListener("click", () => {
      $("leaveDlg").close();
      if (!room || !room.isHost) return;
      room.send("lb.back");
      backToLobby();
    });

    // Esc during a match opens the menu.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !room || !box.hidden || WG.anyDialogOpen()) return;
      e.preventDefault();
      $("leaveText").textContent = room.isHost
        ? "End match takes everybody back to the room. Leaving closes the room for everybody."
        : "Leaving takes you out of the room.";
      $("leaveEnd").hidden = !room.isHost;
      WG.openDialog("leaveDlg");
    });

    WG.setupDialogs();
    showPanel("connect");

    const code = WG.params().get("join");
    if (code) {
      codeInput.value = NET.cleanCode(code);
      history.replaceState(null, "", location.pathname);
      join(code);
    } else {
      setTimeout(() => (nameInput.value ? $("lbCreate") : nameInput).focus(), 50);
    }
  }

  function playerName() {
    const input = $("lbName");
    let name = input.value.trim();
    if (!name) {
      name = "Player " + (10 + Math.floor(Math.random() * 90));
      input.value = name;
    }
    WG.store.set("mp:name", name);
    return name;
  }

  function setBusy(on, text) {
    busy = on;
    ["lbCreate", "lbJoin", "lbCode", "lbName"].forEach((id) => ($(id).disabled = on));
    $("lbError").classList.toggle("info", on);
    $("lbError").textContent = on ? text : "";
  }

  function showError(text) {
    $("lbError").classList.remove("info");
    $("lbError").textContent = text || "";
  }

  async function create() {
    if (busy) return;
    setBusy(true, "Creating a room…");
    try {
      const r = await NET.host({ game: opts.game, name: playerName() });
      setBusy(false);
      enter(r);
    } catch (err) {
      setBusy(false);
      showError(err.message);
    }
  }

  async function join(code) {
    if (busy) return;
    const clean = NET.cleanCode(code);
    if (!NET.validCode(clean)) {
      showError("Type the " + NET.CODE_LEN + "-character room code");
      $("lbCode").focus();
      return;
    }
    setBusy(true, "Joining " + clean + "…");
    try {
      const r = await NET.join(clean, { game: opts.game, name: playerName() });
      setBusy(false);
      enter(r);
    } catch (err) {
      setBusy(false);
      if (err instanceof NET.WrongGame) {
        location.href = WG.pageUrl(err.page, { join: clean });
        return;
      }
      showError(err.message);
    }
  }

  /* ---------- In a room ---------- */

  function enter(r) {
    room = r;
    playing = false;
    const sub = $("subtitle");
    if (sub) sub.textContent = room.code;

    room.on("players", renderPlayers);
    room.on("ping", renderPlayers);
    room.on("closed", (reason) => {
      room = null;
      playing = false;
      if (sub) sub.textContent = "";
      opts.onLobby();
      $("lobby").hidden = false;
      showPanel("connect");
      showError(reason);
      WG.toast(reason, 2600);
    });

    if (room.isHost) {
      room.on("join", (player) => room.to(player.id, "lb.settings", settingsPayload()));
    } else {
      room.on("lb.settings", (d) => {
        values = d.values;
        labels = d.labels;
        playing = d.playing;
        renderSettings();
        renderNote();
        opts.onSettings(values);
      });
      room.on("lb.results", (d) => showResults(d.rows, d.title));
      room.on("lb.back", () => backToLobby());
    }

    opts.onRoom(room);
    showRoom();
  }

  function showRoom() {
    $("lobby").hidden = false;
    $("lbRoomCode").textContent = room.code;
    $("lbStart").hidden = !room.isHost;
    renderSettings();
    renderPlayers();
    showPanel("room");
  }

  function renderPlayers() {
    const list = $("lbPlayers");
    if (!list || !room) return;
    list.innerHTML = "";
    room.players.forEach((p) => {
      const li = document.createElement("li");
      li.style.setProperty("--pc", NET.color(p.color));
      const dot = document.createElement("span");
      dot.className = "dot";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = p.name + (p.id === room.myId ? " (you)" : "");
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = p.host ? "host" : p.ping ? p.ping + " ms" : "";
      li.append(dot, name, tag);
      list.appendChild(li);
    });
    for (let i = room.players.length; i < NET.MAX_PLAYERS; i++) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Free seat";
      list.appendChild(li);
    }
    renderNote();
  }

  function renderNote() {
    const note = $("lbNote");
    if (!room) return;
    if (room.isHost) {
      const min = minPlayers();
      const missing = min - room.players.length;
      note.textContent =
        missing > 0
          ? "Needs at least " + min + " players — share the code with your friends."
          : "Share the code, then press Start when everybody is in.";
      $("lbStart").disabled = missing > 0;
    } else {
      note.textContent = playing
        ? opts.lateNote || "A game is on right now — you are in from the next round."
        : "Waiting for the host to start…";
    }
  }

  function minPlayers() {
    return typeof opts.minPlayers === "function" ? opts.minPlayers(values) : opts.minPlayers;
  }

  function optionList(s) {
    return typeof s.options === "function" ? s.options(values) : s.options;
  }

  function settingsPayload() {
    return { values, labels, playing };
  }

  function renderSettings() {
    const box = $("lbSettings");
    box.innerHTML = "";
    opts.settings.forEach((s) => {
      if (s.show && !s.show(values)) return;
      const row = document.createElement("label");
      row.className = "setting";
      const name = document.createElement("span");
      name.textContent = s.label;
      row.appendChild(name);
      if (room && room.isHost) {
        const options = optionList(s);
        const select = document.createElement("select");
        select.className = "text-input";
        let found = false;
        options.forEach((o, i) => {
          const opt = document.createElement("option");
          opt.value = i;
          opt.textContent = o.label;
          if (o.value === values[s.key]) {
            opt.selected = true;
            found = true;
          }
          select.appendChild(opt);
        });
        if (!found && options.length) values[s.key] = options[0].value;
        const current = options.find((o) => o.value === values[s.key]);
        labels[s.key] = current ? current.label : "";
        select.addEventListener("change", () => {
          const o = options[Number(select.value)];
          values[s.key] = o.value;
          labels[s.key] = o.label;
          opts.onSettings(values);
          renderSettings();
          renderNote();
        });
        row.appendChild(select);
      } else {
        const val = document.createElement("b");
        val.textContent = labels[s.key] || "—";
        row.appendChild(val);
      }
      box.appendChild(row);
    });
    if (room && room.isHost) room.send("lb.settings", settingsPayload());
  }

  function startMatch() {
    if (!room || !room.isHost) return;
    if (room.players.length < minPlayers()) return;
    opts.onStart(values);
  }

  function showPanel(name) {
    document.querySelectorAll("#lobby [data-panel]").forEach((p) => {
      p.hidden = p.dataset.panel !== name;
    });
  }

  function backToLobby() {
    playing = false;
    opts.onLobby();
    if (room) {
      showRoom();
      if (room.isHost) room.send("lb.settings", settingsPayload());
    }
  }

  function leaveRoom() {
    if (room) room.close();
    room = null;
    playing = false;
    const sub = $("subtitle");
    if (sub) sub.textContent = "";
    opts.onLobby();
    $("lobby").hidden = false;
    showError("");
    showPanel("connect");
  }

  /* ---------- Called by the games ---------- */

  // The match is on: hide the lobby (every machine calls this when the game starts).
  function hide() {
    playing = true;
    $("lobby").hidden = true;
    if (room && room.isHost) room.send("lb.settings", settingsPayload());
  }

  // rows: [{ name, color, value, note }] best first. The host calls this; guests follow.
  function results(rows, title) {
    if (room && room.isHost) room.send("lb.results", { rows, title });
    showResults(rows, title);
  }

  function showResults(rows, title) {
    playing = false;
    $("lbResTitle").textContent = title || "Results";
    const list = $("lbResults");
    list.innerHTML = "";
    rows.forEach((r) => {
      const li = document.createElement("li");
      li.style.setProperty("--pc", NET.color(r.color));
      const dot = document.createElement("span");
      dot.className = "dot";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const val = document.createElement("b");
      val.textContent = r.value === undefined ? "" : r.value;
      li.append(dot, name, val);
      if (r.note) {
        const note = document.createElement("small");
        note.className = "muted";
        note.textContent = r.note;
        name.appendChild(note);
      }
      list.appendChild(li);
    });
    const host = room && room.isHost;
    $("lbResBtns").hidden = !host;
    $("lbResNote").hidden = host;
    $("lobby").hidden = false;
    showPanel("results");
  }

  window.LOBBY = {
    init,
    hide,
    results,
    get room() {
      return room;
    },
    get settings() {
      return values;
    },
  };
})();
