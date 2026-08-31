"use strict";

const MSG = {
  GET_STATE: "popup:getState",
  CREATE_SESSION: "session:create",
  OPEN_SESSION: "session:open",
  ASSIGN_TAB: "tab:assign",
  CLEAR_TAB: "tab:clear",
  RENAME_SESSION: "session:rename",
  DELETE_SESSION: "session:delete"
};

const elements = {
  site: document.getElementById("site"),
  status: document.getElementById("status"),
  unsupported: document.getElementById("unsupported"),
  controls: document.getElementById("controls"),
  sessions: document.getElementById("sessions"),
  list: document.getElementById("session-list"),
  name: document.getElementById("session-name"),
  newTab: document.getElementById("new-tab"),
  useHere: document.getElementById("use-here"),
  leave: document.getElementById("leave")
};

let state = null;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
elements.newTab.addEventListener("click", () => createSession("new"));
elements.useHere.addEventListener("click", () => createSession("current"));
elements.leave.addEventListener("click", async () => {
  try {
    await send({ type: MSG.CLEAR_TAB });
    window.close();
  } catch (error) {
    renderError(error.message || String(error));
  }
});

async function init() {
  try {
    state = await send({ type: MSG.GET_STATE });
    render();
  } catch (error) {
    renderError(error.message || String(error));
  }
}

async function createSession(mode) {
  try {
    const name = elements.name.value.trim();
    const response = await send({ type: MSG.CREATE_SESSION, mode, name });
    if (response?.ok) window.close();
    else renderError(response?.error || "Failed");
  } catch (error) {
    renderError(error.message || String(error));
  }
}

async function openSession(sessionId) {
  try {
    const response = await send({ type: MSG.OPEN_SESSION, sessionId, url: state.tab.url });
    if (response?.ok) window.close();
    else renderError(response?.error || "Failed");
  } catch (error) {
    renderError(error.message || String(error));
  }
}

async function assignSession(sessionId) {
  try {
    const response = await send({ type: MSG.ASSIGN_TAB, sessionId, url: state.tab.url });
    if (response?.ok) window.close();
    else renderError(response?.error || "Failed");
  } catch (error) {
    renderError(error.message || String(error));
  }
}

function render() {
  if (!state?.ok) {
    renderError(state?.error || "Failed");
    return;
  }
  elements.site.textContent = state.siteKey || "Unsupported page";
  elements.unsupported.hidden = state.supported;
  elements.controls.hidden = !state.supported;
  elements.sessions.hidden = !state.supported || state.sessions.length === 0;
  elements.leave.hidden = !state.assignment;
  elements.status.style.background = state.assignment?.color || "#cbd5e1";
  elements.status.title = state.assignment ? state.assignment.name : "Normal browser session";
  elements.list.textContent = "";

  for (const session of state.sessions) {
    const item = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = session.color;
    const label = document.createElement("span");
    label.innerHTML = `<span class="name"></span><span class="meta"></span>`;
    const nameSpan = label.querySelector(".name");
    nameSpan.textContent = session.name;
    nameSpan.title = "Click to rename";
    nameSpan.addEventListener("click", () => startRename(session, nameSpan));
    label.querySelector(".meta").textContent = `${session.cookieCount} cookies`;
    const open = button("Open", () => openSession(session.id));
    const here = button("Here", () => assignSession(session.id));
    item.append(dot, label, open, here, deleteButton(session));
    elements.list.append(item);
  }
}

function startRename(session, nameSpan) {
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 40;
  input.value = session.name;
  input.className = "rename";
  nameSpan.replaceChildren(input);
  input.focus();
  input.select();
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") render();
    else if (event.key === "Enter") renameSession(session.id, input.value);
  });
  input.addEventListener("blur", () => {
    if (input.isConnected) render();
  });
}

async function renameSession(sessionId, value) {
  try {
    const response = await send({ type: MSG.RENAME_SESSION, sessionId, name: value });
    if (response?.ok) {
      state = await send({ type: MSG.GET_STATE });
      render();
    } else renderError(response?.error || "Failed");
  } catch (error) {
    renderError(error.message || String(error));
  }
}

function deleteButton(session) {
  let confirming = false;
  const node = button("Delete", async () => {
    if (!confirming) {
      confirming = true;
      node.textContent = "Sure?";
      return;
    }
    try {
      const response = await send({ type: MSG.DELETE_SESSION, sessionId: session.id });
      if (response?.ok) {
        state = await send({ type: MSG.GET_STATE });
        render();
      } else renderError(response?.error || "Failed");
    } catch (error) {
      renderError(error.message || String(error));
    }
  });
  node.classList.add("danger-text");
  return node;
}

function renderError(message) {
  elements.site.textContent = message;
  elements.unsupported.hidden = false;
  elements.controls.hidden = true;
  elements.sessions.hidden = true;
}

function button(text, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "small secondary";
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

function send(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Extension background did not respond")), 3000);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}
