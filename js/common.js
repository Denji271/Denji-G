// Közös segédfüggvények mindkét játékhoz (nyelv, dátum, mentés, megosztás, ablakok).
(function () {
  "use strict";

  const EPOCH = Date.UTC(2026, 0, 1);
  const LANGS = ["hu", "en"];
  // Hibás kódolású magyar billentyűzetek õ/û-t küldenek ő/ű helyett.
  const LETTER_FIX = { "õ": "ő", "ô": "ő", "û": "ű", "ũ": "ű" };
  const CODE_KEY = [83, 122, 243, 106, 225, 116, 233, 107];

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem("wg:" + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem("wg:" + key, JSON.stringify(value));
      } catch (e) {
        // privát mód / letiltott tárhely: a játék mentés nélkül is működik
      }
    },
  };

  function params() {
    return new URLSearchParams(location.search);
  }

  function getLang() {
    const fromUrl = params().get("lang");
    if (LANGS.includes(fromUrl)) {
      store.set("lang", fromUrl);
      return fromUrl;
    }
    const saved = store.get("lang", null);
    return LANGS.includes(saved) ? saved : "hu";
  }

  // Hányadik nap 2026. január 1. óta (helyi idő szerint) — ettől függ a napi feladvány.
  function dayNumber(date = new Date()) {
    return Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - EPOCH) / 86400000);
  }

  function mod(n, m) {
    return ((n % m) + m) % m;
  }

  function msToMidnight() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
  }

  function formatCountdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const pad = (n) => String(n).padStart(2, "0");
    return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60);
  }

  // A szólisták <script>-ként töltődnek be, így a játék file:// alól is fut.
  function loadData(lang) {
    window.WORDGAME_DATA = window.WORDGAME_DATA || {};
    if (window.WORDGAME_DATA[lang]) return Promise.resolve(window.WORDGAME_DATA[lang]);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "data/" + lang + ".js";
      s.onload = () => (window.WORDGAME_DATA[lang] ? resolve(window.WORDGAME_DATA[lang]) : reject(new Error("Hibás szólista")));
      s.onerror = () => reject(new Error("Nem sikerült betölteni a szólistát: " + s.src));
      document.head.appendChild(s);
    });
  }

  function splitWords(str) {
    return str ? str.split(" ") : [];
  }

  function normalizeLetter(ch) {
    const c = ch.normalize("NFC").toLowerCase();
    return LETTER_FIX[c] || c;
  }

  function toast(message, duration = 1600) {
    let box = document.getElementById("toasts");
    if (!box) {
      box = document.createElement("div");
      box.id = "toasts";
      box.setAttribute("aria-live", "polite");
      document.body.appendChild(box);
    }
    // A felugró ablakok a "top layer"-ben vannak; popoverként újranyitva az üzenet föléjük kerül.
    if (box.showPopover) {
      if (box.popover !== "manual") box.popover = "manual";
      if (box.matches(":popover-open")) box.hidePopover();
      box.showPopover();
    }
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    box.prepend(el);
    [...box.children].slice(3).forEach((old) => old.remove());
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e2) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  // Telefonon a rendszer megosztás menüjét nyitja, gépen vágólapra másol.
  async function share(text) {
    if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    const ok = await copyText(text);
    toast(ok ? "Vágólapra másolva — küldd el a barátaidnak!" : "Nem sikerült másolni", 2400);
  }

  function pageUrl(page, query) {
    const url = new URL(page, location.href);
    url.search = new URLSearchParams(query).toString();
    url.hash = "";
    return url.href;
  }

  // Egyszerű elrejtés, hogy a kihívás linkjéből ne lehessen ránézésre kiolvasni a szót.
  function encodeWord(word) {
    let bin = "";
    new TextEncoder().encode(word).forEach((b, i) => {
      bin += String.fromCharCode(b ^ CODE_KEY[i % CODE_KEY.length]);
    });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeWord(code) {
    try {
      const bin = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = Uint8Array.from(bin, (c, i) => c.charCodeAt(0) ^ CODE_KEY[i % CODE_KEY.length]);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  function openDialog(id) {
    const dlg = document.getElementById(id);
    if (dlg && !dlg.open) dlg.showModal();
  }

  function anyDialogOpen() {
    return !!document.querySelector("dialog[open]");
  }

  function setupDialogs() {
    document.querySelectorAll("dialog").forEach((dlg) => {
      dlg.addEventListener("click", (e) => {
        if (e.target !== dlg) return;
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
      });
    });
    document.querySelectorAll("[data-close]").forEach((b) => {
      b.addEventListener("click", () => b.closest("dialog").close());
    });
    document.querySelectorAll("[data-open]").forEach((b) => {
      b.addEventListener("click", () => openDialog(b.dataset.open));
    });
  }

  function setupLangSwitch(current) {
    document.querySelectorAll(".lang-switch").forEach((box) => {
      box.innerHTML = "";
      LANGS.forEach((l) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = l.toUpperCase();
        b.title = l === "hu" ? "Magyar szavak" : "Angol szavak";
        b.setAttribute("aria-pressed", String(l === current));
        b.addEventListener("click", () => {
          if (l === current) return;
          store.set("lang", l);
          location.href = pageUrl(location.pathname.split("/").pop() || "index.html", { lang: l });
        });
        box.appendChild(b);
      });
    });
  }

  window.WG = {
    store,
    params,
    getLang,
    dayNumber,
    mod,
    msToMidnight,
    formatCountdown,
    loadData,
    splitWords,
    normalizeLetter,
    toast,
    copyText,
    share,
    pageUrl,
    encodeWord,
    decodeWord,
    openDialog,
    anyDialogOpen,
    setupDialogs,
    setupLangSwitch,
  };
})();
