// RevGym PC app: sign up / log in, leaderboard, link a phone by QR, live phone camera.
(() => {
  "use strict";

  const LIFTS = [
    ["all", "All lifts"],
    ["bench_press", "Bench Press"],
    ["squat", "Squat"],
    ["bicep_curl", "Bicep Curl"],
    ["shoulder_press", "Shoulder Press"],
    ["deadlift", "Deadlift"],
    ["lunge", "Lunge"],
  ];
  const LIFT_NAME = Object.fromEntries(LIFTS);
  const $ = (id) => document.getElementById(id);

  // ---------- token storage (localStorage can throw in private windows) ----------
  const store = {
    get() { try { return localStorage.getItem("revgym_token"); } catch { return null; } },
    set(v) { try { localStorage.setItem("revgym_token", v); } catch { /* keep in memory only */ } },
    clear() { try { localStorage.removeItem("revgym_token"); } catch { /* ignore */ } },
  };

  const state = {
    token: store.get(),
    user: null,
    mode: "login",
    exercise: "all",
    period: "week",
    timers: {},
    knownDeviceIds: new Set(),
    devices: [],
    pairing: false,
  };

  async function api(path, { method = "GET", body, auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && auth && state.token) {
      signOutLocally();
      throw new Error("Your session ended. Please log in again.");
    }
    if (!res.ok) {
      let msg = "Something went wrong. Please try again.";
      try {
        msg = window.RevGymSignup.errorText(await res.json(), msg);
      } catch { /* not JSON */ }
      throw new Error(msg);
    }
    return res.status === 204 || res.status === 202 ? null : res.json();
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function showError(node, message) {
    node.textContent = message;
    node.hidden = !message;
  }

  const asUtc = (iso) => new Date(iso.endsWith("Z") ? iso : iso + "Z");
  const fmtNum = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const fmtTime = (iso) => asUtc(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  function every(name, fn, ms) {
    clearInterval(state.timers[name]);
    state.timers[name] = setInterval(fn, ms);
  }
  function stop(name) {
    clearInterval(state.timers[name]);
    delete state.timers[name];
  }

  // ================= Log in / Sign up =================

  function setMode(mode) {
    state.mode = mode;
    const signup = mode === "signup";
    $("tab-login").setAttribute("aria-selected", String(!signup));
    $("tab-signup").setAttribute("aria-selected", String(signup));
    $("auth-title").textContent = signup ? "Create your account" : "Log in";
    $("auth-submit").textContent = signup ? "Create account" : "Log in";
    $("password").setAttribute("autocomplete", signup ? "new-password" : "current-password");
    $("password-hint").hidden = !signup;
    $("signup-fields").hidden = !signup;
    showError($("auth-error"), "");
  }

  function validate(username, password) {
    if (!/^[A-Za-z0-9_.]{2,32}$/.test(username)) {
      return ["username", "Usernames are 2–32 letters, numbers, dots or underscores."];
    }
    if (password.length < 8) return ["password", "Passwords need at least 8 characters."];
    return null;
  }

  async function onAuthSubmit(event) {
    event.preventDefault();
    const username = $("username").value.trim();
    const password = $("password").value;
    $("username").removeAttribute("aria-invalid");
    $("password").removeAttribute("aria-invalid");

    const problem = validate(username, password);
    if (problem) {
      $(problem[0]).setAttribute("aria-invalid", "true");
      $(problem[0]).focus();
      showError($("auth-error"), problem[1]);
      return;
    }
    let profile = {};
    if (state.mode === "signup") {
      const read = window.RevGymSignup.read();
      if (read.error) {
        $(read.field).focus();
        showError($("auth-error"), read.error);
        return;
      }
      profile = read.data;
    }

    const submit = $("auth-submit");
    submit.disabled = true;
    submit.textContent = state.mode === "signup" ? "Creating account…" : "Logging in…";
    try {
      const path = state.mode === "signup" ? "/auth/register" : "/auth/login";
      const data = await api(path, { method: "POST", body: { username, password, ...profile }, auth: false });
      state.token = data.token;
      store.set(data.token);
      state.user = data.user;
      $("password").value = "";
      showApp();
    } catch (err) {
      showError($("auth-error"), err.message);
    } finally {
      submit.disabled = false;
      submit.textContent = state.mode === "signup" ? "Create account" : "Log in";
    }
  }

  // ================= App shell =================

  function signOutLocally() {
    Object.keys(state.timers).forEach(stop);
    live.teardown();
    state.token = null;
    state.user = null;
    store.clear();
    $("app-view").hidden = true;
    $("auth-view").hidden = false;
    setMode("login");
  }

  async function logout() {
    try { await api("/auth/logout", { method: "POST" }); } catch { /* already logged out */ }
    signOutLocally();
  }

  function showApp() {
    $("auth-view").hidden = true;
    $("app-view").hidden = false;
    $("me-name").textContent = state.user.username;
    renderLiftTabs();
    loadBoard();
    loadDevices();
    every("devices", loadDevices, 2000);
    every("board", loadBoard, 30000);
  }

  // ================= Leaderboard =================

  function renderLiftTabs() {
    $("lift-tabs").replaceChildren(...LIFTS.map(([key, label]) => el("button", {
      type: "button", role: "tab", "aria-selected": String(key === state.exercise), text: label,
      onclick: () => { state.exercise = key; renderLiftTabs(); loadBoard(); },
    })));
  }

  function valueText(entry, metric) {
    return metric === "points" ? `${fmtNum(entry.value)} pts` : `${fmtNum(entry.weight_lb)} lb × ${entry.reps}`;
  }

  async function loadBoard() {
    showError($("board-error"), "");
    const params = new URLSearchParams({ exercise: state.exercise, period: state.period, limit: "25" });
    let data;
    try {
      data = await api(`/leaderboard?${params}`);
    } catch (err) {
      showError($("board-error"), err.message);
      return;
    }
    const pointsBoard = data.metric === "points";
    $("board-rule").textContent = pointsBoard
      ? "Points from every set with a form score of 80 or higher."
      : `Heaviest ${LIFT_NAME[data.exercise].toLowerCase()} set with a form score of 80 or higher.`;
    $("value-head").textContent = pointsBoard ? "Points" : "Best set";
    $("form-head").hidden = pointsBoard;

    const myId = state.user && state.user.id;
    $("board-body").replaceChildren(...data.entries.map((e) => {
      const cells = [
        el("td", {}, el("span", { class: e.rank <= 3 ? "rank top" : "rank", text: String(e.rank) })),
        el("td", { class: "lifter", text: e.username + (e.user_id === myId ? " (you)" : "") }),
        el("td", { class: "val", text: valueText(e, data.metric) }),
      ];
      if (!pointsBoard) cells.push(el("td", { text: fmtNum(e.form_score) }));
      return el("tr", { class: e.user_id === myId ? "is-me" : "" }, ...cells);
    }));
    $("board-empty").hidden = data.entries.length > 0;

    const me = data.me;
    $("me-card").hidden = false;
    if (me) {
      $("me-rank").textContent = `#${me.entry.rank}`;
      $("me-value").textContent = valueText(me.entry, data.metric);
      if (!me.next_up) $("me-note").textContent = "You're in first place. Gig 'em!";
      else if (pointsBoard) $("me-note").textContent = `${fmtNum(me.gap_to_next)} pts to tie #${me.next_up.rank}`;
      else if (me.gap_to_next > 0) $("me-note").textContent = `${fmtNum(me.gap_to_next)} lb to tie #${me.next_up.rank}`;
      else $("me-note").textContent = `A rep more or cleaner form passes #${me.next_up.rank}`;
    } else {
      $("me-rank").textContent = "—";
      $("me-value").textContent = "";
      $("me-note").textContent = "Record a set with form 80+ to get ranked.";
    }
  }

  // ================= Phone linking (QR) =================

  function deviceStatusText(d) {
    if (d.online && d.camera) return "Camera on, connected";
    if (d.online) return "Connected, camera off";
    return d.last_seen_at ? `Offline · last seen ${fmtTime(d.last_seen_at)}` : "Offline";
  }

  async function loadDevices() {
    let devices;
    try { devices = await api("/me/devices"); } catch { return; }
    const newlyLinked = devices.find((d) => !state.knownDeviceIds.has(d.id));
    state.knownDeviceIds = new Set(devices.map((d) => d.id));
    state.devices = devices;

    $("device-list").replaceChildren(...devices.map((d) => el("li", {},
      el("span", { class: "dev-text" },
        el("span", { class: "dev-name", text: d.name }),
        el("span", { class: "dev-sub" }, el("span", { class: d.online ? "status-dot on" : "status-dot", "aria-hidden": "true" }), deviceStatusText(d))),
      el("button", { type: "button", class: "secondary", text: "Unlink", "aria-label": `Unlink ${d.name}`,
        onclick: () => unlinkDevice(d) }),
    )));
    $("phone-status").textContent = devices.length
      ? "Linked. Open the RevGym camera on your phone to go live."
      : "Your phone is the camera. Link it with a QR code.";
    if (!state.pairing) $("pair-start").textContent = devices.length ? "Link another phone" : "Link a phone";

    if (state.pairing && newlyLinked) stopPairing(`${newlyLinked.name} is linked!`);
    live.sync(devices);
  }

  async function unlinkDevice(device) {
    if (!confirm(`Unlink ${device.name}? It will stop working as your camera until you link it again.`)) return;
    try {
      await api(`/me/devices/${device.id}`, { method: "DELETE" });
      loadDevices();
    } catch (err) {
      showError($("pair-error"), err.message);
    }
  }

  async function startPairing() {
    showError($("pair-error"), "");
    let data;
    try {
      data = await api("/devices/pair-code", { method: "POST" });
    } catch (err) {
      showError($("pair-error"), err.message);
      return;
    }
    state.pairing = true;
    $("pair-qr").src = data.qr_svg;
    $("pair-code").textContent = data.code;
    $("phone-url").textContent = data.phone_url.split("#")[0];
    $("pair-box").hidden = false;
    $("pair-start").textContent = "Get a new QR code";

    const expires = asUtc(data.expires_at);
    const tick = () => {
      const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
      $("pair-expiry").textContent = fmtClock(left);
      if (left === 0) {
        stopPairing();
        showError($("pair-error"), "That QR code expired. Click below for a new one.");
      }
    };
    tick();
    every("pairTick", tick, 1000);
  }

  function stopPairing(message) {
    stop("pairTick");
    state.pairing = false;
    $("pair-box").hidden = true;
    $("pair-qr").removeAttribute("src");
    $("pair-start").textContent = state.knownDeviceIds.size ? "Link another phone" : "Link a phone";
    if (message) $("phone-status").textContent = message;
  }

  // ================= Live camera (WebRTC, phone -> PC over Wi-Fi) =================

  const live = (() => {
    let pc = null;
    let deviceId = null;
    let connecting = false;

    function setStatus(text) { $("live-status").textContent = text; }

    function teardown() {
      if (pc) { pc.ontrack = pc.onconnectionstatechange = null; pc.close(); }
      pc = null;
      deviceId = null;
      connecting = false;
      $("live-video").srcObject = null;
      $("live-card").hidden = true;
    }

    function waitForIce(conn) {
      if (conn.iceGatheringState === "complete") return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => { conn.removeEventListener("icegatheringstatechange", check); resolve(); };
        const check = () => { if (conn.iceGatheringState === "complete") done(); };
        conn.addEventListener("icegatheringstatechange", check);
        setTimeout(done, 2500); // same-Wi-Fi addresses arrive almost instantly
      });
    }

    async function connect(device) {
      if (connecting) return;
      connecting = true;
      showError($("live-error"), "");
      $("live-retry").hidden = true;
      if (pc) pc.close();
      deviceId = device.id;
      setStatus(`Connecting to ${device.name}…`);
      try {
        // No STUN/TURN servers: the phone and PC are on the same network.
        const conn = new RTCPeerConnection({ iceServers: [] });
        pc = conn;
        conn.addTransceiver("video", { direction: "recvonly" });
        conn.ontrack = (e) => { $("live-video").srcObject = e.streams[0] || new MediaStream([e.track]); };
        conn.onconnectionstatechange = () => {
          if (conn !== pc) return;
          if (conn.connectionState === "connected") {
            setStatus(`Live from ${device.name}`);
          } else if (["failed", "disconnected"].includes(conn.connectionState)) {
            setStatus("Lost the live view.");
            $("live-retry").hidden = false;
          }
        };
        await conn.setLocalDescription(await conn.createOffer());
        await waitForIce(conn);
        const { offer_id } = await api(`/me/devices/${device.id}/live/offer`, { method: "POST", body: { sdp: conn.localDescription.sdp } });

        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && conn === pc) {
          const { sdp } = await api(`/me/devices/${device.id}/live/answer?offer_id=${offer_id}`);
          if (sdp) {
            await conn.setRemoteDescription({ type: "answer", sdp });
            return;
          }
          await new Promise((r) => setTimeout(r, 700));
        }
        if (conn === pc) throw new Error("Your phone didn't answer. Make sure the RevGym camera page is open on it.");
      } catch (err) {
        setStatus("Not connected.");
        showError($("live-error"), err.message);
        $("live-retry").hidden = false;
      } finally {
        connecting = false;
      }
    }

    // Called every time the device list refreshes.
    function sync(devices) {
      const phone = devices.find((d) => d.online && d.camera);
      if (!phone) {
        if (deviceId !== null) teardown();
        return;
      }
      $("live-card").hidden = false;
      if (deviceId !== phone.id || (!pc && !connecting)) connect(phone);
    }

    $("live-retry").addEventListener("click", () => {
      const phone = state.devices.find((d) => d.id === deviceId) || state.devices.find((d) => d.online && d.camera);
      if (phone) connect(phone);
    });
    return { sync, teardown };
  })();

  // ================= Start =================

  $("tab-login").addEventListener("click", () => setMode("login"));
  $("tab-signup").addEventListener("click", () => setMode("signup"));
  $("auth-form").addEventListener("submit", onAuthSubmit);
  $("toggle-password").addEventListener("click", (e) => {
    const input = $("password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    e.currentTarget.textContent = show ? "Hide" : "Show";
    e.currentTarget.setAttribute("aria-pressed", String(show));
  });
  $("logout").addEventListener("click", logout);
  $("pair-start").addEventListener("click", startPairing);
  document.querySelectorAll("[data-period]").forEach((btn) => btn.addEventListener("click", () => {
    state.period = btn.dataset.period;
    document.querySelectorAll("[data-period]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    loadBoard();
  }));

  window.RevGymSignup.init();
  (async () => {
    if (state.token) {
      try {
        state.user = await api("/auth/me");
        showApp();
        return;
      } catch { /* token expired: fall through to log in */ }
    }
    $("auth-view").hidden = false;
    setMode("login");
  })();
})();
