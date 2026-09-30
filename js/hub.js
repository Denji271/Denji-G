// Home page: lays out the cards and drives the little "i" info bubble on each card.
(function () {
  "use strict";

  let pinned = null;

  function buildCard(game) {
    const wrap = document.createElement("div");
    wrap.className = "card-wrap";

    const link = document.createElement("a");
    link.className = "card";
    link.href = game.url;
    link.innerHTML = game.icon + "<h2>" + game.name + "</h2>";

    const info = document.createElement("button");
    info.type = "button";
    info.className = "info-btn";
    info.textContent = "i";
    info.setAttribute("aria-label", game.name + " — what is this game?");
    info.setAttribute("aria-expanded", "false");

    const pop = document.createElement("div");
    pop.className = "info-pop";
    pop.id = "info-" + game.id;
    pop.setAttribute("role", "tooltip");
    pop.textContent = game.info;
    info.setAttribute("aria-describedby", pop.id);

    const open = () => {
      document.querySelectorAll(".card-wrap.info-open").forEach((w) => {
        if (w !== wrap) close(w);
      });
      wrap.classList.add("info-open");
      info.setAttribute("aria-expanded", "true");
    };
    const shut = () => {
      if (pinned === wrap) return;
      close(wrap);
    };

    info.addEventListener("pointerenter", open);
    info.addEventListener("focus", open);
    info.addEventListener("pointerleave", shut);
    info.addEventListener("blur", shut);
    pop.addEventListener("pointerenter", open);
    pop.addEventListener("pointerleave", shut);
    // Touch has no hover, so a tap pins the bubble open until the next tap.
    info.addEventListener("click", (e) => {
      e.preventDefault();
      if (pinned === wrap) {
        pinned = null;
        close(wrap);
      } else {
        pinned = wrap;
        open();
      }
    });

    wrap.append(link, info, pop);
    return wrap;
  }

  function close(wrap) {
    wrap.classList.remove("info-open");
    const btn = wrap.querySelector(".info-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (pinned === wrap) pinned = null;
  }

  function render(id, games) {
    const box = document.getElementById(id);
    games.forEach((game) => box.appendChild(buildCard(game)));
  }

  render("multiCards", GAMES.multi);
  render("threeCards", GAMES.three);
  render("wordCards", GAMES.word);
  render("puzzleCards", GAMES.puzzle);

  // A room code alone is enough: the host's room tells us which game to open.
  const joinForm = document.getElementById("joinForm");
  const joinCode = document.getElementById("joinCode");
  const joinError = document.getElementById("joinError");
  joinCode.addEventListener("input", () => {
    joinCode.value = NET.cleanCode(joinCode.value);
  });
  joinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = NET.cleanCode(joinCode.value);
    if (!NET.validCode(code)) {
      joinError.textContent = "Type the " + NET.CODE_LEN + "-character room code";
      return;
    }
    const btn = document.getElementById("joinBtn");
    btn.disabled = true;
    joinError.textContent = "Looking for room " + code + "…";
    try {
      // "hub" matches no game, so the host answers with the page to open
      await NET.join(code, { game: "hub", name: WG.store.get("mp:name", "") });
      joinError.textContent = "";
    } catch (err) {
      if (err instanceof NET.WrongGame) {
        location.href = WG.pageUrl(err.page, { join: code });
        return;
      }
      joinError.textContent = err.message;
    }
    btn.disabled = false;
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".card-wrap")) {
      pinned = null;
      document.querySelectorAll(".card-wrap.info-open").forEach(close);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    pinned = null;
    document.querySelectorAll(".card-wrap.info-open").forEach(close);
  });
})();
