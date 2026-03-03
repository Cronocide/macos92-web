/*
 * pointer-lock.js — Captures the mouse inside the noVNC canvas and sends
 *                   relative movement directly to QEMU via VNC.
 *
 * Why this is needed:
 *   Mac OS 9 only has a relative (ADB) mouse — no USB tablet driver.
 *   noVNC sends absolute coordinates clamped to the framebuffer bounds,
 *   which means the VNC cursor "hits a wall" at the edge of the canvas.
 *   We need truly unbounded relative movement.
 *
 * How it works:
 *   1. Waits for noVNC to create its <canvas> (it's dynamic, not in HTML).
 *   2. On mousedown (captured at the document level before noVNC can
 *      suppress it), requests Pointer Lock on the canvas.
 *   3. While locked, intercepts ALL mouse events in the *capturing* phase
 *      so noVNC never sees them.  Instead we construct raw VNC Pointer
 *      Event messages (type 5) and write them directly to the WebSocket,
 *      completely bypassing noVNC's coordinate conversion and clamping.
 *   4. Mouse position is accumulated in VNC coordinate space starting at
 *      (32768, 32768) — the centre of the uint16 range — giving ~32 768
 *      pixels of travel in every direction before any wrapping concerns.
 *   5. QEMU's VNC server computes  delta = x − last_x  from our raw
 *      unclamped values, producing correct relative deltas for the ADB
 *      mouse regardless of framebuffer size.
 *   6. Pressing Escape releases the lock (browser default behaviour).
 *
 * Disable via query-string:  ?pointer_lock=0
 */
(function () {
  "use strict";

  /* ---- Feature gate ---- */
  function isEnabled() {
    var params = new URLSearchParams(window.location.search);
    var v = (params.get("pointer_lock") || "1").toLowerCase();
    return v !== "0" && v !== "false" && v !== "off" && v !== "no";
  }
  if (!isEnabled()) return;

  /* ---- Toast helper ---- */
  function toast(msg) {
    var el = document.getElementById("plock-toast");
    if (el) el.remove();
    el = document.createElement("div");
    el.id = "plock-toast";
    el.textContent = msg;
    el.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);" +
      "background:rgba(0,0,0,.78);color:#fff;padding:8px 20px;" +
      "border-radius:6px;font:14px/1.4 sans-serif;z-index:99999;" +
      "pointer-events:none;transition:opacity .5s;opacity:1;";
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = "0"; }, 2000);
    setTimeout(function () { el.remove(); }, 2600);
  }

  /* ==================================================================
   * VNC Pointer-Event helpers
   * ================================================================*/

  /*  VNC button mask layout:
   *    bit 0 = left,  bit 1 = middle,  bit 2 = right,
   *    bit 3 = scroll-up,  bit 4 = scroll-down
   *
   *  Browser MouseEvent.buttons layout:
   *    bit 0 = left (1),  bit 1 = right (2),  bit 2 = middle (4)
   */
  function browserButtonsToVnc(b) {
    return (b & 1)             /* left:   browser bit 0 → VNC bit 0 */
         | ((b & 4) >> 1)     /* middle: browser bit 2 → VNC bit 1 */
         | ((b & 2) << 1);    /* right:  browser bit 1 → VNC bit 2 */
  }

  /**
   * Write a raw VNC Pointer Event (message type 5) directly into
   * noVNC's WebSocket send-queue, bypassing all coordinate conversion
   * and clamping.
   *
   * VNC Pointer Event layout (6 bytes):
   *   [type=5] [button-mask] [x-hi] [x-lo] [y-hi] [y-lo]
   */
  function sendVncPointer(x, y, mask) {
    var rfb = window.__qemuRFB;
    if (!rfb) return false;
    var sock = rfb._sock;
    if (!sock) return false;

    /* Clamp to uint16 */
    x = Math.max(0, Math.min(65535, Math.round(x)));
    y = Math.max(0, Math.min(65535, Math.round(y)));

    /* Write into noVNC's Websock send queue (internal API, but stable
       across all noVNC versions that use _sQ / _sQlen / flush). */
    if (sock._sQ && typeof sock._sQlen === "number" &&
        typeof sock.flush === "function") {
      var b = sock._sQ;
      var o = sock._sQlen;
      b[o]     = 5;
      b[o + 1] = mask & 0xFF;
      b[o + 2] = (x >> 8) & 0xFF;
      b[o + 3] = x & 0xFF;
      b[o + 4] = (y >> 8) & 0xFF;
      b[o + 5] = y & 0xFF;
      sock._sQlen += 6;
      sock.flush();
      return true;
    }
    return false;
  }

  /* ==================================================================
   * State
   * ================================================================*/
  var canvas     = null;
  var locked     = false;
  var vncX       = 32768;     /* VNC coordinate — centre of uint16 */
  var vncY       = 32768;
  var btnMask    = 0;         /* current VNC button mask             */

  /* ==================================================================
   * Attach to the dynamically-created noVNC canvas
   * ================================================================*/
  function attachToCanvas(cvs) {
    if (cvs === canvas) return;
    canvas = cvs;
    console.log("[Pointer Lock] Attached to canvas", cvs);

    /* ---- Lock / unlock bookkeeping ---- */
    document.addEventListener("pointerlockchange", function () {
      if (document.pointerLockElement === cvs) {
        locked = true;
        /* Seed VNC position at the centre of the uint16 range so we
           have maximum room in every direction. */
        vncX    = 32768;
        vncY    = 32768;
        btnMask = 0;
        cvs.style.cursor = "none";
        toast("Mouse captured \u2014 press Esc to release");
        console.log("[Pointer Lock] Locked — VNC seed", vncX, vncY);
      } else {
        if (locked) {
          /* Before handing back to noVNC, move the VNC pointer to
             the centre of the actual framebuffer so QEMU's last_x/y
             are in a sane range for noVNC's absolute coordinates. */
          var rfb = window.__qemuRFB;
          var fbW = (rfb && rfb._fbWidth)  || 640;
          var fbH = (rfb && rfb._fbHeight) || 480;
          sendVncPointer(Math.round(fbW / 2), Math.round(fbH / 2), 0);
        }
        locked = false;
        cvs.style.cursor = "";
        toast("Mouse released \u2014 click to recapture");
        console.log("[Pointer Lock] Unlocked");
      }
    });

    /* ---- Intercept mouse events while locked ---- */

    /*
     * We listen in the CAPTURING phase on the canvas and call
     * stopImmediatePropagation() so noVNC's own handlers never
     * see these events.  Instead we translate movementX/Y into
     * accumulated VNC coordinates and send a raw pointer event
     * over the WebSocket.
     */
    ["mousemove", "mousedown", "mouseup"].forEach(function (type) {
      cvs.addEventListener(type, function (ev) {
        if (!locked) return;

        ev.stopImmediatePropagation();
        ev.preventDefault();

        /* Scale browser screen-pixels → VNC framebuffer-pixels */
        var r    = cvs.getBoundingClientRect();
        var rfb  = window.__qemuRFB;
        var fbW  = (rfb && rfb._fbWidth)  || r.width;
        var fbH  = (rfb && rfb._fbHeight) || r.height;
        var sX   = fbW / r.width;
        var sY   = fbH / r.height;

        vncX += (ev.movementX || 0) * sX;
        vncY += (ev.movementY || 0) * sY;

        /* Clamp to well inside uint16 (leave margin for rounding) */
        if (vncX < 100)   vncX = 100;
        if (vncX > 65400) vncX = 65400;
        if (vncY < 100)   vncY = 100;
        if (vncY > 65400) vncY = 65400;

        /* Update button state */
        btnMask = browserButtonsToVnc(ev.buttons);

        sendVncPointer(vncX, vncY, btnMask);
      }, true);  /* capturing phase */
    });

    /* ---- Scroll wheel ---- */
    cvs.addEventListener("wheel", function (ev) {
      if (!locked) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();

      /* VNC: bit 3 = scroll-up (0x08), bit 4 = scroll-down (0x10) */
      var scrollBit = 0;
      if (ev.deltaY < 0) scrollBit = 0x08;
      else if (ev.deltaY > 0) scrollBit = 0x10;
      if (!scrollBit) return;

      /* Press the scroll "button" … */
      sendVncPointer(vncX, vncY, btnMask | scrollBit);
      /* … then immediately release it */
      sendVncPointer(vncX, vncY, btnMask);
    }, true);
  }

  /* ==================================================================
   * Pointer-lock trigger  (document-level, capturing phase)
   *
   * We use mousedown (not click) because noVNC calls preventDefault()
   * on mousedown, which suppresses the browser's click synthesis.
   * Listening at the document level in the capturing phase guarantees
   * we fire before any element-level handlers.
   * ================================================================*/
  document.addEventListener("mousedown", function (ev) {
    if (!canvas) return;
    if (locked) return;
    if (document.pointerLockElement === canvas) return;
    if (ev.target !== canvas) return;

    console.log("[Pointer Lock] Requesting pointer lock via mousedown");
    canvas.requestPointerLock();
  }, true);

  /* ==================================================================
   * Wait for noVNC to create its <canvas>
   * ================================================================*/
  function watchForCanvas() {
    var container = document.getElementById("noVNC_container");
    if (!container) {
      console.log("[Pointer Lock] noVNC_container not found, retrying…");
      setTimeout(watchForCanvas, 200);
      return;
    }

    /* Maybe it already exists */
    var existing = container.querySelector("canvas");
    if (existing) {
      attachToCanvas(existing);
    }

    /* Keep observing — noVNC may replace the canvas on reconnect */
    var obs = new MutationObserver(function () {
      var el = container.querySelector("canvas");
      if (el && el !== canvas) {
        console.log("[Pointer Lock] New canvas detected, re-attaching");
        attachToCanvas(el);
      }
    });
    obs.observe(container, { childList: true, subtree: true });
    console.log("[Pointer Lock] Watching for canvas in #noVNC_container");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForCanvas);
  } else {
    watchForCanvas();
  }
})();
