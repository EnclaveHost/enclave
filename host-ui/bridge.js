// host-ui/bridge.js -- the panel's only way out: messages to the shell that hosts it (README.md, "The shell's side").
// WebView2 (the Windows tray), the Android app's WebView, or a browser on dev-server.mjs. The shell holds the node's token
// and makes the calls; the page sees answers only.
"use strict";
(function () {
  var pending = {}, seq = 0, listeners = {}, post;
  var TIMEOUT_MS = 12000;

  function receive(msg) {
    if (typeof msg === "string") { try { msg = JSON.parse(msg); } catch (e) { return; } }
    if (!msg || typeof msg !== "object") return;
    if (msg.id != null && pending[msg.id]) {
      var p = pending[msg.id]; delete pending[msg.id];
      clearTimeout(p.timer); p.resolve(msg);
      return;
    }
    if (typeof msg.event === "string") (listeners[msg.event] || []).forEach(function (fn) { try { fn(msg); } catch (e) { console.error(e); } });
  }

  if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === "function") {
    post = function (m) { window.chrome.webview.postMessage(m); };
    window.chrome.webview.addEventListener("message", function (e) { receive(e.data); });
  } else if (window.EnclaveHostNative && typeof window.EnclaveHostNative.postMessage === "function") {
    post = function (m) { window.EnclaveHostNative.postMessage(JSON.stringify(m)); };
    window.__enclaveHost = receive;
  } else {
    // a browser on dev-server.mjs: the same messages, answered over HTTP on this origin
    post = function (m) {
      if (m.op === "hello") return receive({ id: m.id, platform: "browser", titleBar: !/[?&]notitle\b/.test(location.search), version: "dev" });
      if (m.op === "open") { window.open(m.url, "_blank", "noopener"); return; }
      if (m.op !== "request") return;
      var init = { method: m.method, headers: {} };
      if (m.body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(m.body); }
      fetch("/api" + m.path, init).then(function (r) {
        return r.text().then(function (t) {
          var body = null; try { body = JSON.parse(t); } catch (e) { body = { message: t.slice(0, 200) }; }
          var update = null; try { update = JSON.parse(r.headers.get("x-enclave-update") || "null"); } catch (e) { }
          if (r.status === 502 && body && body.error === "unreachable") receive({ id: m.id, status: 0, message: body.message, update: update });
          else receive({ id: m.id, status: r.status, body: body, update: update });
        });
      }, function (e) { receive({ id: m.id, status: 0, message: "the panel's server is not answering (" + e.message + ")" }); });
    };
  }

  /** Send and wait for the shell's answer: { status, body, message, update }, status 0 when the node can't be reached. */
  function ask(m) {
    return new Promise(function (resolve) {
      var id = ++seq;
      m.id = id;
      pending[id] = { resolve: resolve, timer: setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        resolve({ id: id, status: 0, message: "no answer from the node in " + TIMEOUT_MS / 1000 + " s" });
      }, TIMEOUT_MS) };
      try { post(m); } catch (e) { delete pending[id]; resolve({ id: id, status: 0, message: "the panel could not reach its window (" + e.message + ")" }); }
    });
  }

  window.EnclaveHost = {
    hello: function () { return ask({ op: "hello" }); },
    request: function (method, path, body) { return ask({ op: "request", method: method, path: path, body: body }); },
    send: function (op, data) { var m = { op: op }; for (var k in data || {}) m[k] = data[k]; try { post(m); } catch (e) { } },
    on: function (event, fn) { (listeners[event] = listeners[event] || []).push(fn); },
    _receive: receive,
  };
})();
