// Shared pieces for the 3D games: loads Three.js, sets up the renderer, lights and camera,
// and makes the little characters and name tags every 3D game uses.
(function () {
  "use strict";

  // r158 is among the last releases with a plain-script build, which also runs from file://
  const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.158.0/build/three.min.js";
  const ASPECT = 16 / 10;

  function webglOk() {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch (e) {
      return false;
    }
  }

  function load() {
    if (!webglOk()) return Promise.reject(new Error("This browser cannot show 3D graphics (WebGL is off)"));
    return WG.loadScript(THREE_URL, () => window.THREE, "3D library").catch(() => {
      throw new Error("Could not load the 3D library — check your internet connection");
    });
  }

  // A message in place of the game, e.g. when the 3D library could not load.
  function fail(canvas, text) {
    const box = canvas.parentElement;
    const p = document.createElement("p");
    p.className = "k3-fail";
    p.textContent = text;
    canvas.hidden = true;
    box.appendChild(p);
  }

  // o: { fov, sky: { light, dark }, fog: [near, far], shadowBox, far }
  function stage(canvas, opts) {
    const o = Object.assign({ fov: 50, sky: { light: 0xbfe3ff, dark: 0x1b2233 }, fog: null, shadowBox: 16, far: 400 }, opts);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(o.fov, ASPECT, 0.1, o.far);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x556070, 1.6);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(12, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const b = o.shadowBox;
    Object.assign(sun.shadow.camera, { left: -b, right: b, top: b, bottom: -b, near: 1, far: 90 });
    sun.shadow.bias = -0.0005;
    scene.add(hemi, sun, sun.target);

    // keep 16:10 and as large as the box allows, like ARC.view does for the 2D games
    const box = canvas.parentElement;
    function fit() {
      const h = Math.max(1, Math.floor(Math.min(box.clientHeight, box.clientWidth / ASPECT)));
      const w = Math.max(1, Math.floor(h * ASPECT));
      renderer.setSize(w, h, true);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(fit).observe(box);
    fit();

    function theme() {
      const sky = new THREE.Color(ARC.colors.dark ? o.sky.dark : o.sky.light);
      scene.background = sky;
      if (o.fog) scene.fog = new THREE.Fog(sky, o.fog[0], o.fog[1]);
      hemi.intensity = ARC.colors.dark ? 1.1 : 1.6;
    }
    theme();
    // arcade.js reads the new colours first (its listener was added earlier)
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);

    return {
      renderer,
      scene,
      camera,
      sun,
      render: () => renderer.render(scene, camera),
    };
  }

  /* ---------- Characters ---------- */

  let parts = null;
  function sharedParts() {
    if (parts) return parts;
    parts = {
      body: new THREE.CapsuleGeometry(0.42, 0.55, 6, 14),
      eye: new THREE.SphereGeometry(0.11, 12, 10),
      pupil: new THREE.SphereGeometry(0.055, 10, 8),
      white: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }),
      black: new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.4 }),
    };
    return parts;
  }

  // A little bean in a player colour, feet at y = 0, looking along +z.
  function character(colorIndex) {
    const p = sharedParts();
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(NET.color(colorIndex)), roughness: 0.55 });
    const body = new THREE.Mesh(p.body, mat);
    body.position.y = 0.42 + 0.275;
    body.castShadow = true;
    g.add(body);
    [-0.16, 0.16].forEach((x) => {
      const eye = new THREE.Mesh(p.eye, p.white);
      eye.position.set(x, 1.0, 0.34);
      const pupil = new THREE.Mesh(p.pupil, p.black);
      pupil.position.z = 0.075;
      eye.add(pupil);
      g.add(eye);
    });
    g.userData.mat = mat;
    return g;
  }

  // A name tag that always faces the camera.
  function label(text, color) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const g = c.getContext("2d");
    g.font = "700 30px system-ui, sans-serif";
    const w = Math.min(248, g.measureText(text).width + 30);
    g.fillStyle = "rgba(0, 0, 0, 0.5)";
    if (g.roundRect) {
      g.beginPath();
      g.roundRect((256 - w) / 2, 10, w, 44, 22);
      g.fill();
    } else {
      g.fillRect((256 - w) / 2, 10, w, 44);
    }
    g.fillStyle = color || "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.scale.set(2.4, 0.6, 1);
    sprite.renderOrder = 10;
    return sprite;
  }

  // Frees what a removed object used on the graphics card (shared character parts stay).
  function dispose(obj) {
    const keep = parts ? new Set(Object.values(parts)) : new Set();
    obj.traverse((o) => {
      if (o.geometry && !keep.has(o.geometry)) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach((m) => {
        if (keep.has(m)) return;
        if (m.map) m.map.dispose();
        m.dispose();
      });
    });
  }

  /* ---------- Camera and mouse ---------- */

  let tmp = null;
  // Glides the camera to target + offset and looks at the target, the same at any frame rate.
  function follow(camera, target, offset, dt, speed) {
    tmp = tmp || new THREE.Vector3();
    const k = 1 - Math.exp(-(speed || 6) * dt);
    tmp.copy(target).add(offset);
    camera.position.lerp(tmp, k);
    camera.lookAt(target.x, target.y + 0.6, target.z);
  }

  // A camera you turn with the mouse: drag (any button) to go round and tilt, wheel to zoom,
  // Q / E to turn with the keyboard. A short click without dragging is still a click (o.onClick).
  // o: { yaw, pitch, dist, minPitch, maxPitch, minDist, maxDist, onClick }
  function orbit(canvas, o) {
    const s = {
      yaw: o.yaw || 0,
      pitch: o.pitch,
      dist: o.dist,
      dragging: false,
    };
    let down = null;
    canvas.addEventListener("pointerdown", (e) => {
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, button: e.button, moved: false };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {
        // the pointer is gone already
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!down || e.pointerId !== down.id) return;
      if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
      if (down.moved) {
        // drag right and the world turns right with your hand
        s.yaw -= (e.clientX - down.lx) * 0.008;
        s.pitch = ARC.clamp(s.pitch + (e.clientY - down.ly) * 0.006, o.minPitch, o.maxPitch);
        s.dragging = true;
      }
      down.lx = e.clientX;
      down.ly = e.clientY;
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!down || e.pointerId !== down.id) return;
      const click = !down.moved && down.button === 0;
      down = null;
      s.dragging = false;
      if (click && o.onClick) o.onClick(e);
    });
    canvas.addEventListener("pointercancel", () => {
      down = null;
      s.dragging = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        s.dist = ARC.clamp(s.dist * Math.exp(e.deltaY * 0.0012), o.minDist, o.maxDist);
      },
      { passive: false }
    );

    // Q / E, once a frame
    s.turn = (dt) => {
      s.yaw += ((ARC.input.held("camLeft") ? 1 : 0) - (ARC.input.held("camRight") ? 1 : 0)) * 2.2 * dt;
    };
    // Where the camera sits relative to what it looks at (a game may ask for another distance or tilt).
    s.offset = (v, dist, pitch) => {
      const d = dist || s.dist;
      const p = pitch === undefined ? s.pitch : pitch;
      return v.set(Math.sin(s.yaw) * Math.cos(p) * d, Math.sin(p) * d, Math.cos(s.yaw) * Math.cos(p) * d);
    };
    // Turns "forward / sideways" from the keys into a direction on the ground, as the camera sees it.
    s.move = (forward, side) => ({
      x: side * Math.cos(s.yaw) - forward * Math.sin(s.yaw),
      z: -side * Math.sin(s.yaw) - forward * Math.cos(s.yaw),
    });
    return s;
  }

  // The arrow keys / WASD as a direction on the ground, as the camera sees it: { x, z, len } with len 0 or 1.
  function walkDir(orbit) {
    const forward = (ARC.input.held("up") ? 1 : 0) - (ARC.input.held("down") ? 1 : 0);
    const side = (ARC.input.held("right") ? 1 : 0) - (ARC.input.held("left") ? 1 : 0);
    const d = orbit.move(forward, side);
    const len = Math.hypot(d.x, d.z);
    return len ? { x: d.x / len, z: d.z / len, len: 1 } : { x: 0, z: 0, len: 0 };
  }

  // "3", "2", "1", "Go!" in the middle of the stage. tick() is true once, the moment it reaches Go.
  function countdown() {
    let end = 0;
    let last = -1;
    let running = false;
    return {
      start(ms) {
        end = performance.now() + ms;
        last = -1;
        running = ms > 0;
      },
      stop() {
        running = false;
      },
      get running() {
        return running;
      },
      tick(now) {
        if (!running) return false;
        const left = Math.ceil((end - now) / 1000);
        if (left <= 0) {
          running = false;
          ARC.banner("Go!", 700);
          return true;
        }
        if (left !== last) {
          last = left;
          ARC.banner(String(left));
        }
        return false;
      },
    };
  }

  // The other players: a character and name tag each, glided between their network updates.
  // o: { make(p) -> Object3D (default: a character), tagY, delay }
  // Updates are pushed as { x, y, z, h } (y is optional) plus the sender's timestamp.
  function crowd(scene, o) {
    const opts = Object.assign({ tagY: 2.1, delay: 100 }, o);
    const all = new Map(); // id -> { p, obj, tag, buf, data }

    function add(p) {
      remove(p.id);
      const obj = opts.make ? opts.make(p) : character(p.color);
      const e = { p, obj, tag: null, buf: ARC.snapshots(opts.delay), data: {} };
      setTag(e, p.name);
      scene.add(obj);
      all.set(p.id, e);
      return e;
    }

    function setTag(e, text) {
      if (e.tag) {
        e.obj.remove(e.tag);
        dispose(e.tag);
        e.tag = null;
      }
      if (!text) return;
      e.tag = label(text);
      e.tag.position.y = opts.tagY;
      e.obj.add(e.tag);
    }

    function remove(id) {
      const e = all.get(id);
      if (!e) return;
      scene.remove(e.obj);
      dispose(e.obj);
      all.delete(id);
    }

    return {
      add,
      remove,
      get: (id) => all.get(id) || null,
      has: (id) => all.has(id),
      each: (fn) => all.forEach(fn),
      get size() {
        return all.size;
      },
      clear() {
        [...all.keys()].forEach(remove);
      },
      // drops everybody no longer in the room
      keep(isHere) {
        [...all.keys()].forEach((id) => isHere(id) || remove(id));
      },
      tag(id, text) {
        const e = all.get(id);
        if (e) setTag(e, text);
      },
      push(id, state, ts) {
        const e = all.get(id);
        if (e) e.buf.push(state, ts);
        return e;
      },
      // Moves everybody to where they were a moment ago, blended between updates.
      update() {
        all.forEach((e) => {
          const s = e.buf.sample();
          if (!s) return;
          const a = s.a;
          const b = s.b;
          e.obj.position.set(
            ARC.lerp(a.x, b.x, s.t),
            a.y === undefined ? e.obj.position.y : ARC.lerp(a.y, b.y, s.t),
            ARC.lerp(a.z, b.z, s.t)
          );
          if (b.h !== undefined) e.obj.rotation.y = ARC.lerpAngle(a.h, b.h, s.t);
          e.last = b;
        });
      },
    };
  }

  let ray = null;
  // Where the mouse points on the flat plane at height y (or null when it points at the sky).
  function pointOnPlane(e, canvas, camera, y) {
    if (!ray) ray = { caster: new THREE.Raycaster(), ndc: new THREE.Vector2(), plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0) };
    const r = canvas.getBoundingClientRect();
    ray.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.caster.setFromCamera(ray.ndc, camera);
    ray.plane.constant = -(y || 0);
    return ray.caster.ray.intersectPlane(ray.plane, new THREE.Vector3());
  }

  window.K3 = { load, fail, stage, character, label, dispose, follow, orbit, walkDir, countdown, crowd, pointOnPlane };
})();
