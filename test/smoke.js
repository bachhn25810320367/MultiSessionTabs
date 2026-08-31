"use strict";

// Functional smoke test, runnable on Windows and Linux with Chrome for Testing.
// Usage: node test/smoke.js  (set CHROME_EXECUTABLE or run `npm run install:browser` first)

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");
const { startServer } = require("./server");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  if (process.env.CHROME_EXECUTABLE) return process.env.CHROME_EXECUTABLE;
  const base = path.join(EXTENSION_ROOT, ".browsers", "chrome");
  if (fs.existsSync(base)) {
    for (const version of fs.readdirSync(base)) {
      for (const sub of ["chrome-win64", "chrome-win", "chrome-linux64"]) {
        for (const binary of ["chrome.exe", "chrome"]) {
          const candidate = path.join(base, version, sub, binary);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  throw new Error("Chrome for Testing not found. Run `npm run install:browser` or set CHROME_EXECUTABLE.");
}

async function evalSW(session, expression) {
  const result = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error("SW eval failed: " + JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function waitMarker(page, timeoutMs) {
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.multisessionTabs), { timeout: timeoutMs, polling: 200 });
}

async function echoCookies(page) {
  const body = await page.evaluate(async () => {
    const response = await fetch("/echo", { cache: "no-store" });
    return response.json();
  });
  return body.cookie || "";
}

async function main() {
  const thirdParty = await startServer();
  // Reference the second server via a different hostname so the embedded frame
  // is cross-origin by host (the same trick test/e2e.js uses for external origins).
  const childOrigin = thirdParty.origin.replace("//127.0.0.1", "//localhost");
  const server = await startServer({ frameChildOrigin: childOrigin });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mst-smoke-"));
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    userDataDir,
    args: [
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${EXTENSION_ROOT}`,
      `--load-extension=${EXTENSION_ROOT}`,
      // GitHub Actions ubuntu runners disable unprivileged user namespaces
      // (AppArmor restriction on Ubuntu 23.10+), which kills the Chrome zygote
      // sandbox at launch. The smoke suite does not rely on the sandbox.
      ...(process.platform === "linux" ? ["--no-sandbox", "--disable-setuid-sandbox"] : [])
    ]
  });

  const failures = [];
  const check = (name, condition, detail) => {
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "  -> " + detail}`);
    if (!condition) failures.push(name);
  };

  try {
    const target = await browser.waitForTarget((item) => item.type() === "service_worker" && item.url().startsWith("chrome-extension://"), { timeout: 15000 });
    const swSession = await target.createCDPSession();
    await swSession.send("Runtime.enable");

    // Normal tab: plant a cookie in the shared browser jar
    const pageN = await browser.newPage();
    await pageN.goto(`${server.origin}/set?name=normal&value=KEEP`, { waitUntil: "load" });
    await sleep(300);

    // Session tab: the new tab id that appears after opening a second page
    const tabsBefore = JSON.parse(await evalSW(swSession, `chrome.tabs.query({ url: "${server.origin}/*" }).then((tabs) => JSON.stringify(tabs.map((tab) => tab.id)))`));
    const pageS = await browser.newPage();
    await pageS.goto(`${server.origin}/bench-load.html?i=smoke`, { waitUntil: "load" });
    const tabsAfter = JSON.parse(await evalSW(swSession, `chrome.tabs.query({ url: "${server.origin}/*" }).then((tabs) => JSON.stringify(tabs.map((tab) => tab.id)))`));
    const tabIdS = tabsAfter.find((id) => !tabsBefore.includes(id));
    check("found session tab id", Boolean(tabIdS), JSON.stringify({ tabsBefore, tabsAfter }));

    const responseJson = await evalSW(swSession, `handleMessage({ type: "session:create", tabId: ${tabIdS}, url: ${JSON.stringify(pageS.url())}, mode: "current", name: "Smoke" }, {})
      .then((value) => JSON.stringify(value)).catch((error) => JSON.stringify({ ok: false, error: String(error) }))`);
    check("session created", JSON.parse(responseJson).ok === true, responseJson);
    await waitMarker(pageS, 8000);

    // HTTP Set-Cookie inside the assigned tab -> captured into session
    await pageS.goto(`${server.origin}/set?name=sid&value=SESSVAL`, { waitUntil: "load" });
    await sleep(800);

    const sCookie = await echoCookies(pageS);
    check("session tab sends session cookie", sCookie.includes("sid=SESSVAL"), sCookie);
    check("session tab does not send normal jar cookie", !sCookie.includes("normal=KEEP"), sCookie);

    const nCookie = await echoCookies(pageN);
    check("normal tab keeps its own cookie (no theft)", nCookie.includes("normal=KEEP"), nCookie);
    check("normal tab does not see session cookie", !nCookie.includes("sid=SESSVAL"), nCookie);

    const jarJson = await evalSW(swSession, `chrome.cookies.getAll({ url: "${server.origin}/" }).then((cookies) => JSON.stringify(cookies.map((cookie) => cookie.name + "=" + cookie.value)))`);
    const jar = JSON.parse(jarJson);
    check("jar still holds normal cookie (no theft)", jar.some((entry) => entry === "normal=KEEP"), JSON.stringify(jar));
    check("jar does not hold session cookie", !jar.some((entry) => entry === "sid=SESSVAL"), JSON.stringify(jar));

    // Worker patch still functional in assigned tab
    await pageS.goto(`${server.origin}/bench-worker.html`, { waitUntil: "load" });
    await waitMarker(pageS, 8000);
    const workerTimes = await pageS.evaluate(() => window.workerBench());
    check("worker round-trip works in session", Array.isArray(workerTimes) && workerTimes.length === 3, JSON.stringify(workerTimes));

    // Storage patch still functional in assigned tab
    await pageS.goto(`${server.origin}/bench-storage.html`, { waitUntil: "load" });
    await waitMarker(pageS, 8000);
    const storage = await pageS.evaluate(() => window.runBench());
    check("localStorage proxy works in session", storage && typeof storage.setMs === "number", JSON.stringify(storage));

    // Persistence across reload: cookie survives, still isolated
    await pageS.goto(`${server.origin}/bench-load.html?i=reload`, { waitUntil: "load" });
    await waitMarker(pageS, 8000);
    const sCookieReload = await echoCookies(pageS);
    check("session cookie persists after navigation", sCookieReload.includes("sid=SESSVAL"), sCookieReload);

    // JS-set cookie (document.cookie) must reach the network like an HTTP cookie
    await pageS.evaluate(() => { document.cookie = "jscookie=JSVAL; path=/"; });
    await sleep(800);
    const sCookieJs = await echoCookies(pageS);
    check("JS-set cookie reaches network", sCookieJs.includes("jscookie=JSVAL"), sCookieJs);

    // Third-party iframe must not see the host session's cookies
    await pageS.goto(`${server.origin}/frame-host.html`, { waitUntil: "load" });
    await waitMarker(pageS, 8000);
    await sleep(1000);
    let childCookie = "";
    const diagnostics = [];
    for (let attempt = 0; attempt < 10 && !childCookie; attempt += 1) {
      const frames = pageS.frames();
      const childFrame = frames.find((frame) => frame.url().includes("frame-child"));
      if (!childFrame) {
        diagnostics.push(`attempt ${attempt}: frames=[${frames.map((frame) => frame.url()).join(", ")}]`);
        await sleep(300);
        continue;
      }
      try {
        childCookie = await childFrame.evaluate(() => `${document.cookie}|${location.href}`);
      } catch (error) {
        diagnostics.push(`attempt ${attempt}: eval failed: ${error.message}`);
        await sleep(300);
      }
    }
    check(
      "third-party iframe cannot read session cookies",
      childCookie && !childCookie.includes("sid=SESSVAL") && !childCookie.includes("jscookie=JSVAL"),
      childCookie || diagnostics.join(" | ")
    );

    // A frame must not read session cookies by claiming a forged URL: the
    // service worker must pin the request to the sender frame's real URL.
    const legitCookies = await evalSW(swSession, `handleMessage({ type: "content:getCookies", url: ${JSON.stringify(server.origin + "/echo")} }, { tab: { id: ${tabIdS} }, url: ${JSON.stringify(server.origin + "/echo")} })
      .then((value) => JSON.stringify(value)).catch((error) => JSON.stringify({ ok: false, error: String(error) }))`);
    check("legit frame URL returns session cookies", (JSON.parse(legitCookies).cookies || []).length > 0, legitCookies);
    const forgedCookies = await evalSW(swSession, `handleMessage({ type: "content:getCookies", url: ${JSON.stringify(server.origin + "/echo")} }, { tab: { id: ${tabIdS} }, url: "http://forger.example.com/page" })
      .then((value) => JSON.stringify(value)).catch((error) => JSON.stringify({ ok: false, error: String(error) }))`);
    check("forged frame URL cannot read session cookies", (JSON.parse(forgedCookies).cookies || []).length === 0, forgedCookies);

    // Domain-scoped session: sign in on a sibling subdomain (like accounts.google.com
    // during a gemini.google.com login) and the auth cookie must follow the session.
    const port = new URL(server.origin).port;
    await pageS.goto(`http://localhost:${port}/bench-load.html?i=sib`, { waitUntil: "load" });
    const sibCreate = await evalSW(swSession, `handleMessage({ type: "session:create", tabId: ${tabIdS}, url: ${JSON.stringify(pageS.url())}, mode: "current", name: "Sib" }, {})
      .then((value) => JSON.stringify(value)).catch((error) => JSON.stringify({ ok: false, error: String(error) }))`);
    check("sibling-domain session created", JSON.parse(sibCreate).ok === true, sibCreate);
    await waitMarker(pageS, 8000);
    await pageS.goto(`http://sub.localhost:${port}/set?name=auth&value=SESSB&domain=localhost`, { waitUntil: "load" });
    let sibMarker = true;
    try {
      await waitMarker(pageS, 8000);
    } catch {
      sibMarker = false;
    }
    check("sibling subdomain page is session-patched", sibMarker, "session marker missing on sibling subdomain");
    await sleep(800);
    await pageS.goto(`http://localhost:${port}/bench-load.html?i=sib2`, { waitUntil: "load" });
    await waitMarker(pageS, 8000);
    const sibCookie = await echoCookies(pageS);
    check("sibling subdomain cookie captured into session", sibCookie.includes("auth=SESSB"), sibCookie);

    // Session management handlers: rename and delete (tab ends up unassigned).
    const tempCreate = await evalSW(swSession, `handleMessage({ type: "session:create", tabId: ${tabIdS}, url: ${JSON.stringify(pageS.url())}, mode: "current", name: "Temp" }, {})
      .then((value) => JSON.stringify(value)).catch((error) => JSON.stringify({ ok: false, error: String(error) }))`);
    const tempSession = JSON.parse(tempCreate).session;
    check("management session created", Boolean(tempSession?.id), tempCreate);
    const renameResp = await evalSW(swSession, `handleMessage({ type: "session:rename", sessionId: ${JSON.stringify(tempSession.id)}, name: "Temp2" }, {})
      .then((value) => JSON.stringify(value)).catch((error) => JSON.stringify({ ok: false, error: String(error) }))`);
    check("session renamed", JSON.parse(renameResp)?.ok === true && JSON.parse(renameResp).session.name === "Temp2", renameResp);
    const liveAssignment = await evalSW(swSession, `getTabAssignment(${tabIdS}).then((value) => JSON.stringify(value))`);
    check("live assignment shows new name", JSON.parse(liveAssignment)?.name === "Temp2", liveAssignment);
    const deleteResp = await evalSW(swSession, `handleMessage({ type: "session:delete", sessionId: ${JSON.stringify(tempSession.id)} }, {})
      .then((value) => JSON.stringify(value)).catch((error) => JSON.stringify({ ok: false, error: String(error) }))`);
    check("session deleted", JSON.parse(deleteResp)?.ok === true, deleteResp);
    const afterDelete = await evalSW(swSession, `Promise.all([getAllSessions(), chrome.storage.local.get(null), getTabAssignment(${tabIdS})])
      .then(([sessions, local, assignment]) => JSON.stringify({
        ids: sessions.map((session) => session.id),
        cookieStoreLeft: Boolean(local[${JSON.stringify(`mst:cookies:${tempSession.id}`)}]),
        assignment
      }))`);
    const parsedAfter = JSON.parse(afterDelete);
    check(
      "deleted session fully cleaned up",
      !parsedAfter.ids.includes(tempSession.id) && !parsedAfter.cookieStoreLeft && parsedAfter.assignment === null,
      afterDelete
    );

    // Startup purge: expired cookies must be removed from storage.local stores
    // while live ones are kept. Seeds both into the first session's store.
    const purgeResult = await evalSW(swSession, `(async () => {
      const sessions = await getAllSessions();
      const key = "mst:cookies:" + sessions[0].id;
      const stored = await chrome.storage.local.get(key);
      const store = { ...(stored[key] || {}) };
      store["stale.example.test|/|mstStale"] = { name: "mstStale", domain: "stale.example.test", path: "/", expiresAt: Date.now() - 1000 };
      store["live.example.test|/|mstLive"] = { name: "mstLive", domain: "live.example.test", path: "/", expiresAt: Date.now() + 3600000 };
      await chrome.storage.local.set({ [key]: store });
      await purgeExpiredStoredCookies();
      const after = (await chrome.storage.local.get(key))[key] || {};
      return JSON.stringify({
        staleGone: !after["stale.example.test|/|mstStale"],
        liveKept: Boolean(after["live.example.test|/|mstLive"])
      });
    })()`);
    const parsedPurge = JSON.parse(purgeResult);
    check("expired cookies purged from storage.local", parsedPurge.staleGone && parsedPurge.liveKept, purgeResult);

  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.instance.close(resolve));
    await new Promise((resolve) => thirdParty.instance.close(resolve));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`SMOKE FAILED: ${failures.length} check(s): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("SMOKE OK");
}

main().catch((error) => { console.error(error); process.exit(1); });
