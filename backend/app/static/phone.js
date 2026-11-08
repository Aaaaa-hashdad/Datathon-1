// RevGym phone camera: links by QR code, opens the camera, and streams it live to
// the PC over Wi-Fi (WebRTC). Nothing is recorded or stored.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const KEY = "revgym_device_token";
  const store = {
    get() { try { return localStorage.getItem(KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch { /* memory only */ } },
    clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
  };

  let token = store.get();
  let stream = null;   // camera
  let peer = null;     // live link to the PC
  let pollTimer = null;
  let wakeLock = null;

  const setMsg = (node, text) => { node.textContent = text; node.hidden = !text; };
  function show(view) {
    $("pair-view").hidden = view !== "pair";
    $("camera-view").hidden = view !== "camera";
  }
  async function detail(res, fallback) {
    try { const d = await res.json(); return typeof d.detail === "string" ? d.detail : fallback; }
    catch { return fallback; }
  }
  const deviceHeaders = (extra = {}) => ({ "X-Device-Token": token, ...extra });

  // ================= Linking =================

  function defaultDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android phone";
    return "Phone";
  }

  async function pairWith(code) {
    setMsg($("pair-error"), "");
    setMsg($("pair-status"), "Linking to your PC…");
    try {
      const res = await fetch("/devices/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, device_name: defaultDeviceName() }),
      });
      if (!res.ok) throw new Error(await detail(res, "Couldn't link. Get a new QR code on your PC."));
      const data = await res.json();
      token = data.device_token;
      store.set(token);
      enterCamera(data.username);
    } catch (err) {
      setMsg($("pair-status"), "");
      setMsg($("pair-error"), err.message);
      show("pair");
    }
  }

  $("code").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  $("pair-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("code").value.trim();
    if (code.length !== 6) { setMsg($("pair-error"), "The code has 6 letters and numbers."); return; }
    pairWith(code);
  });

  // ================= Camera =================

  async function enterCamera(username) {
    $("linked-line").textContent = `Linked to ${username}'s PC`;
    show("camera");
    await startCamera();
    startPolling();
  }

  async function startCamera() {
    setMsg($("camera-error"), "");
    $("camera-start").hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMsg($("camera-error"), "The live camera needs the secure (https) address from the QR code. Scan the QR code on your PC again.");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      $("preview").srcObject = stream;
      keepScreenOn();
      if (peer) {  // a live link already exists: send it the new camera
        const track = stream.getVideoTracks()[0];
        peer.getSenders().forEach((s) => s.track && s.track.kind === "video" && s.replaceTrack(track));
      }
    } catch (err) {
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      setMsg($("camera-error"), denied
        ? "RevGym needs camera access. Allow it in your browser settings, then tap Turn on camera."
        : "Couldn't open the camera. Close other camera apps and try again.");
      $("camera-start").hidden = false;
    }
  }
  $("camera-start").addEventListener("click", startCamera);

  async function keepScreenOn() {
    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch { /* optional */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && stream) keepScreenOn();
  });

  // ================= Live link to the PC =================

  function waitForIce(conn) {
    if (conn.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { conn.removeEventListener("icegatheringstatechange", check); resolve(); };
      const check = () => { if (conn.iceGatheringState === "complete") done(); };
      conn.addEventListener("icegatheringstatechange", check);
      setTimeout(done, 2500);
    });
  }

  function setPcChip(on) {
    $("pc-chip").textContent = on ? "PC is watching" : "PC not watching yet";
    $("pc-chip").classList.toggle("on", on);
  }

  async function answerOffer(offer) {
    if (!stream) return;  // no camera yet; the PC will retry
    if (peer) peer.close();
    const conn = new RTCPeerConnection({ iceServers: [] });
    peer = conn;
    stream.getTracks().forEach((t) => conn.addTrack(t, stream));
    conn.onconnectionstatechange = () => { if (conn === peer) setPcChip(conn.connectionState === "connected"); };
    try {
      await conn.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      await conn.setLocalDescription(await conn.createAnswer());
      await waitForIce(conn);
      await fetch("/device/live/answer", {
        method: "POST",
        headers: deviceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ offer_id: offer.id, sdp: conn.localDescription.sdp }),
      });
    } catch {
      setPcChip(false);
    }
  }

  async function poll() {
    try {
      const res = await fetch("/device/live/poll", {
        method: "POST",
        headers: deviceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ camera: !!stream }),
      });
      if (res.status === 401) { unlinkLocally("This phone was unlinked. Scan a new QR code from your PC."); return; }
      if (!res.ok) return;
      const { offer } = await res.json();
      if (offer) answerOffer(offer);
    } catch { /* Wi-Fi blip: try again next tick */ }
  }

  function startPolling() {
    clearInterval(pollTimer);
    poll();
    pollTimer = setInterval(poll, 1000);
  }

  // ================= Unlink =================

  function unlinkLocally(message) {
    clearInterval(pollTimer);
    if (peer) peer.close();
    peer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    token = null;
    store.clear();
    show("pair");
    setMsg($("pair-status"), "");
    setMsg($("pair-error"), message || "");
  }
  $("unlink").addEventListener("click", () => unlinkLocally(""));

  // ================= Start =================

  (async () => {
    // The QR code opens /phone#code=XXXXXX. Read it, then wipe it from the address bar.
    const code = new URLSearchParams(location.hash.slice(1)).get("code");
    if (code) {
      history.replaceState(null, "", location.pathname);
      show("pair");
      await pairWith(code.toUpperCase());
      return;
    }
    if (!token) { show("pair"); return; }
    try {
      const res = await fetch("/device/me", { headers: deviceHeaders() });
      if (res.status === 401) { unlinkLocally("This phone was unlinked. Scan a new QR code from your PC."); return; }
      if (!res.ok) throw new Error();
      await enterCamera((await res.json()).username);
    } catch {
      show("pair");
      setMsg($("pair-error"), "Couldn't reach your PC. Is it on the same Wi-Fi with RevGym running?");
    }
  })();
})();
