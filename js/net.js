// Rooms for the multiplayer games: one host and up to three guests, talking over PeerJS.
// The host's browser is the hub — guests only ever talk to the host, who passes things on.
(function () {
  "use strict";

  const PEERJS_URL = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
  const PREFIX = "denjig-";
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I mix-ups
  const CODE_LEN = 4;
  const MAX_PLAYERS = 4;
  const COLORS = ["#e05c4a", "#2f6fde", "#57a05a", "#f0c419"];
  const COLOR_NAMES = ["Red", "Blue", "Green", "Yellow"];
  const PING_EVERY = 2000;
  const SILENT_LIMIT = 9000; // a peer that says nothing for this long is gone
  const JOIN_TIMEOUT = 12000;

  let current = null;

  function loadPeer() {
    return WG.loadScript(PEERJS_URL, () => window.Peer, "PeerJS").catch(() => {
      throw new Error("Could not load the online library — check your internet connection");
    });
  }

  function makeCode() {
    const bytes = new Uint8Array(CODE_LEN);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  }

  function cleanCode(str) {
    return String(str || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, CODE_LEN);
  }

  function validCode(code) {
    return code.length === CODE_LEN && [...code].every((ch) => CODE_CHARS.includes(ch));
  }

  function cleanName(name) {
    return String(name || "").replace(/\s+/g, " ").trim().slice(0, 16) || "Player";
  }

  function errorText(err) {
    switch (err && err.type) {
      case "peer-unavailable":
        return "No room with that code";
      case "network":
      case "server-error":
      case "socket-error":
      case "socket-closed":
        return "Could not reach the game server — check your internet connection";
      case "browser-incompatible":
        return "This browser cannot play online";
      default:
        return (err && err.message) || "Connection problem";
    }
  }

  function openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
      const onError = (err) => {
        peer.destroy();
        reject(err);
      };
      peer.once("error", onError);
      peer.once("open", () => {
        peer.off("error", onError);
        resolve(peer);
      });
    });
  }

  function emitter(target) {
    const handlers = {};
    target.on = (type, fn) => {
      (handlers[type] = handlers[type] || []).push(fn);
      return target;
    };
    target.off = (type, fn) => {
      handlers[type] = (handlers[type] || []).filter((h) => h !== fn);
      return target;
    };
    target.emit = (type, data, from) => {
      (handlers[type] || []).slice().forEach((fn) => {
        try {
          fn(data, from);
        } catch (e) {
          console.error(e);
        }
      });
    };
    return target;
  }

  function thisPage() {
    return location.pathname.split("/").pop() || "index.html";
  }

  /* ---------- Host ---------- */

  // opts: { game, name }
  async function host(opts) {
    await loadPeer();
    let peer = null;
    let code = "";
    for (let attempt = 0; attempt < 5 && !peer; attempt++) {
      code = makeCode();
      try {
        peer = await openPeer(PREFIX + code);
      } catch (err) {
        if (err.type !== "unavailable-id") throw new Error(errorText(err));
      }
    }
    if (!peer) throw new Error("Could not create a room, please try again");
    return hostRoom(peer, code, opts);
  }

  function hostRoom(peer, code, opts) {
    const conns = new Map(); // peer id -> DataConnection
    const seen = new Map(); // peer id -> last time we heard from them
    const pingSent = new Map();
    let closed = false;

    const room = emitter({
      code,
      isHost: true,
      game: opts.game,
      page: thisPage(),
      myId: peer.id,
      hostId: peer.id,
      players: [{ id: peer.id, name: cleanName(opts.name), color: 0, host: true, ping: 0 }],
    });
    room.me = room.players[0];

    function freeColor() {
      for (let c = 0; c < MAX_PLAYERS; c++) if (!room.players.some((p) => p.color === c)) return c;
      return 0;
    }

    function raw(conn, msg) {
      if (conn && conn.open) {
        try {
          conn.send(msg);
        } catch (e) {
          // the channel closed mid-send; the close handler tidies up
        }
      }
    }

    // Connections that only came to ask which game this is are not players.
    function eachGuest(fn) {
      conns.forEach((conn, id) => {
        if (room.players.some((p) => p.id === id)) fn(conn, id);
      });
    }

    function sendPlayers() {
      eachGuest((conn) => raw(conn, { t: "_players", d: room.players }));
      room.emit("players", room.players);
    }

    function drop(id) {
      const conn = conns.get(id);
      conns.delete(id);
      seen.delete(id);
      if (conn) conn.close();
      const player = room.players.find((p) => p.id === id);
      if (!player) return;
      room.players = room.players.filter((p) => p.id !== id);
      sendPlayers();
      room.emit("leave", player);
    }

    function onData(conn, msg) {
      if (!msg || typeof msg.t !== "string") return;
      seen.set(conn.peer, Date.now());
      const known = room.players.some((p) => p.id === conn.peer);

      if (msg.t === "_join") {
        if (known || !msg.d) return;
        if (msg.d.game !== room.game) {
          raw(conn, { t: "_wrong", d: { game: room.game, page: room.page } });
          setTimeout(() => drop(conn.peer), 1500);
          return;
        }
        if (room.players.length >= MAX_PLAYERS) {
          raw(conn, { t: "_full" });
          setTimeout(() => drop(conn.peer), 1500);
          return;
        }
        const player = { id: conn.peer, name: cleanName(msg.d.name), color: freeColor(), host: false, ping: 0 };
        room.players.push(player);
        raw(conn, { t: "_welcome", d: { id: conn.peer, code, game: room.game, players: room.players } });
        sendPlayers();
        room.emit("join", player);
        return;
      }
      if (!known) return;
      if (msg.t === "_pong") {
        const sent = pingSent.get(conn.peer);
        const player = room.players.find((p) => p.id === conn.peer);
        if (sent && player) player.ping = Math.round(performance.now() - sent);
        return;
      }
      if (msg.t === "_bye") {
        drop(conn.peer);
        return;
      }
      // Shared messages go to every other guest as well.
      if (msg.s) {
        eachGuest((other, id) => {
          if (id !== conn.peer) raw(other, { t: msg.t, d: msg.d, f: conn.peer });
        });
      }
      room.emit(msg.t, msg.d, conn.peer);
    }

    peer.on("connection", (conn) => {
      conn.on("open", () => {
        conns.set(conn.peer, conn);
        seen.set(conn.peer, Date.now());
      });
      conn.on("data", (msg) => onData(conn, msg));
      conn.on("close", () => drop(conn.peer));
      conn.on("error", () => drop(conn.peer));
    });

    peer.on("disconnected", () => {
      // Lost the broker only: existing players keep playing, new ones cannot join until it is back.
      if (!closed && !peer.destroyed) peer.reconnect();
    });

    peer.on("error", (err) => {
      if (err.type === "network" || err.type === "server-error") return;
      console.warn("PeerJS:", err.type);
    });

    const pinger = setInterval(() => {
      const now = Date.now();
      seen.forEach((time, id) => {
        if (now - time > SILENT_LIMIT) drop(id);
      });
      const pings = room.players.map((p) => ({ id: p.id, ping: p.ping }));
      eachGuest((conn, id) => {
        pingSent.set(id, performance.now());
        raw(conn, { t: "_ping", d: pings });
      });
      room.emit("ping", room.players);
    }, PING_EVERY);

    room.send = (type, data) => {
      eachGuest((conn) => raw(conn, { t: type, d: data, f: peer.id }));
    };
    room.share = room.send;
    room.to = (id, type, data) => {
      if (id === peer.id) room.emit(type, data, peer.id);
      else raw(conns.get(id), { t: type, d: data, f: peer.id });
    };
    room.player = (id) => room.players.find((p) => p.id === id) || null;
    room.close = () => {
      if (closed) return;
      closed = true;
      clearInterval(pinger);
      conns.forEach((conn) => raw(conn, { t: "_bye" }));
      // give the goodbye a moment to leave before tearing the connection down
      setTimeout(() => peer.destroy(), 150);
      if (current === room) current = null;
    };

    current = room;
    return room;
  }

  /* ---------- Guest ---------- */

  class WrongGame extends Error {
    constructor(game, page) {
      super("That room is playing a different game");
      this.game = game;
      this.page = page;
    }
  }

  // opts: { game, name }. Rejects with WrongGame when the code belongs to another game's room.
  async function join(rawCode, opts) {
    const code = cleanCode(rawCode);
    if (!validCode(code)) throw new Error("A room code has " + CODE_LEN + " letters or digits");
    await loadPeer();
    let peer;
    try {
      peer = await openPeer(null);
    } catch (err) {
      throw new Error(errorText(err));
    }
    const conn = peer.connect(PREFIX + code, { reliable: true, serialization: "json" });

    return new Promise((resolve, reject) => {
      let room = null;
      let failed = false;
      let lastHeard = Date.now();
      let closed = false;
      let watchdog = null;

      const timer = setTimeout(() => fail(new Error("No room with that code")), JOIN_TIMEOUT);

      function fail(err) {
        if (room || failed) return;
        failed = true;
        clearTimeout(timer);
        reject(err);
        // destroying fires the connection's close handler, so settle first
        peer.destroy();
      }

      function raw(msg) {
        if (conn.open) {
          try {
            conn.send(msg);
          } catch (e) {
            // closing anyway
          }
        }
      }

      function end(reason) {
        if (closed) return;
        closed = true;
        clearInterval(watchdog);
        peer.destroy();
        if (current === room) current = null;
        room.emit("closed", reason);
      }

      peer.on("error", (err) => {
        if (!room) fail(new Error(errorText(err)));
        else if (err.type !== "network" && err.type !== "server-error") console.warn("PeerJS:", err.type);
      });
      peer.on("disconnected", () => {
        if (room && !closed && !peer.destroyed) peer.reconnect();
      });

      conn.on("open", () => raw({ t: "_join", d: { game: opts.game, name: cleanName(opts.name) } }));
      conn.on("close", () => {
        if (room) end("The host left the room");
        else fail(new Error("The room closed"));
      });
      conn.on("error", () => {
        if (room) end("Lost the connection to the host");
      });

      conn.on("data", (msg) => {
        if (!msg || typeof msg.t !== "string") return;
        lastHeard = Date.now();
        if (!room) {
          if (msg.t === "_wrong") fail(new WrongGame(msg.d.game, msg.d.page));
          else if (msg.t === "_full") fail(new Error("That room is full"));
          else if (msg.t === "_welcome") {
            clearTimeout(timer);
            room = makeRoom(msg.d);
            current = room;
            watchdog = setInterval(() => {
              if (Date.now() - lastHeard > SILENT_LIMIT) end("Lost the connection to the host");
            }, 1000);
            resolve(room);
          }
          return;
        }
        switch (msg.t) {
          case "_players":
            room.players = msg.d;
            room.me = room.player(room.myId);
            room.emit("players", room.players);
            break;
          case "_ping":
            raw({ t: "_pong" });
            msg.d.forEach((x) => {
              const p = room.player(x.id);
              if (p) p.ping = x.ping;
            });
            room.emit("ping", room.players);
            break;
          case "_bye":
            end("The host closed the room");
            break;
          default:
            room.emit(msg.t, msg.d, msg.f || room.hostId);
        }
      });

      function makeRoom(welcome) {
        const r = emitter({
          code,
          isHost: false,
          game: welcome.game,
          page: thisPage(),
          myId: welcome.id,
          hostId: PREFIX + code,
          players: welcome.players,
        });
        r.player = (id) => r.players.find((p) => p.id === id) || null;
        r.me = r.player(r.myId);
        r.send = (type, data) => raw({ t: type, d: data });
        r.share = (type, data) => raw({ t: type, d: data, s: 1 });
        r.to = (id, type, data) => {
          if (id === r.myId) r.emit(type, data, r.myId);
          else raw({ t: type, d: data });
        };
        r.close = () => {
          if (closed) return;
          raw({ t: "_bye" });
          closed = true;
          clearInterval(watchdog);
          setTimeout(() => peer.destroy(), 150);
          if (current === r) current = null;
        };
        return r;
      }
    });
  }

  // Leaving the page should look like leaving the room, not like a dropped connection.
  window.addEventListener("pagehide", () => {
    if (current) current.close();
  });

  window.NET = {
    COLORS,
    COLOR_NAMES,
    MAX_PLAYERS,
    CODE_LEN,
    host,
    join,
    cleanCode,
    validCode,
    WrongGame,
    color: (i) => COLORS[i % COLORS.length],
  };
})();
