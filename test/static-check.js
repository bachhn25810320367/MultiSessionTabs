"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert(manifest.manifest_version === 3, "Manifest must use MV3");
assert(manifest.background?.service_worker === "service-worker.js", "Service worker missing");
assert(manifest.content_scripts?.[0]?.world === "ISOLATED", "Content script bridge must run in ISOLATED world");
assert(manifest.permissions.includes("declarativeNetRequest"), "DNR permission missing");
assert(manifest.permissions.includes("webRequest"), "webRequest permission missing");
assert(manifest.permissions.includes("contextMenus"), "contextMenus permission missing");
assert(manifest.host_permissions.includes("<all_urls>"), "host permissions missing");
assert(manifest.commands?.["switch-session"], "switch-session command missing");

for (const size of ["16", "32", "48", "128"]) {
  const iconPath = manifest.icons?.[size];
  assert(typeof iconPath === "string" && iconPath.length > 0, `manifest.icons["${size}"] missing`);
  assert(fs.existsSync(path.join(root, iconPath)), `icon file missing: ${iconPath}`);
  const actionIconPath = manifest.action?.default_icon?.[size];
  assert(typeof actionIconPath === "string" && actionIconPath.length > 0, `action.default_icon["${size}"] missing`);
}


for (const file of ["service-worker.js", "content-script.js", "popup.html", "popup.js", "popup.css"]) {
  assert(fs.existsSync(path.join(root, file)), `${file} missing`);
}

const serviceWorker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
assert(serviceWorker.includes('header: "Cookie", operation: "remove"'), "Cookie removal rule missing");
assert(serviceWorker.includes("removeBrowserCookie"), "browser Set-Cookie cleanup missing");
assert(serviceWorker.includes('header: "Cookie", operation: "set"'), "virtual Cookie set rule missing");
for (const token of ["chrome.scripting.executeScript", "document", "localStorage", "sessionStorage", "indexedDB", "caches", "BroadcastChannel", "Worker"]) {
  assert(serviceWorker.includes(token), `${token} page patch missing`);
}
assert(!/chrome-extension:\/\/[a-p]{32}/.test(serviceWorker), "hardcoded extension URL leaked");

const contentScript = fs.readFileSync(path.join(root, "content-script.js"), "utf8");
assert(contentScript.includes("postMessage"), "page bridge missing");
assert(contentScript.includes("chrome.runtime.sendMessage"), "content bridge must forward cookie writes to background");
assert(!contentScript.includes("storage.session"), "content bridge must not access storage.session directly");
assert(contentScript.includes("content:setCookie"), "content bridge must forward setCookie");
assert(contentScript.includes("content:deleteCookie"), "content bridge must forward deleteCookie");
assert(!contentScript.includes('}, "*")'), "page bridge must not postMessage to targetOrigin \"*\"");

assert(!serviceWorker.includes('...message }, "*")'), "page context bridge must not postMessage to targetOrigin \"*\"");
assert(/getCookiesFromContent[\s\S]{0,600}sender\.url/.test(serviceWorker), "getCookiesFromContent must pin the URL to the sender frame");
assert(serviceWorker.includes("chrome.contextMenus.create"), "popup-open context menu missing");
assert(serviceWorker.includes("chrome.contextMenus.onClicked"), "context menu click handler missing");
assert(serviceWorker.includes("switchToNextSession"), "switch-to-next-session handler missing");

const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");

assert(manifest.default_locale === "en", "Manifest must declare default_locale en");
for (const locale of ["en", "vi"]) {
  assert(fs.existsSync(path.join(root, "_locales", locale, "messages.json")), `_locales/${locale}/messages.json missing`);
}
const enMessages = JSON.parse(fs.readFileSync(path.join(root, "_locales", "en", "messages.json"), "utf8"));
const viMessages = JSON.parse(fs.readFileSync(path.join(root, "_locales", "vi", "messages.json"), "utf8"));
assert(Object.keys(enMessages).length > 0, "en messages must not be empty");
assert(Object.keys(viMessages).sort().join(",") === Object.keys(enMessages).sort().join(","), "en and vi message keys must match");
assert(popupHtml.includes("data-i18n"), "popup.html must reference i18n messages via data-i18n attributes");
assert(popupJs.includes("chrome.i18n.getMessage"), "popup.js must resolve strings via chrome.i18n.getMessage");

const popupCss = fs.readFileSync(path.join(root, "popup.css"), "utf8");
assert(popupJs.includes("tabCount"), "popup.js must show the per-session tab count");
assert(popupJs.includes('"active"'), "popup.js must highlight the active session via an active class");
assert(popupCss.includes("li.active"), "popup.css must style the active session row");
assert(popupCss.includes(".name::after"), "popup.css must show a rename affordance on the session name");
assert(popupHtml.includes("reload-on-delete"), "popup.html must offer the delete reload toggle");
assert(popupJs.includes("reloadOnDelete"), "popup.js must read the delete reload toggle");
assert(/message\.reload !== false/.test(serviceWorker), "delete must reload tabs unless the caller opts out");

console.log("static checks ok");

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}
