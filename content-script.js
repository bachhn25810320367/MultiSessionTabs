"use strict";

(() => {
  if (window.__MULTISESSION_TABS_BRIDGE__) return;
  window.__MULTISESSION_TABS_BRIDGE__ = true;

  const PAGE_SOURCE = "multisession-tabs:page";
  const EXT_SOURCE = "multisession-tabs:extension";
  const MSG = {
    SET_COOKIE: "content:setCookie",
    DELETE_COOKIE: "content:deleteCookie",
    GET_COOKIES: "content:getCookies"
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
    handlePageMessage(event.data).catch((error) => {
      postToPage({ id: event.data.id, type: "response", error: error.message || String(error) });
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "content:cookiesUpdated") {
      postToPage({ type: "cookiesUpdated", cookies: message.cookies || [] });
    }
    return false;
  });

  async function handlePageMessage(message) {
    let response;
    if (message.type === "setCookie") {
      response = await send({ type: MSG.SET_COOKIE, cookie: String(message.cookie || ""), url: location.href });
    } else if (message.type === "deleteCookie") {
      response = await send({ type: MSG.DELETE_COOKIE, name: message.name, domain: message.domain, path: message.path, url: location.href });
    } else if (message.type === "getCookies") {
      response = await send({ type: MSG.GET_COOKIES, url: location.href });
    } else {
      response = { ok: false, error: "Unknown page message" };
    }
    postToPage({ id: message.id, type: "response", response });
  }

  function postToPage(payload) {
    window.postMessage({ source: EXT_SOURCE, ...payload }, "*");
  }

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        resolve(error ? { ok: false, error: error.message } : response);
      });
    });
  }
})();
