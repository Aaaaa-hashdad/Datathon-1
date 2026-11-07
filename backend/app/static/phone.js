// RevGym phone camera: links by QR code, opens the camera, streams it live to the
// PC over Wi-Fi (WebRTC), and records sets when you or the PC say so.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const KEY = "revgym_device_token";
  const store = {
    get() { try { return localStorage.getItem(KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch { /* memory only */ } },
    clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
  };
  const LIFT_NAME = {
    bench_press: "Bench Press", squat: "Squat", bicep_curl: "Bicep Curl",
    shoulder_press: "Shoulder Press", deadlift: "Deadlift", lunge: "Lunge",
  };

  let token = store.get();
  let stream = null;          // camera
  let peer = null;            // live link to the PC
  let recorder = null;
  let chunks = [];
  let recExercise = null;
  let recStarted = 0;
  let recClock = null;
  let pollTimer = null;
  let wakeLock = null;

  const setMsg = (node, text) => { node.textContent = text; node.hidden = !text; };
  const fmtClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
      // Only happens without HTTPS. Fall back to the phone's own camera app.
      setMsg($("camera-error"), "Live camera needs the secure (https) address from the QR code. You can still record with your camera app.");
      $("record").disabled = false;
      $("record-label").textContent = "Record with camera app";
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      $("preview").srcObject = stream;
      $("record").disabled = false;
      keepScreenOn();
      // If a live link already exists, send it the new camera.
      if (peer) {
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

  async function keepScreenOn() {
    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch { /* optional */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && stream && !wakeLock) keepScreenOn();
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
    if (!stream) return; // no camera yet; the PC will retry
    if (peer) peer.close();
    const conn = new RTCPeerConnection({ iceServers: [] });
    peer = conn;
    stream.getTracks().forEach((t) => conn.addTrack(t, stream));
    conn.onconnectionstatechange = () => {
      if (conn !== peer) return;
      setPcChip(conn.connectionState === "connected");
    };
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
        body: JSON.stringify({ camera: !!stream, recording: !!recorder }),
      });
      if (res.status === 401) { unlinkLocally("This phone was unlinked. Scan a new QR code from your PC."); return; }
      if (!res.ok) return;
      const { offer, commands } = await res.json();
      if (offer) answerOffer(offer);
      for (const cmd of commands) {
        if (cmd.action === "start") startRecording(cmd.exercise);
        else if (cmd.action === "stop") stopRecording();
      }
    } catch { /* Wi-Fi blip: try again next tick */ }
  }

  function startPolling() {
    clearInterval(pollTimer);
    poll();
    pollTimer = setInterval(poll, 1000);
  }

  // ================= Recording =================

  function pickMime() {
    if (!window.MediaRecorder) return null;
    const options = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return options.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  function setRecordingUi(on) {
    $("record").classList.toggle("stop", on);
    $("record-label").textContent = on ? "Stop" : "Record";
    $("exercise").disabled = on;
    $("phone-rec").hidden = !on;
    clearInterval(recClock);
    if (on) {
      recStarted = Date.now();
      const tick = () => { $("phone-rec-timer").textContent = fmtClock(Math.round((Date.now() - recStarted) / 1000)); };
      tick();
      recClock = setInterval(tick, 500);
    }
  }

  function startRecording(exercise) {
    if (recorder || !stream) return;
    const mime = pickMime();
    if (mime === null) {
      setMsg($("upload-error"), "This browser can't record video here. Use the camera app instead.");
      return;
    }
    if (exercise && LIFT_NAME[exercise]) $("exercise").value = exercise;
    recExercise = $("exercise").value;
    setMsg($("upload-done"), "");
    setMsg($("upload-error"), "");
    chunks = [];
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5_000_000 } : undefined);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const type = (recorder.mimeType || mime || "video/webm").split(";")[0];
      const blob = new Blob(chunks, { type });
      recorder = null;
      setRecordingUi(false);
      poll(); // tell the PC right away
      upload(blob, recExercise);
    };
    recorder.start(1000);
    setRecordingUi(true);
    poll();
  }

  function stopRecording() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  $("record").addEventListener("click", () => {
    if (!stream) {
      // No live camera (http): use the phone's camera app.
      $("file-fallback").value = "";
      $("file-fallback").click();
      return;
    }
    if (recorder) stopRecording();
    else startRecording($("exercise").value);
  });
  $("file-fallback").addEventListener("change", () => {
    const file = $("file-fallback").files[0];
    if (file) upload(file, $("exercise").value);
  });
  $("camera-start").addEventListener("click", startCamera);

  // ================= Upload =================

  function upload(blob, exercise) {
    const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("quicktime") ? "mov" : "webm";
    const form = new FormData();
    form.append("exercise", exercise);
    form.append("video", blob, blob.name || `${exercise}.${ext}`);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/recordings");
    xhr.setRequestHeader("X-Device-Token", token);
    $("upload-box").hidden = false;
    $("upload-label").textContent = "Sending to your PC… 0%";

    xhr.upload.addEventListener("progress", (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      $("progress-bar").style.width = `${pct}%`;
      $("progress").setAttribute("aria-valuenow", String(pct));
      $("upload-label").textContent = `Sending to your PC… ${pct}%`;
    });
    xhr.addEventListener("load", () => {
      $("upload-box").hidden = true;
      $("progress-bar").style.width = "0";
      if (xhr.status === 201) {
        setMsg($("upload-done"), `${LIFT_NAME[exercise]} sent to your PC ✓`);
      } else if (xhr.status === 401) {
        unlinkLocally("This phone was unlinked. Scan a new QR code from your PC.");
      } else {
        let msg = "Upload failed. Try again.";
        try { const d = JSON.parse(xhr.responseText); if (typeof d.detail === "string") msg = d.detail; } catch { /* ignore */ }
        setMsg($("upload-error"), msg);
      }
    });
    xhr.addEventListener("error", () => {
      $("upload-box").hidden = true;
      setMsg($("upload-error"), "Couldn't reach your PC. Is it on the same Wi-Fi with RevGym running?");
    });
    xhr.send(form);
  }

  // ================= Unlink =================

  function unlinkLocally(message) {
    clearInterval(pollTimer);
    if (recorder && recorder.state !== "inactive") { recorder.onstop = null; recorder.stop(); }
    recorder = null;
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
