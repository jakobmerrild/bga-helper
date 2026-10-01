const BASE = "https://boardgamearena.com";
const CACHE_KEY = "profileCache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day

// Bulk operation pacing (be gentle with the server)
const RANK_DELAY = 500;    // ms between ranking page requests
const THUMB_DELAY = 250;   // ms between red-thumb requests
const FAILURE_BACKOFF = 3000;
const SKIP_AHEAD_START = 500; // first probe offset when searching for the threshold (below mode)
const MAX_CONSECUTIVE_FAILURES = 5;

// Rating types the bulk tool can work with.
//   mode:      value for the `mode` parameter of getRanking.html
//   field:     property of each ranking row holding the value to compare
//   toCutoff:  converts the user's input into the value compared with `field`
//   toDisplay: converts a row's value back into the scale the user types in
const RATINGS = {
  elo: {
    mode: "elo", field: "ranking", label: "ELO",
    toCutoff: (v) => v + 1300, toDisplay: (r) => r - 1300,
    hint: "1300 is added to this value before comparing it with the ranking returned by BGA.",
  },
  arena: {
    mode: "arena", field: "arena", label: "Arena rating",
    toCutoff: (v) => v - 1600, toDisplay: (r) => r + 1600,
    hint: "1600 is subtracted from this value before comparing it with the arena value returned by BGA.",
  },
};

const state = { tabId: null, given: [], taken: [] };
const profiles = new Map(); // id -> { name, avatar, t }
let bulkRunning = false;
let bulkStopRequested = false;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// Search `globalUserInfos.game_list` by display_name_en (filtered in the page; the list is large).
async function findGamesInPage(tabId, query) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [query],
    func: (query) => {
      const list = typeof globalUserInfos !== "undefined" ? globalUserInfos.game_list : null;
      if (!Array.isArray(list)) return null;
      const q = query.toLowerCase();
      return list
        .filter((g) => typeof g.display_name_en === "string" && g.display_name_en.toLowerCase().includes(q))
        .map((g) => ({ id: g.id, name: g.display_name_en }))
        .sort((a, b) => {
          const as = a.name.toLowerCase().startsWith(q), bs = b.name.toLowerCase().startsWith(q);
          return as !== bs ? (as ? -1 : 1) : a.name.localeCompare(b.name);
        });
    },
  });
  return res?.result ?? null;
}

// Generic same-origin request made from inside the BGA tab (cookies + request token).
async function pageRequest(tabId, url, init = {}) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url, init],
    func: async (url, init) => {
      try {
        const token = window.bgaConfig?.requestToken;
        const headers = { ...(init.headers || {}) };
        if (token) headers["X-Request-Token"] = token;
        const r = await fetch(url, { ...init, headers, credentials: "include" });
        return { ok: r.ok, status: r.status, text: await r.text() };
      } catch (e) {
        return { ok: false, status: 0, text: String(e) };
      }
    },
  });
  return res?.result ?? { ok: false, status: 0, text: "No result from page" };
}

// Request that returns the `data` part of a BGA JSON response, or throws.
async function pageJson(tabId, url, init) {
  const r = await pageRequest(tabId, url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let json;
  try { json = JSON.parse(r.text); } catch { throw new Error("Invalid JSON response"); }
  if (String(json.status) !== "1") throw new Error("Server returned an error");
  return json.data;
}

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

/* ---------- Rendering (Red thumbs tab) ---------- */

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
  scheduleFilter();
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

// In-memory filter over the rendered rows (matches the shown name or the user id).
function applyFilter() {
  const q = $("filter").value.trim().toLowerCase();
  for (const kind of ["given", "taken"]) {
    const items = $(kind).querySelectorAll("li[data-id]");
    let shown = 0;
    items.forEach((li) => {
      const hay = `${li.querySelector("a.name").textContent} ${li.dataset.id}`.toLowerCase();
      const match = !q || hay.includes(q);
      li.hidden = !match;
      if (match) shown++;
    });
    $(`${kind}-count`).textContent = q && items.length ? `(${shown} of ${items.length})` : `(${items.length})`;
    $(`${kind}-nomatch`).hidden = !(q && items.length && !shown);
  }
}

// Coalesce filter re-application while profile names are still streaming in.
let filterScheduled = false;
function scheduleFilter() {
  if (filterScheduled || !$("filter").value.trim()) return;
  filterScheduled = true;
  requestAnimationFrame(() => {
    filterScheduled = false;
    applyFilter();
  });
}

function render() {
  renderList("given");
  renderList("taken");
  applyFilter();
}

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

/* ---------- Tabs ---------- */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    $("tab-thumbs").hidden = btn.dataset.tab !== "thumbs";
    $("tab-bulk").hidden = btn.dataset.tab !== "bulk";
  };
});

/* ---------- Bulk red thumb ---------- */

function setBulkStatus(msg, isError = false) {
  const el = $("bulk-status");
  el.textContent = msg || "";
  el.classList.toggle("error", isError);
}

function showStats(s, note = "") {
  $("st-pages").textContent = s.pages;
  $("st-scanned").textContent = s.scanned;
  $("st-matched").textContent = s.matched;
  $("st-thumbed").textContent = s.thumbed;
  $("st-skipped").textContent = s.skipped;
  $("st-failed").textContent = s.failed;
  $("bulk-note").textContent = note;
}

function setBulkRunning(running) {
  bulkRunning = running;
  $("bulk-start").disabled = running;
  $("bulk-stop").disabled = !running;
  for (const id of ["game-query", "game-search", "game-select", "rating-type", "direction", "threshold"]) {
    $(id).disabled = running;
  }
}

async function searchGames() {
  const query = $("game-query").value.trim();
  if (!query) return;
  const select = $("game-select");
  select.hidden = true;
  setBulkStatus("Searching…");
  try {
    const tab = await findBgaTab();
    if (!tab) throw new Error("Open a boardgamearena.com tab first.");
    state.tabId = tab.id;
    const games = await findGamesInPage(tab.id, query);
    if (!games) throw new Error("`globalUserInfos.game_list` not found. Are you logged in? Try reloading the page.");
    select.replaceChildren();
    if (!games.length) {
      setBulkStatus("No games found.", true);
      return;
    }
    for (const g of games) {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.name;
      select.append(opt);
    }
    select.hidden = false;
    setBulkStatus(games.length === 1 ? "" : `${games.length} games found — pick one.`);
  } catch (e) {
    setBulkStatus(`Search failed: ${e.message}`, true);
  }
}

async function fetchRankingPage(tabId, gameId, cfg, start) {
  return pageJson(tabId, "/gamepanel/gamepanel/getRanking.html", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ game: gameId, start: String(start), mode: cfg.mode }).toString(),
  });
}

// "Below" mode: the ranking is sorted high -> low, so instead of walking every page we look for the
// first page whose LAST player is below the cutoff (galloping from SKIP_AHEAD_START, then binary
// search) and begin scanning one page before it. A failed probe is treated as "below", which can
// only make us start earlier than necessary, never skip players.
async function findBelowThresholdStart({ tabId, gameId, cfg, cutoff, stats }) {
  const lastValue = (ranks) => {
    for (let i = ranks.length - 1; i >= 0; i--) {
      const v = parseFloat(ranks[i][cfg.field]);
      if (Number.isFinite(v)) return v;
    }
    return null;
  };

  const probe = async (start) => {
    let ranks = null;
    for (let attempt = 0; attempt < 2 && ranks === null; attempt++) {
      try {
        ranks = (await fetchRankingPage(tabId, gameId, cfg, start)).ranks || [];
      } catch {
        await sleep(FAILURE_BACKOFF);
      }
    }
    stats.pages++;
    showStats(stats, `Locating the threshold in the ranking… (checked player #${start + 1})`);
    await sleep(RANK_DELAY);
    if (!ranks || !ranks.length) return { below: true, size: 0 }; // past the end, or unknown
    const v = lastValue(ranks);
    return { below: v !== null && v < cutoff, size: ranks.length };
  };

  const first = await probe(0);
  if (bulkStopRequested || first.below || first.size === 0) return 0;
  const pageSize = first.size;

  // Gallop: 500, 1000, 2000, ... until a probe lands on a page that is below the cutoff (or past the end).
  let loP = 0;      // page index known to be entirely at/above the cutoff
  let hiP = null;   // page index known to be (at least partly) below it
  let candP = Math.ceil(SKIP_AHEAD_START / pageSize);
  while (hiP === null) {
    const r = await probe(candP * pageSize);
    if (bulkStopRequested) return 0;
    if (r.below || candP * pageSize > 50_000_000) hiP = candP;
    else { loP = candP; candP *= 2; }
  }

  // Binary search for the first such page.
  while (hiP - loP > 1) {
    const midP = Math.floor((loP + hiP) / 2);
    const r = await probe(midP * pageSize);
    if (bulkStopRequested) return 0;
    if (r.below) hiP = midP;
    else loP = midP;
  }

  return Math.max(0, (hiP - 1) * pageSize); // one page of safety margin
}

async function startBulk() {
  const select = $("game-select");
  if (select.hidden || !select.value) {
    setBulkStatus("Search for a game and select it first.", true);
    return;
  }
  const cfg = RATINGS[$("rating-type").value];
  const threshold = parseFloat($("threshold").value);
  if (!Number.isFinite(threshold)) {
    setBulkStatus(`Enter a valid ${cfg.label} threshold.`, true);
    return;
  }
  const mode = $("direction").value; // "above" | "below"
  const gameId = select.value;
  const gameName = select.options[select.selectedIndex].textContent;
  const cutoff = cfg.toCutoff(threshold);

  const ok = confirm(
    `Red thumb ALL players of "${gameName}" with an ${cfg.label} ${mode} ${threshold}?\n\n` +
    `(Ranking ${mode === "above" ? ">" : "<"} ${cutoff})\n\n` +
    `This can affect a large number of players and may take a long time. ` +
    `Requests are paced to avoid overloading the server, and you can press Stop at any time.`
  );
  if (!ok) return;

  const tab = await findBgaTab();
  if (!tab) {
    setBulkStatus("Open a boardgamearena.com tab (and log in) first.", true);
    return;
  }
  const tabId = tab.id;
  state.tabId = tabId;

  const stats = { pages: 0, scanned: 0, matched: 0, thumbed: 0, skipped: 0, failed: 0 };
  const seen = new Set();
  let start = 0;
  let consecutiveFailures = 0;
  let reason = "";

  bulkStopRequested = false;
  setBulkRunning(true);
  setBulkStatus("Running…");
  if (mode === "below") {
    showStats(stats, "Locating the threshold in the ranking…");
    try {
      start = await findBelowThresholdStart({ tabId, gameId, cfg, cutoff, stats });
    } catch {
      start = 0;
    }
    if (start > 0 && !bulkStopRequested) {
      showStats(stats, `Skipped ahead to player #${start + 1}; scanning from there…`);
    }
  } else {
    showStats(stats, "Fetching first ranking page…");
  }

  try {
    outer: while (!bulkStopRequested) {
      let data;
      try {
        data = await fetchRankingPage(tabId, gameId, cfg, start);
      } catch (e) {
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          reason = `Aborted after repeated ranking request failures (${e.message}).`;
          break;
        }
        await sleep(FAILURE_BACKOFF);
        continue;
      }
      consecutiveFailures = 0;
      stats.pages++;

      const ranks = data.ranks || [];
      if (!ranks.length) {
        reason = "Reached the end of the ranking.";
        break;
      }

      let fresh = 0;
      for (const p of ranks) {
        if (bulkStopRequested) break outer;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        fresh++;
        stats.scanned++;

        const ranking = parseFloat(p[cfg.field]);
        if (!Number.isFinite(ranking)) continue;
        const note = `Last player scanned: ${cfg.label} ${cfg.toDisplay(ranking).toFixed(1)}`;

        // The list is sorted by ranking (descending).
        if (mode === "above" && !(ranking > cutoff)) {
          reason = "Reached players at or below the threshold.";
          showStats(stats, note);
          break outer;
        }
        const hit = mode === "above" ? ranking > cutoff : ranking < cutoff;
        if (!hit) {
          showStats(stats, note);
          continue;
        }

        stats.matched++;
        if (state.given.includes(String(p.id))) {
          stats.skipped++;
          showStats(stats, note);
          continue;
        }

        const result = await changeReputationInPage(tabId, String(p.id), -1);
        if (result.ok) {
          stats.thumbed++;
          consecutiveFailures = 0;
          state.given.push(String(p.id));
        } else {
          stats.failed++;
          if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            reason = `Aborted after repeated red-thumb failures (${result.text}).`;
            showStats(stats, note);
            break outer;
          }
          await sleep(FAILURE_BACKOFF);
        }
        showStats(stats, note);
        await sleep(THUMB_DELAY);
      }

      if (!fresh) {
        reason = "No new players were returned; stopping.";
        break;
      }
      start += ranks.length;
      await sleep(RANK_DELAY);
    }
    if (bulkStopRequested) reason = "Stopped by user.";
  } catch (e) {
    reason = `Unexpected error: ${e.message}`;
  } finally {
    setBulkRunning(false);
    setBulkStatus(reason);
    showStats(stats, $("bulk-note").textContent);
    render();
    ensureProfiles(state.given);
  }

  alert(
    `${reason}\n\n` +
    `Players scanned: ${stats.scanned}\n` +
    `Red-thumbed: ${stats.thumbed}\n` +
    `Already red-thumbed (skipped): ${stats.skipped}\n` +
    `Failed: ${stats.failed}`
  );
}

$("game-search").onclick = searchGames;
$("game-query").addEventListener("keydown", (e) => { if (e.key === "Enter") searchGames(); });
function updateRatingLabels() {
  const cfg = RATINGS[$("rating-type").value];
  $("threshold-label").textContent = `${cfg.label} threshold`;
  $("threshold-hint").textContent = cfg.hint;
  $("direction").options[0].textContent = `below the ${cfg.label} threshold`;
  $("direction").options[1].textContent = `above the ${cfg.label} threshold`;
}
$("rating-type").addEventListener("change", updateRatingLabels);
updateRatingLabels();
$("bulk-start").onclick = startBulk;
$("bulk-stop").onclick = () => {
  bulkStopRequested = true;
  setBulkStatus("Stopping…");
};

/* ---------- Init ---------- */

$("refresh").onclick = load;
$("filter").addEventListener("input", applyFilter);
chrome.tabs.onActivated.addListener(() => { if (!bulkRunning) load(); });
loadCache().then(load);
