// Shared pieces for the real-time games: game loop, keyboard, canvas sizing, theme colours.
(function () {
  "use strict";

  const STEP = 1000 / 60;

  /* ---------- Keyboard ---------- */

  const BIND = {
    left: ["ArrowLeft", "KeyA"],
    right: ["ArrowRight", "KeyD"],
    up: ["ArrowUp", "KeyW"],
    down: ["ArrowDown", "KeyS"],
    jump: ["ArrowUp", "KeyW", "Space"],
    action: ["Space", "KeyJ", "KeyX"],
    attack: ["KeyJ", "KeyX", "KeyK"],
  };
  const NO_SCROLL = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"]);

  const held = new Set();
  const hits = new Set(); // pressed since the game last asked

  function typing(e) {
    const t = e.target;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  }

  window.addEventListener("keydown", (e) => {
    if (!input.enabled || typing(e) || WG.anyDialogOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (NO_SCROLL.has(e.code)) e.preventDefault();
    if (!held.has(e.code)) hits.add(e.code);
    held.add(e.code);
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));
  window.addEventListener("blur", () => held.clear());

  const input = {
    enabled: true,
    held(name) {
      return BIND[name].some((code) => held.has(code));
    },
    // true during the one game step after a fresh press (the loop clears presses after each step)
    hit(name) {
      return BIND[name].some((code) => hits.has(code));
    },
    endStep() {
      hits.clear();
    },
    reset() {
      held.clear();
      hits.clear();
    },
  };

  /* ---------- Loop ---------- */

  // A hidden tab gets no animation frames. A tiny worker keeps the updates ticking
  // anyway — otherwise a host who switches windows would freeze the game for everybody.
  const ticker = (function () {
    const fns = new Set();
    let started = false;
    const fire = () => fns.forEach((fn) => fn());
    function ensure() {
      if (started) return;
      started = true;
      try {
        const src = "setInterval(function () { postMessage(0); }, 16);";
        const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        worker.onmessage = fire;
      } catch (e) {
        setInterval(fire, 16);
      }
    }
    return {
      add(fn) {
        ensure();
        fns.add(fn);
      },
      remove(fn) {
        fns.delete(fn);
      },
    };
  })();

  // update(dt) runs exactly 60 times a second (dt in seconds). draw(alpha) runs once per screen
  // frame; alpha (0–1) is how far time has got between the last step and the next one, so games
  // can draw moving things in between — that keeps 120 and 144 Hz screens smooth as well.
  function loop(update, draw) {
    let last = 0;
    let lastFrame = 0;
    let acc = 0;
    let running = false;
    let raf = 0;

    function advance(now) {
      let delta = now - last;
      if (delta <= 0) return;
      last = now;
      if (delta > 250) delta = 250;
      // A 60 Hz screen reports anything from 16.2 to 17.1 ms per frame. Taking that as exactly one
      // step stops the game from doing no step in one frame and two in the next, which judders.
      if (Math.abs(delta - STEP) < 1.5) delta = STEP;
      acc += delta;
      while (acc >= STEP) {
        update(STEP / 1000);
        input.endStep();
        acc -= STEP;
      }
    }
    function frame(now) {
      if (!running) return;
      lastFrame = performance.now();
      advance(now);
      draw(Math.min(1, acc / STEP));
      raf = requestAnimationFrame(frame);
    }
    // Frames can stop without the tab counting as hidden (minimised or covered window),
    // so the worker steps in whenever frames have gone quiet.
    function background() {
      const now = performance.now();
      if (running && now - lastFrame > 60) advance(now);
    }

    return {
      start() {
        if (running) return;
        running = true;
        last = performance.now();
        acc = 0;
        raf = requestAnimationFrame(frame);
        ticker.add(background);
      },
      stop() {
        running = false;
        cancelAnimationFrame(raf);
        ticker.remove(background);
      },
      get running() {
        return running;
      },
    };
  }

  // Calls fn every `ms` milliseconds from inside an update — keeps network sends
  // on the game clock instead of a timer that stalls in a background tab.
  function every(ms) {
    let acc = 0;
    return (dt) => {
      acc += dt * 1000;
      if (acc < ms) return false;
      acc %= ms;
      return true;
    };
  }

  /* ---------- Canvas ---------- */

  // Keeps a canvas sharp and as large as its box allows, while the game
  // draws in its own fixed coordinates (w × h).
  function view(canvas, w, h) {
    const ctx = canvas.getContext("2d");
    const box = canvas.parentElement;
    const v = { canvas, ctx, w, h, scale: 1 };
    function fit() {
      const s = Math.max(0.05, Math.min(box.clientWidth / v.w, box.clientHeight / v.h));
      const cssW = Math.max(1, Math.floor(v.w * s));
      const cssH = Math.max(1, Math.floor(v.h * s));
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      v.scale = canvas.width / v.w;
    }
    v.resize = (nw, nh) => {
      v.w = nw;
      v.h = nh;
      fit();
    };
    v.begin = () => {
      ctx.setTransform(v.scale, 0, 0, v.scale, 0, 0);
      return ctx;
    };
    // Mouse position in game coordinates
    v.point = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * v.w, y: ((e.clientY - r.top) / r.height) * v.h };
    };
    new ResizeObserver(fit).observe(box);
    fit();
    return v;
  }

  /* ---------- Theme ---------- */

  const colors = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const get = (name) => cs.getPropertyValue(name).trim();
    Object.assign(colors, {
      bg: get("--bg"),
      surface: get("--surface"),
      text: get("--text"),
      muted: get("--muted"),
      border: get("--border"),
      strong: get("--border-strong"),
      accent: get("--accent"),
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
    });
  }
  readTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readTheme);

  /* ---------- Interpolation ---------- */

  // Keeps the last few updates from another player and blends between them slightly in the past,
  // so everything glides instead of jumping on every network update.
  // Updates carry the time they were sent (sender's clock). Packets arrive in uneven bursts, so
  // timing the blend by arrival would jerk; timing it by when they were sent stays smooth.
  function snapshots(delay) {
    const lag = delay === undefined ? 70 : delay;
    const list = []; // { t, state }, t on the sender's clock
    let offset = null; // our clock minus theirs, for the fastest packet seen lately
    let drained = -Infinity;

    function target() {
      return performance.now() - (offset || 0) - lag;
    }

    return {
      push(state, sentAt) {
        const now = performance.now();
        const t = typeof sentAt === "number" ? sentAt : now;
        const gap = now - t;
        // the lowest delay seen is the best guess of the clock difference; creep up slowly
        // in case a lucky packet made it look too low
        offset = offset === null ? gap : Math.min(offset + 0.02, gap);
        if (list.length && t <= list[list.length - 1].t) return;
        list.push({ t, state });
        if (list.length > 90) list.shift();
      },
      clear() {
        list.length = 0;
        drained = -Infinity;
      },
      latest() {
        return list.length ? list[list.length - 1].state : null;
      },
      // { a, b, t }: blend a → b by t
      sample() {
        if (!list.length) return null;
        const at = target();
        for (let i = list.length - 1; i > 0; i--) {
          if (list[i - 1].t <= at) {
            const a = list[i - 1];
            const b = list[i];
            return { a: a.state, b: b.state, t: Math.min(1, (at - a.t) / Math.max(1, b.t - a.t)) };
          }
        }
        return { a: list[0].state, b: list[0].state, t: 0 };
      },
      // Hands over, in order and only once, every update whose moment has come.
      drain(fn) {
        const at = target();
        for (const s of list) {
          if (s.t > at) break;
          if (s.t > drained) {
            drained = s.t;
            fn(s.state);
          }
        }
      },
    };
  }

  /* ---------- Small helpers ---------- */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return a + d * t;
  }

  // Big text in the middle of the stage: "3", "2", "1", "Round over"…
  let bannerTimer = 0;
  function banner(text, ms) {
    let el = document.getElementById("banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "banner";
      el.className = "banner";
      (document.querySelector(".stage") || document.body).appendChild(el);
    }
    clearTimeout(bannerTimer);
    el.textContent = text;
    el.hidden = !text;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
    if (text && ms) bannerTimer = setTimeout(() => (el.hidden = true), ms);
  }

  // rows: [{ id, name, color, value, out, me }]
  function scoreboard(el, rows) {
    el.innerHTML = "";
    rows.forEach((r) => {
      const chip = document.createElement("div");
      chip.className = "chip" + (r.out ? " out" : "") + (r.me ? " me" : "");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const val = document.createElement("b");
      val.textContent = r.value === undefined ? "" : r.value;
      // color -1 is an info chip (target, timer…) rather than a player
      if (r.color >= 0) {
        chip.style.setProperty("--pc", NET.color(r.color));
        const dot = document.createElement("span");
        dot.className = "dot";
        chip.appendChild(dot);
      } else {
        chip.classList.add("info");
      }
      chip.append(name, val);
      el.appendChild(chip);
    });
  }

  window.ARC = {
    input,
    loop,
    every,
    view,
    colors,
    snapshots,
    clamp,
    lerp,
    lerpAngle,
    banner,
    scoreboard,
  };
})();
