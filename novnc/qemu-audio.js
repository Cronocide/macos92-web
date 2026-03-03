/*
 * qemu-audio.js — QEMU VNC Audio Extension for noVNC
 *
 * Implements the QEMU Audio pseudo-encoding (-259) to stream audio from
 * the emulated machine to the browser via the Web Audio API.
 *
 * Requirements (applied automatically by the Dockerfile):
 *   • noVNC's core/rfb.js must be patched to:
 *     1. Include encoding -259 in SetEncodings
 *     2. Delegate server message type 255 to window.__qemuAudioHandler(rfb)
 *     3. Accept rect encoding -259 (audio ack) in framebuffer updates
 *     4. Expose the RFB instance as window.__qemuRFB
 *
 * Protocol summary (QEMU VNC extension):
 *   Client → Server
 *     [255][1][0,0]                    — Enable audio
 *     [255][1][0,1]                    — Disable audio
 *     [255][1][0,2][fmt][ch][freq:u32] — Set audio format
 *   Server → Client
 *     [255][1][0,0]                    — Audio stream ended
 *     [255][1][0,1]                    — Audio stream started
 *     [255][1][0,2][len:u32][pcm…]     — Audio data (raw PCM)
 *
 * Disable via query-string:  ?audio=0
 */
(function () {
  "use strict";

  /* ---- feature gate ---- */
  var params = new URLSearchParams(window.location.search);
  var av = (params.get("audio") || "1").toLowerCase();
  if (av === "0" || av === "false" || av === "off" || av === "no") return;

  /* ---- constants ---- */
  var QEMU_AUDIO_SUB = 1;                    /* QEMU sub-type: Audio      */
  var MSG_END   = 0;                          /* server → client           */
  var MSG_BEGIN = 1;
  var MSG_DATA  = 2;
  var RATE      = 44100;                      /* sample rate (Hz)          */
  var CHANS     = 2;                          /* stereo                    */
  var FMT_S16   = 3;                          /* signed 16-bit PCM         */
  var LEAD_S    = 0.04;                       /* 40 ms scheduling lead     */
  var MAX_LAG_S = 0.30;                       /* resync threshold          */

  /* ---- state ---- */
  var ctx       = null;                       /* AudioContext              */
  var nextT     = 0;                          /* next buffer start time    */
  var streaming = false;                      /* server says audio active  */
  var enabled   = false;                      /* we asked for audio        */
  var rfb       = null;                       /* noVNC RFB instance        */
  var gestured  = false;                      /* user has interacted       */

  /* ==================================================================
   * AudioContext
   * ================================================================*/
  function ac() {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate:  RATE,
          latencyHint: "interactive",
        });
      } catch (e) {
        console.error("[QEMU Audio] AudioContext creation failed:", e);
        return null;
      }
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  /* ==================================================================
   * PCM → Web Audio playback
   * ================================================================*/
  function playPCM(raw) {
    var c = ac();
    if (!c || c.state !== "running") return;

    var nSamples = (raw.length / (2 * CHANS)) | 0;
    if (nSamples === 0) return;

    var buf = c.createBuffer(CHANS, nSamples, RATE);
    var dv  = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    for (var ch = 0; ch < CHANS; ch++) {
      var out = buf.getChannelData(ch);
      for (var i = 0; i < nSamples; i++) {
        var off = (i * CHANS + ch) * 2;
        out[i] = (off + 1 < raw.length)
          ? dv.getInt16(off, /* littleEndian */ true) / 32768.0
          : 0;
      }
    }

    var now = c.currentTime;
    if (nextT < now || (nextT - now) > MAX_LAG_S) {
      nextT = now + LEAD_S;
    }

    var src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(nextT);
    nextT += buf.duration;
  }

  /* ==================================================================
   * VNC protocol helpers (client → server)
   * ================================================================*/
  function rawSend(sock, bytes) {
    var data = new Uint8Array(bytes);
    /* noVNC ≥1.5 replaced Websock.send() with sQpushBytes()+flush() */
    if (typeof sock.send === "function") {
      sock.send(data);
    } else {
      sock.sQpushBytes(data);
      sock.flush();
    }
  }

  function sendSetFormat(sock) {
    rawSend(sock, [
      255, 1,               /* QEMU / Audio                     */
      0, 2,                 /* SET_FORMAT                        */
      FMT_S16, CHANS,       /* format, channels                  */
      (RATE >>> 24) & 0xff, /* frequency (big-endian u32)        */
      (RATE >>> 16) & 0xff,
      (RATE >>>  8) & 0xff,
       RATE         & 0xff,
    ]);
  }

  function sendEnable(sock) {
    rawSend(sock, [255, 1, 0, 0]);   /* QEMU / Audio / ENABLE  */
  }

  function sendDisable(sock) {
    rawSend(sock, [255, 1, 0, 1]);   /* QEMU / Audio / DISABLE */
  }

  /* ==================================================================
   * Enable / disable audio
   * ================================================================*/
  function doEnable() {
    var r = rfb || window.__qemuRFB;
    if (!r || !r._sock) return;
    rfb = r;
    ac();                                 /* create AudioContext (in gesture) */
    sendSetFormat(r._sock);
    sendEnable(r._sock);
    enabled = true;
    nextT   = 0;
    updateBtn();
    toast("Audio enabled");
  }

  function doDisable() {
    var r = rfb || window.__qemuRFB;
    if (r && r._sock) sendDisable(r._sock);
    enabled   = false;
    streaming = false;
    updateBtn();
    toast("Audio disabled");
  }

  /* ==================================================================
   * noVNC message handler — called from patched core/rfb.js
   *   when a server message of type 255 (QEMU) arrives.
   *
   * IMPORTANT: _normalMsg already consumed the type byte (255) via
   * rQshift8() before dispatching to us.  The buffer starts at the
   * QEMU sub-type byte:
   *   [sub(1)][msg(2)]   — for END / BEGIN
   *   [sub(1)][msg(2)][len(4)][pcm…] — for DATA
   * ================================================================*/
  window.__qemuAudioHandler = function (inst) {
    var sock = inst._sock;

    /* Track RFB instance (also detects reconnects) */
    if (rfb !== inst) {
      rfb       = inst;
      enabled   = false;
      streaming = false;
      if (gestured) setTimeout(doEnable, 300);
    }

    /* Need at least 3 bytes: sub(1) + msg(2)  (type byte already gone) */
    if (sock.rQlen < 3) return false;

    /* Peek using internal buffer */
    var rQ = sock._rQ, ri = sock._rQi;
    var sub = rQ[ri];

    if (sub !== QEMU_AUDIO_SUB) {
      /* Unknown QEMU sub-type — consume sub(1) + msg(2) */
      sock.rQshift8();
      sock.rQshift16();
      return true;
    }

    var msg = (rQ[ri + 1] << 8) | rQ[ri + 2];

    switch (msg) {
      case MSG_END:
        sock.rQshift8(); sock.rQshift16();
        streaming = false;
        updateBtn();
        return true;

      case MSG_BEGIN:
        sock.rQshift8(); sock.rQshift16();
        streaming = true;
        nextT     = 0;
        updateBtn();
        return true;

      case MSG_DATA:
        if (sock.rQlen < 7) return false;          /* sub(1)+msg(2)+len(4) */
        var len =
          ((rQ[ri + 3] << 24) |
           (rQ[ri + 4] << 16) |
           (rQ[ri + 5] <<  8) |
            rQ[ri + 6]) >>> 0;                      /* unsigned 32-bit */
        if (sock.rQlen < 7 + len) return false;     /* need full payload */

        /* Consume header: sub(1) + msg(2) + len(4) */
        sock.rQshift8(); sock.rQshift16(); sock.rQshift32();

        /* Consume PCM payload */
        var pcm = sock.rQshiftBytes(len);
        if (streaming) playPCM(new Uint8Array(pcm));
        return true;

      default:
        /* Unknown audio sub-message — consume header */
        sock.rQshift8(); sock.rQshift8(); sock.rQshift16();
        return true;
    }
  };

  /* ==================================================================
   * UI — floating speaker button
   * ================================================================*/
  function createBtn() {
    var b = document.createElement("div");
    b.id          = "qemu-audio-btn";
    b.textContent = "\uD83D\uDD07";   /* 🔇 */
    b.title       = "Enable QEMU audio";
    b.style.cssText =
      "position:fixed;bottom:12px;right:12px;width:40px;height:40px;" +
      "background:rgba(0,0,0,.72);color:#fff;border-radius:50%;" +
      "display:flex;align-items:center;justify-content:center;" +
      "font-size:20px;cursor:pointer;z-index:99999;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.3);transition:all .2s;" +
      "user-select:none;-webkit-user-select:none;";

    b.onmouseenter = function () { b.style.transform = "scale(1.1)"; };
    b.onmouseleave = function () { b.style.transform = "";           };

    b.onclick = function (e) {
      e.stopPropagation();
      gestured = true;
      enabled ? doDisable() : doEnable();
    };

    document.body.appendChild(b);
  }

  function updateBtn() {
    var b = document.getElementById("qemu-audio-btn");
    if (!b) return;
    if (enabled && streaming) {
      b.textContent = "\uD83D\uDD0A";             /* 🔊 */
      b.title       = "Audio playing \u2014 click to mute";
    } else if (enabled) {
      b.textContent = "\uD83D\uDD08";             /* 🔈 */
      b.title       = "Waiting for audio stream\u2026";
    } else {
      b.textContent = "\uD83D\uDD07";             /* 🔇 */
      b.title       = "Enable QEMU audio";
    }
  }

  /* ---- toast ---- */
  function toast(m) {
    var e = document.getElementById("qaudio-toast");
    if (e) e.remove();
    e = document.createElement("div");
    e.id          = "qaudio-toast";
    e.textContent = m;
    e.style.cssText =
      "position:fixed;bottom:64px;right:12px;" +
      "background:rgba(0,0,0,.78);color:#fff;padding:6px 16px;" +
      "border-radius:6px;font:13px/1.4 sans-serif;z-index:99999;" +
      "pointer-events:none;transition:opacity .5s;opacity:1;";
    document.body.appendChild(e);
    setTimeout(function () { e.style.opacity = "0"; }, 2000);
    setTimeout(function () { e.remove();             }, 2600);
  }

  /* ==================================================================
   * User-gesture tracking (required by browser autoplay policy)
   * ================================================================*/
  function trackGesture() {
    function on() {
      gestured = true;
      ["click", "keydown", "touchstart"].forEach(function (t) {
        document.removeEventListener(t, on, true);
      });
      if (!enabled) doEnable();
    }
    ["click", "keydown", "touchstart"].forEach(function (t) {
      document.addEventListener(t, on, true);
    });
  }

  /* ==================================================================
   * Boot
   * ================================================================*/
  function boot() {
    createBtn();
    trackGesture();
    console.log(
      "[QEMU Audio] Extension loaded \u2014 click \uD83D\uDD07 or " +
      "interact with the page to enable audio."
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
