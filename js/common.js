// Shared helpers for every game: storage, dates, stats, sharing and dialogs.
(function () {
  "use strict";

  const EPOCH = Date.UTC(2026, 0, 1);
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
        // private mode or blocked storage: the game still works, it just forgets
      }
    },
  };

  function params() {
    return new URLSearchParams(location.search);
  }

  // Days since 1 January 2026 in local time — this picks the daily puzzle.
  function dayNumber(date = new Date()) {
    return Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - EPOCH) / 86400000);
  }

  function mod(n, m) {
    return ((n % m) + m) % m;
  }

  // Data files load as plain scripts, so the games also run straight from file://
  function loadFile(src, get, label) {
    const ready = get();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => {
        const data = get();
        data ? resolve(data) : reject(new Error("Broken " + label));
      };
      s.onerror = () => reject(new Error("Could not load " + s.src));
      document.head.appendChild(s);
    });
  }

  function loadData() {
    window.WORDGAME_DATA = window.WORDGAME_DATA || {};
    return loadFile("data/en.js", () => window.WORDGAME_DATA.en, "word list");
  }

  // Hand-written puzzles: connections, crossword grids, cryptogram quotes.
  function loadPacks() {
    window.WORDGAME_PACKS = window.WORDGAME_PACKS || {};
    return loadFile("data/packs.js", () => window.WORDGAME_PACKS.en, "puzzle pack");
  }

  // Deterministic random (mulberry32): the same seed always builds the same puzzle.
  function rng(seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedFrom() {
    const str = [...arguments].join("|");
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function shuffle(list, rand) {
    const a = [...list];
    const r = rand || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pick(list, rand) {
    return list[Math.floor((rand || Math.random)() * list.length)];
  }

  function splitWords(str) {
    return str ? str.split(" ") : [];
  }

  function normalizeLetter(ch) {
    return ch.normalize("NFC").toLowerCase();
  }

  // Shared stats; in daily mode it also keeps a streak.
  const stats = {
    load(key) {
      const s = store.get("stats:" + key, null);
      return s && typeof s === "object"
        ? s
        : { played: 0, wins: 0, streak: 0, maxStreak: 0, lastDay: null, lastWinDay: null };
    },
    // opts: { won, daily, day } — a daily puzzle only counts once per day
    record(key, opts) {
      const s = stats.load(key);
      const day = opts.day === undefined ? dayNumber() : opts.day;
      if (opts.daily) {
        if (s.lastDay === day) return s;
        s.lastDay = day;
      }
      s.played++;
      if (opts.won) {
        s.wins++;
        if (opts.daily) {
          s.streak = s.lastWinDay === day - 1 ? s.streak + 1 : 1;
          s.lastWinDay = day;
        } else {
          s.streak++;
        }
        s.maxStreak = Math.max(s.maxStreak, s.streak);
      } else {
        s.streak = 0;
      }
      store.set("stats:" + key, s);
      return s;
    },
    // A broken daily streak only shows as zero, the stored value stays put.
    current(s, daily, day) {
      const d = day === undefined ? dayNumber() : day;
      if (!daily) return s.streak;
      return s.lastWinDay !== null && s.lastWinDay >= d - 1 ? s.streak : 0;
    },
  };

  function toast(message, duration = 1600) {
    let box = document.getElementById("toasts");
    if (!box) {
      box = document.createElement("div");
      box.id = "toasts";
      box.setAttribute("aria-live", "polite");
      document.body.appendChild(box);
    }
    // Dialogs live in the top layer; reopening the popover keeps messages above them.
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

  // On a phone this opens the system share sheet, on a desktop it copies.
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
    toast(ok ? "Copied — send it to a friend!" : "Could not copy", 2400);
  }

  function pageUrl(page, query) {
    const url = new URL(page, location.href);
    url.search = new URLSearchParams(query || {}).toString();
    url.hash = "";
    return url.href;
  }

  // Light obfuscation so a challenge link does not give the word away at a glance.
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

  window.WG = {
    store,
    stats,
    params,
    dayNumber,
    mod,
    loadData,
    loadPacks,
    rng,
    seedFrom,
    shuffle,
    pick,
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
  };
})();
