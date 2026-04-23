const storageKey = "claude-gateway-ui";

const els = {
  userId: document.getElementById("userId"),
  skillSelect: document.getElementById("skillSelect"),
  refreshSkillsBtn: document.getElementById("refreshSkillsBtn"),
  refreshSessionsBtn: document.getElementById("refreshSessionsBtn"),
  newSessionBtn: document.getElementById("newSessionBtn"),
  healthBtn: document.getElementById("healthBtn"),
  clearChatBtn: document.getElementById("clearChatBtn"),
  sessionList: document.getElementById("sessionList"),
  sessionIdLabel: document.getElementById("sessionIdLabel"),
  livezLabel: document.getElementById("livezLabel"),
  readyzLabel: document.getElementById("readyzLabel"),
  messageList: document.getElementById("messageList"),
  composerForm: document.getElementById("composerForm"),
  messageInput: document.getElementById("messageInput"),
  streamMode: document.getElementById("streamMode"),
  sendBtn: document.getElementById("sendBtn"),
  activityIndicator: document.getElementById("activityIndicator"),
  activityText: document.getElementById("activityText"),
  messageTemplate: document.getElementById("messageTemplate"),
};

const state = {
  sessionId: "",
  skills: [],
  sending: false,
};

bootstrap().catch((error) => {
  appendMessage("error", `初始化失败: ${error.message}`);
});

async function bootstrap() {
  restoreState();
  bindEvents();
  await refreshHealth();
  await refreshSkills();
  await refreshSessions();
  if (state.sessionId) {
    await loadSession(state.sessionId, false);
  }
}

function bindEvents() {
  els.refreshSkillsBtn.addEventListener("click", () => {
    refreshSkills().catch(showError);
  });

  els.refreshSessionsBtn.addEventListener("click", () => {
    refreshSessions().catch(showError);
  });

  els.newSessionBtn.addEventListener("click", () => {
    createSession().catch(showError);
  });

  els.healthBtn.addEventListener("click", () => {
    refreshHealth().catch(showError);
  });

  els.clearChatBtn.addEventListener("click", () => {
    els.messageList.innerHTML = "";
  });

  els.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.sending) {
      return;
    }

    const message = els.messageInput.value.trim();
    if (!message) {
      return;
    }

    if (!state.sessionId) {
      await createSession();
    }

    appendMessage("user", message);
    els.messageInput.value = "";

    state.sending = true;
    setActivity("正在连接 Claude…");
    updateSendState();
    try {
      if (els.streamMode.checked) {
        await sendStreamMessage(message);
      } else {
        await sendMessage(message);
      }
    } catch (error) {
      setActivity("请求失败");
      showError(error);
    } finally {
      state.sending = false;
      updateSendState();
    }
  });

  [els.userId, els.streamMode].forEach((element) => {
    element.addEventListener("change", persistState);
    element.addEventListener("input", persistState);
  });

  els.skillSelect.addEventListener("change", persistState);
  els.userId.addEventListener("change", async () => {
    state.sessionId = "";
    els.sessionIdLabel.textContent = "未创建";
    els.messageList.innerHTML = "";
    persistState();
    await refreshSessions();
  });
}

async function refreshSkills() {
  const response = await apiFetch("/api/v1/skills");
  const payload = await response.json();
  state.skills = payload.skills || [];

  const currentValue = els.skillSelect.value;
  els.skillSelect.innerHTML = "";
  for (const skill of state.skills) {
    const option = document.createElement("option");
    option.value = skill.name;
    option.textContent = `${skill.name} - ${skill.description}`;
    els.skillSelect.appendChild(option);
  }

  if (state.skills.some((skill) => skill.name === currentValue)) {
    els.skillSelect.value = currentValue;
  }

  persistState();
}

async function refreshHealth() {
  const [livez, readyz] = await Promise.allSettled([
    fetchJson("/livez"),
    fetchJson("/readyz"),
  ]);

  els.livezLabel.textContent = livez.status === "fulfilled" ? JSON.stringify(livez.value) : "error";
  els.readyzLabel.textContent = readyz.status === "fulfilled" ? JSON.stringify(readyz.value) : "error";
}

async function createSession() {
  const response = await apiFetch("/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      skill: els.skillSelect.value || undefined,
    }),
  });

  const payload = await response.json();
  state.sessionId = payload.sessionId;
  els.sessionIdLabel.textContent = payload.sessionId;
  appendMessage(
    "system",
    `已创建 session\nskill: ${payload.skill}\nexpiresAt: ${payload.expiresAt}`,
  );
  persistState();
  await refreshSessions();
}

async function sendMessage(message) {
  const waitingEntry = appendMessage("assistant", "", "waiting", ["pending", "waiting"]);
  waitingEntry.body.innerHTML = createTypingMarkup("Claude 正在思考");
  const response = await apiFetch(`/api/v1/sessions/${state.sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      message,
      skill: els.skillSelect.value || undefined,
    }),
  });

  const payload = await response.json();
  waitingEntry.element.classList.remove("pending", "waiting");
  waitingEntry.extra.textContent =
    `finish=${payload.finishReason} cost=${payload.usage.totalCostUsd.toFixed(6)} turns=${payload.usage.numTurns}`;
  waitingEntry.body.textContent = normalizeMessageText(payload.content);
  await refreshSessions();
}

async function sendStreamMessage(message) {
  setActivity("正在等待 Claude 首条响应…");
  const response = await apiFetch(`/api/v1/sessions/${state.sessionId}/messages/stream`, {
    method: "POST",
    body: JSON.stringify({
      message,
      skill: els.skillSelect.value || undefined,
    }),
  });

  if (!response.body) {
    throw new Error("Streaming response body is unavailable.");
  }

  let assistantEntry = appendMessage("assistant", "", "streaming", ["pending", "waiting"]);
  assistantEntry.body.innerHTML = createTypingMarkup("Claude 正在思考");
  let usageText = "";
  let hasDelta = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const event = parseSseEvent(part);
      if (!event) {
        continue;
      }

      if (event.event === "delta") {
        if (!hasDelta) {
          assistantEntry.body.textContent = "";
          assistantEntry.element.classList.remove("waiting");
          hasDelta = true;
        }
        setActivity("Claude 正在流式回复…");
        assistantEntry.body.textContent += event.data.delta || "";
      } else if (event.event === "usage") {
        usageText = `cost=${Number(event.data.totalCostUsd || 0).toFixed(6)} turns=${event.data.numTurns || 0}`;
      } else if (event.event === "start") {
        setActivity("Claude 已连接，正在生成内容…");
      } else if (event.event === "done") {
        assistantEntry.element.classList.remove("pending", "waiting");
        assistantEntry.extra.textContent = `${event.data.finishReason || "done"} ${usageText}`.trim();
        await refreshSessions();
      } else if (event.event === "error") {
        assistantEntry.element.classList.remove("pending", "waiting");
        assistantEntry.element.classList.add("error");
        assistantEntry.extra.textContent = event.data.code || "error";
        if (!assistantEntry.body.textContent) {
          assistantEntry.body.textContent = event.data.message || "Streaming failed.";
        }
      }
    }
  }
}

async function refreshSessions() {
  if (!els.userId.value.trim()) {
    els.sessionList.innerHTML = "";
    return;
  }

  const response = await apiFetch("/api/v1/sessions");
  const payload = await response.json();
  renderSessionList(payload.sessions || []);
}

function renderSessionList(sessions) {
  els.sessionList.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "session-item";
    empty.textContent = "当前用户名下还没有历史会话";
    els.sessionList.appendChild(empty);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `session-item${session.sessionId === state.sessionId ? " active" : ""}`;
    item.innerHTML = `
      <div class="session-item-title">${escapeHtml(session.title || session.sessionId)}</div>
      <div class="session-item-meta">${escapeHtml(session.skill)} · ${session.messageCount} 条</div>
      <div class="session-item-preview">${escapeHtml(session.lastMessagePreview || "暂无消息")}</div>
    `;
    item.addEventListener("click", () => {
      loadSession(session.sessionId, true).catch(showError);
    });
    els.sessionList.appendChild(item);
  }
}

async function loadSession(sessionId, announce = true) {
  const response = await apiFetch(`/api/v1/sessions/${sessionId}`);
  const payload = await response.json();
  state.sessionId = payload.sessionId;
  els.sessionIdLabel.textContent = payload.sessionId;
  els.skillSelect.value = payload.skill;
  els.messageList.innerHTML = "";

  for (const message of payload.messages || []) {
    appendMessage(message.role, message.content, formatMessageMeta(message.meta));
  }

  if (announce) {
    appendMessage("system", `已加载历史会话：${payload.title}`);
  }

  persistState();
  renderSessionList((await (await apiFetch("/api/v1/sessions")).json()).sessions || []);
}

function formatMessageMeta(meta) {
  if (!meta) {
    return "";
  }
  return Object.entries(meta)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function parseSseEvent(chunk) {
  const lines = chunk.split("\n");
  let eventName = "";
  let data = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    }
    if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    }
  }

  if (!eventName) {
    return null;
  }

  return {
    event: eventName,
    data: data ? JSON.parse(data) : {},
  };
}

function appendMessage(role, text, extra = "", extraClasses = []) {
  const fragment = els.messageTemplate.content.cloneNode(true);
  const element = fragment.querySelector(".message");
  const roleEl = fragment.querySelector(".role");
  const extraEl = fragment.querySelector(".extra");
  const bodyEl = fragment.querySelector(".message-body");

  element.classList.add(role, ...extraClasses);
  roleEl.textContent = role;
  extraEl.textContent = extra;
  bodyEl.textContent = normalizeMessageText(text);

  els.messageList.appendChild(fragment);
  els.messageList.scrollTop = els.messageList.scrollHeight;

  return {
    element: els.messageList.lastElementChild,
    extra: els.messageList.lastElementChild.querySelector(".extra"),
    body: els.messageList.lastElementChild.querySelector(".message-body"),
  };
}

function createTypingMarkup(label) {
  return `${escapeHtml(label)} <span class="typing-inline" aria-hidden="true"><i></i><i></i><i></i></span>`;
}

function normalizeMessageText(value) {
  return String(value ?? "").replace(/^\s+|\s+$/g, "");
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }
  return response.json();
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-UI-Request": "1",
      "X-User-Id": els.userId.value.trim(),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return response;
}

function updateSendState() {
  els.sendBtn.disabled = state.sending;
  els.sendBtn.textContent = state.sending ? "发送中..." : "发送";
  els.activityIndicator.hidden = !state.sending;
  if (!state.sending) {
    els.activityText.textContent = "";
  }
}

function showError(error) {
  appendMessage("error", error.message || String(error));
}

function setActivity(text) {
  els.activityIndicator.hidden = false;
  els.activityText.textContent = text;
}

function persistState() {
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      userId: els.userId.value,
      skill: els.skillSelect.value,
      streamMode: els.streamMode.checked,
      sessionId: state.sessionId,
    }),
  );
}

function restoreState() {
  const saved = localStorage.getItem(storageKey);
  const data = saved ? JSON.parse(saved) : {};

  els.userId.value = data.userId || "demo-user";
  els.streamMode.checked = data.streamMode ?? true;
  state.sessionId = data.sessionId || "";
  els.sessionIdLabel.textContent = state.sessionId || "未创建";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
