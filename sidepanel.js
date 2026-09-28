const BASE = "https://boardgamearena.com";
const CACHE_KEY = "profileCache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day

const state = { tabId: null, given: [], taken: [] };
const profiles = new Map(); // id -> { name, avatar, t }

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", isError);
}

/* ---------- Talking to the BGA tab ---------- */

async function findBgaTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url && /^https:\/\/([\w-]+\.)?boardgamearena\.com\//.test(active.url)) return active;
  const [any] = await chrome.tabs.query({ url: ["https://boardgamearena.com/*", "https://*.boardgamearena.com/*"] });
  return any || null;
}

// Runs in the page's own JS world so it can see `globalUserInfos`.
async function readPageInfo(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const info = typeof globalUserInfos !== "undefined" ? globalUserInfos : null;
      if (!info) return null;
      return {
        given: Object.keys(info.red_thumbs_given || {}),
        taken: Object.keys(info.red_thumbs_taken || {}),
      };
    },
  });
  return res?.result ?? null;
}

// Also runs in the page so the request carries the site's cookies/token.
async function changeReputationInPage(tabId, playerId, value) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [playerId, value],
    func: async (playerId, value) => {
      try {
        const token = window.bgaConfig?.requestToken;
        const r = await fetch(
          `/table/table/changeReputation.html?player=${encodeURIComponent(playerId)}&value=${value}`,
          { credentials: "include", headers: token ? { "X-Request-Token": token } : {} }
        );
        const text = await r.text();
        let ok = r.ok;
        try {
          const json = JSON.parse(text);
          if (json && json.status !== undefined) ok = ok && String(json.status) === "1";
        } catch {}
        if (ok && typeof globalUserInfos !== "undefined" && globalUserInfos.red_thumbs_given) {
          if (value === 0) delete globalUserInfos.red_thumbs_given[playerId];
          else globalUserInfos.red_thumbs_given[playerId] = 1;
        }
        return { ok, text: text.slice(0, 300) };
      } catch (e) {
        return { ok: false, text: String(e) };
      }
    },
  });
  return res?.result ?? { ok: false, text: "No result from page" };
}

/* ---------- Profiles (name + avatar) ---------- */

async function loadCache() {
  const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const now = Date.now();
  for (const [id, p] of Object.entries(stored)) {
    if (now - p.t < CACHE_TTL) profiles.set(id, p);
  }
}

function saveCache() {
  chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(profiles) });
}

async function fetchProfile(id) {
  const res = await fetch(`${BASE}/player?id=${encodeURIComponent(id)}`, { credentials: "include" });
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const name = doc.getElementById("real_player_name")?.textContent.trim() || null;
  let avatar = doc.querySelector("#player_avatar img")?.getAttribute("src") || null;
  if (avatar) {
    try {
      const url = new URL(avatar, BASE);
      avatar = url.protocol === "https:" ? url.href : null;
    } catch { avatar = null; }
  }
  return { name, avatar, t: Date.now() };
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    })
  );
}

async function ensureProfiles(ids) {
  const missing = [...new Set(ids)].filter((id) => !profiles.has(id));
  await pool(missing, 4, async (id) => {
    try {
      profiles.set(id, await fetchProfile(id));
    } catch {
      return; // leave placeholder; user can still click the link
    }
    fillRows(id);
  });
  saveCache();
}

/* ---------- Rendering ---------- */

function makeRow(kind, id) {
  const li = document.createElement("li");
  li.dataset.id = id;

  const img = document.createElement("img");
  img.className = "avatar";
  img.alt = "";
  img.referrerPolicy = "no-referrer";

  const a = document.createElement("a");
  a.className = "name";
  a.href = `${BASE}/player?id=${id}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = `Player #${id}`;

  const btn = document.createElement("button");
  if (kind === "given") {
    btn.textContent = "Remove red thumb";
    btn.onclick = () => act(btn, id, 0);
  } else if (state.given.includes(id)) {
    btn.textContent = "Already red-thumbed";
    btn.disabled = true;
  } else {
    btn.textContent = "Red thumb back";
    btn.onclick = () => act(btn, id, -1);
  }

  li.append(img, a, btn);
  return li;
}

function fillRows(id) {
  const p = profiles.get(id);
  if (!p) return;
  document.querySelectorAll(`li[data-id="${id}"]`).forEach((li) => {
    if (p.name) li.querySelector("a.name").textContent = p.name;
    const img = li.querySelector("img.avatar");
    if (p.avatar) img.src = p.avatar;
  });
}

function renderList(kind) {
  const ul = $(kind);
  const ids = state[kind];
  ul.replaceChildren();
  $(`${kind}-count`).textContent = `(${ids.length})`;
  if (!ids.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "None";
    ul.append(li);
    return;
  }
  ids.forEach((id) => ul.append(makeRow(kind, id)));
  ids.forEach(fillRows);
}

function render() {
  renderList("given");
  renderList("taken");
}

/* ---------- Actions ---------- */

async function act(btn, id, value) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  const result = await changeReputationInPage(state.tabId, id, value);
  if (!result.ok) {
    btn.disabled = false;
    btn.textContent = label;
    setStatus(`Request failed for player ${id}: ${result.text}`, true);
    return;
  }
  setStatus("");
  if (value === 0) state.given = state.given.filter((x) => x !== id);
  else if (!state.given.includes(id)) state.given.push(id);
  render();
}

/* ---------- Init ---------- */

async function load() {
  setStatus("Loading…");
  const tab = await findBgaTab();
  if (!tab) {
    state.given = state.taken = [];
    render();
    setStatus("Open a boardgamearena.com tab (and log in) to see your red thumbs.", true);
    return;
  }
  state.tabId = tab.id;
  let info;
  try {
    info = await readPageInfo(tab.id);
  } catch (e) {
    setStatus(`Could not read the page: ${e.message}`, true);
    return;
  }
  if (!info) {
    setStatus("`globalUserInfos` not found on that tab. Are you logged in? Try reloading the page.", true);
    return;
  }
  state.given = info.given;
  state.taken = info.taken;
  render();
  setStatus("");
  await ensureProfiles([...info.given, ...info.taken]);
}

$("refresh").onclick = load;
chrome.tabs.onActivated.addListener(load);
loadCache().then(load);
