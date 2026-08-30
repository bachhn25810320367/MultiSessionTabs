"use strict";

const http = require("http");

const TINY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#1d4ed8"/><circle cx="20" cy="20" r="12" fill="#93c5fd"/>${"<!-- pad -->".repeat(60)}</svg>`;

function startServer(options = {}) {
  const instance = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    const send = (type, body) => {
      response.setHeader("content-type", type);
      response.end(body);
    };
    if (url.pathname === "/bench-load.html") {
      const i = url.searchParams.get("i") || "0";
      let html = `<!doctype html><html><head><meta charset="utf-8"><title>Bench load</title><link rel="stylesheet" href="/style.css?i=${i}"></head><body><h1>Bench page</h1><div id="grid">`;
      for (let k = 0; k < 30; k += 1) html += `<img src="/img/${k}?i=${i}" width="40" height="40" alt="">`;
      html += `</div><script src="/app.js?i=${i}"></script></body></html>`;
      return send("text/html; charset=utf-8", html);
    }
    if (url.pathname.startsWith("/img/")) return send("image/svg+xml", TINY_SVG);
    if (url.pathname === "/style.css") {
      return send("text/css", `body{font-family:sans-serif}#grid{display:grid;grid-template-columns:repeat(10,40px);gap:4px}${"/* pad */".repeat(50)}`);
    }
    if (url.pathname === "/app.js") {
      return send("application/javascript", `document.title = "Bench " + document.querySelectorAll("img").length;\n${"// pad\n".repeat(80)}`);
    }
    if (url.pathname === "/bench-storage.html") {
      return send("text/html; charset=utf-8", `<!doctype html><html><body><script>
        window.runBench = () => {
          const out = {};
          let t0 = performance.now();
          for (let i = 0; i < 3000; i += 1) localStorage.setItem("k" + i, "x".repeat(50));
          out.setMs = performance.now() - t0;
          t0 = performance.now();
          let sink = 0;
          for (let i = 0; i < 3000; i += 1) sink += (localStorage.getItem("k" + i) || "").length;
          out.getMs = performance.now() - t0;
          t0 = performance.now();
          for (let i = 0; i < 300; i += 1) sink += localStorage.length;
          out.lenMs = performance.now() - t0;
          out.sink = sink;
          localStorage.clear();
          return out;
        };
      </script></body></html>`);
    }
    if (url.pathname === "/bench-worker.html") {
      return send("text/html; charset=utf-8", `<!doctype html><html><body><script>
        window.workerBench = async () => {
          const times = [];
          for (let k = 0; k < 3; k += 1) {
            times.push(await new Promise((resolve, reject) => {
              const t0 = performance.now();
              const worker = new Worker("/worker.js");
              const timer = setTimeout(() => { worker.terminate(); reject(new Error("worker timeout")); }, 20000);
              worker.onmessage = () => { clearTimeout(timer); const dt = performance.now() - t0; worker.terminate(); resolve(dt); };
              worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message || "worker error")); };
              worker.postMessage({ command: "get" });
            }));
          }
          return times;
        };
      </script></body></html>`);
    }
    if (url.pathname === "/worker.js") {
      return send("application/javascript; charset=utf-8", `
        function idbGet(key) {
          return new Promise((resolve, reject) => {
            const open = indexedDB.open("worker-state", 1);
            open.onupgradeneeded = () => open.result.createObjectStore("kv");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction("kv", "readonly");
              const get = tx.objectStore("kv").get(key);
              get.onsuccess = () => resolve(get.result ?? null);
              get.onerror = () => reject(get.error);
            };
          });
        }
        self.onmessage = async (event) => {
          try {
            if (event.data.command === "set") { /* unused */ }
            self.postMessage({ value: await idbGet("user") });
          } catch (error) { self.postMessage({ error: error.message || String(error) }); }
        };
      `);
    }
    if (url.pathname === "/frame-host.html") {
      const child = options.frameChildOrigin || "";
      return send("text/html; charset=utf-8", `<!doctype html><html><body><h1>Frame host</h1><iframe id="third" src="${child}/frame-child.html" width="320" height="120"></iframe></body></html>`);
    }
    if (url.pathname === "/frame-child.html") {
      return send("text/html; charset=utf-8", `<!doctype html><html><body><p>third-party frame</p></body></html>`);
    }
    if (url.pathname === "/set") {
      const name = url.searchParams.get("name") || "token";
      const value = url.searchParams.get("value") || "value";
      const attrs = [`${name}=${value}`, "Path=/"];
      if (url.searchParams.get("httpOnly")) attrs.push("HttpOnly");
      response.setHeader("set-cookie", attrs.join("; "));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/echo") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ cookie: request.headers.cookie || "" }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  return new Promise((resolve) => {
    instance.listen(0, "127.0.0.1", () => {
      const { port } = instance.address();
      resolve({ instance, origin: `http://127.0.0.1:${port}` });
    });
  });
}

module.exports = { startServer };
