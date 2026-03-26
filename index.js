#!/usr/bin/env node
// zlink-demon — monitors a workspace for new links and generates traffic
// Single-file daemon with logUpdate UI (same pattern as hitmaker)

import readline from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import logUpdate from "log-update";
import chalk from "chalk";
import { TrafficSimulator } from "hitmaker/simulator";

// ============================================================================
// Config & Storage
// ============================================================================

const DATA_DIR = join(homedir(), ".zlink-demon");
const KEYS_FILE = join(DATA_DIR, "keys.json");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadKeys() {
  try {
    return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveKeys(keys) {
  ensureDataDir();
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

// ============================================================================
// API helpers
// ============================================================================

async function apiRequest(apiUrl, path, apiKey, workspaceSlug = null) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (workspaceSlug) headers["X-Workspace"] = workspaceSlug;
  const res = await fetch(`${apiUrl}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const API_ENVIRONMENTS = [
  { name: "dev", url: "https://dev-api.zeblink.io/api" },
  { name: "prod", url: "https://api.zeblink.io/api" },
];

// ============================================================================
// Traffic Pool
// ============================================================================

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPool() {
  const simulators = new Map();
  let isRunning = false;
  let totalHits = 0;
  let totalErrors = 0;
  let phase = "waiting"; // waiting | active | idle
  let phaseRate = 0;
  let phaseEnd = 0;

  async function addUrl(shortLink) {
    if (simulators.has(shortLink)) return;
    const sim = new TrafficSimulator(shortLink);
    await sim.proxyPool.init();
    simulators.set(shortLink, sim);
  }

  async function start() {
    isRunning = true;
    const defaults = new TrafficSimulator("https://example.com").config;

    while (isRunning) {
      if (simulators.size === 0) {
        phase = "waiting";
        await sleep(1000);
        continue;
      }

      const rate = randInt(defaults.MIN_PER_MIN, defaults.MAX_PER_MIN);
      const activeMinutes = randInt(defaults.MIN_ACTIVE, defaults.MAX_ACTIVE);
      phaseEnd = Date.now() + activeMinutes * 60_000;
      phase = "active";
      phaseRate = rate;

      while (Date.now() < phaseEnd && isRunning) {
        if (simulators.size === 0) { await sleep(1000); continue; }
        const entries = Array.from(simulators.values());
        const sim = entries[Math.floor(Math.random() * entries.length)];
        try {
          const result = await sim.doHit(1);
          totalHits++;
          if (!result.success) totalErrors++;
        } catch { totalErrors++; }
        const intervalMs = 60_000 / rate;
        const jitter = intervalMs * (Math.random() * 0.2 - 0.1);
        await sleep(Math.max(50, intervalMs + jitter));
      }

      if (Math.random() < defaults.IDLE_ODDS && isRunning) {
        const idleMinutes = randInt(defaults.MIN_IDLE, defaults.MAX_IDLE);
        phaseEnd = Date.now() + idleMinutes * 60_000;
        phase = "idle";
        phaseRate = 0;
        while (Date.now() < phaseEnd && isRunning) await sleep(1000);
      }
    }
  }

  function stop() { isRunning = false; }

  function getStats() {
    const perUrl = {};
    for (const [url, sim] of simulators) {
      const s = sim.getStats();
      perUrl[url] = { hits: s.hitCounter, uniqueIps: s.uniqueIps };
    }
    const phaseRemaining = Math.max(0, Math.ceil((phaseEnd - Date.now()) / 60_000));
    return { totalHits, totalErrors, urlCount: simulators.size, perUrl, phase, phaseRate, phaseRemaining };
  }

  return { addUrl, start, stop, getStats };
}

// ============================================================================
// Poller
// ============================================================================

function createPoller(apiUrl, apiKey, workspaceSlugs) {
  const seenIds = new Set();
  const timestamps = {};
  for (const slug of workspaceSlugs) timestamps[slug] = new Date().toISOString();

  async function poll() {
    const newLinks = [];
    for (const slug of workspaceSlugs) {
      try {
        const params = new URLSearchParams({
          createdAfter: timestamps[slug], sortBy: "createdAt", sortOrder: "asc", limit: "100",
        });
        const body = await apiRequest(apiUrl, `/links?${params}`, apiKey, slug);
        const links = body.data || [];
        for (const link of links) {
          if (seenIds.has(link.id)) continue;
          seenIds.add(link.id);
          newLinks.push({ id: link.id, shortLink: link.shortLink, workspace: slug });
        }
        if (links.length > 0) timestamps[slug] = links[links.length - 1].createdAt;
      } catch {}
    }
    return newLinks;
  }

  return { poll, getSeenCount: () => seenIds.size };
}

// ============================================================================
// UI State Machine
// ============================================================================

// States: key_select, key_input, key_validating, workspace_select, duration_select, running
let state = "key_select";
let textInput = "";
let cursor = 0;
let statusMessage = "";
let errorMessage = "";

// Config
let apiUrl = null;
let apiKey = null;
let userInfo = null;
let selectedWorkspaces = [];
let timeoutMinutes = 0;

// Key selection
const savedKeys = loadKeys();
const keyChoices = () => [
  ...savedKeys.map((k) => ({ label: k.label, env: k.env, value: k })),
  { label: "+ Add new API key", env: "", value: null },
];

// Workspace selection
let workspaceChoices = [];
let wsSelected = new Set();

// Duration
const DURATIONS = [
  { label: "5 minutes", value: 5 },
  { label: "15 minutes", value: 15 },
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "3 hours", value: 180 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
  { label: "Indefinitely", value: 0 },
];

// Running state
let pool = null;
let poller = null;
let logs = [];
let startTime = null;
let timeoutTimer = null;

function addLog(msg) {
  logs.push(msg);
  if (logs.length > 50) logs.shift();
}

// ============================================================================
// Renderers
// ============================================================================

function renderHeader() {
  return chalk.bgMagenta.white.bold(" 😈 ZLINK-DEMON ") + chalk.dim("  v0.1.0");
}

function renderKeySelect() {
  const lines = ["", renderHeader(), ""];
  const choices = keyChoices();

  lines.push(chalk.bold("  Select an API key"));
  lines.push("");

  choices.forEach((c, i) => {
    const prefix = i === cursor ? chalk.cyan("  ❯ ") : "    ";
    const envTag = c.env ? chalk.dim(` (${c.env})`) : "";
    if (i === cursor) {
      lines.push(prefix + chalk.white(c.label) + envTag);
    } else {
      lines.push(prefix + chalk.gray(c.label) + envTag);
    }
  });

  lines.push("");
  if (errorMessage) lines.push(chalk.red(`  ${errorMessage}`));
  lines.push("");
  lines.push("  " + chalk.white("↑/↓") + chalk.gray(" Navigate") + "  " + chalk.white("Enter") + chalk.gray(" Select") + "  " + chalk.white("D") + chalk.gray(" Delete") + "  " + chalk.white("Q") + chalk.gray(" Quit"));
  lines.push("");
  return lines.join("\n");
}

function renderKeyInput() {
  const lines = ["", renderHeader(), ""];
  lines.push(chalk.bold("  Paste an API key"));
  lines.push("");
  lines.push("  " + chalk.bgGray.white(` ${textInput || " "}_ `));
  lines.push("");
  if (statusMessage) lines.push(chalk.dim(`  ${statusMessage}`));
  if (errorMessage) lines.push(chalk.red(`  ${errorMessage}`));
  lines.push("");
  lines.push("  " + chalk.white("Enter") + chalk.gray(" Validate") + "  " + chalk.white("Esc") + chalk.gray(" Back"));
  lines.push("");
  return lines.join("\n");
}

function renderValidating() {
  const lines = ["", renderHeader(), ""];
  lines.push("");
  lines.push(chalk.dim(`  ${statusMessage || "Validating..."}`));
  lines.push("");
  return lines.join("\n");
}

function renderWorkspaceSelect() {
  const lines = ["", renderHeader(), ""];
  lines.push(chalk.bold("  Select workspace(s)"));
  lines.push("");

  workspaceChoices.forEach((ws, i) => {
    const prefix = i === cursor ? chalk.cyan("  ❯ ") : "    ";
    const check = wsSelected.has(i) ? chalk.green("✓") : chalk.dim("○");
    if (i === cursor) {
      lines.push(prefix + check + " " + chalk.white(ws.name) + chalk.dim(` (${ws.slug})`));
    } else {
      lines.push(prefix + check + " " + chalk.gray(ws.name) + chalk.dim(` (${ws.slug})`));
    }
  });

  lines.push("");
  lines.push("  " + chalk.white("↑/↓") + chalk.gray(" Navigate") + "  " + chalk.white("Space") + chalk.gray(" Toggle") + "  " + chalk.white("Enter") + chalk.gray(" Confirm") + "  " + chalk.white("A") + chalk.gray(" All"));
  lines.push("");
  return lines.join("\n");
}

function renderDurationSelect() {
  const lines = ["", renderHeader(), ""];
  lines.push(chalk.bold("  How long should it run?"));
  lines.push("");

  DURATIONS.forEach((d, i) => {
    const prefix = i === cursor ? chalk.cyan("  ❯ ") : "    ";
    if (i === cursor) {
      lines.push(prefix + chalk.white(d.label));
    } else {
      lines.push(prefix + chalk.gray(d.label));
    }
  });

  lines.push("");
  lines.push("  " + chalk.white("↑/↓") + chalk.gray(" Navigate") + "  " + chalk.white("Enter") + chalk.gray(" Select"));
  lines.push("");
  return lines.join("\n");
}

function renderRunning() {
  const stats = pool ? pool.getStats() : { totalHits: 0, totalErrors: 0, urlCount: 0, perUrl: {}, phase: "starting", phaseRate: 0, phaseRemaining: 0 };
  const lines = ["", renderHeader()];

  // Status bar
  const elapsed = startTime ? Math.floor((Date.now() - startTime) / 60_000) : 0;
  const remaining = timeoutMinutes > 0 ? Math.max(0, timeoutMinutes - elapsed) : null;
  const timeLabel = remaining !== null ? `${remaining}min left` : `${elapsed}min elapsed`;

  const phaseIcon = stats.phase === "active" ? chalk.green("●") : stats.phase === "idle" ? chalk.yellow("○") : chalk.gray("◌");
  const phaseLabel = stats.phase === "active"
    ? chalk.green(`Active ~${stats.phaseRate}/min (${stats.phaseRemaining}min)`)
    : stats.phase === "idle"
      ? chalk.yellow(`Idle (${stats.phaseRemaining}min)`)
      : chalk.gray("Waiting for links...");

  lines.push(
    chalk.gray(`  ${phaseIcon} ${phaseLabel}`) +
    chalk.gray(` │ URLs: ${stats.urlCount}`) +
    chalk.gray(` │ Hits: ${stats.totalHits}`) +
    (stats.totalErrors > 0 ? chalk.red(` │ Err: ${stats.totalErrors}`) : "") +
    chalk.gray(` │ ${timeLabel}`),
  );

  // Per-URL table
  lines.push("");
  if (stats.urlCount > 0) {
    lines.push(
      chalk.gray("  ") +
      chalk.gray(pad("URL", 35)) +
      chalk.gray(pad("HITS", 8)) +
      chalk.gray("IPs"),
    );
    lines.push(chalk.gray("  " + "─".repeat(55)));

    for (const [url, s] of Object.entries(stats.perUrl)) {
      const shortUrl = url.replace(/^https?:\/\//, "").slice(0, 33);
      lines.push(
        "  " +
        chalk.blue(pad(shortUrl, 35)) +
        chalk.yellow(pad(s.hits, 8)) +
        chalk.gray(s.uniqueIps),
      );
    }
  } else {
    lines.push(chalk.gray("  Waiting for new links to appear..."));
  }

  // Recent logs
  lines.push("");
  lines.push(chalk.gray("  " + "─".repeat(55)));
  const recentLogs = logs.slice(-4);
  for (const log of recentLogs) {
    lines.push(chalk.gray(`  ${log.slice(0, 70)}`));
  }
  if (recentLogs.length === 0) {
    lines.push(chalk.gray("  Polling for new links every 5s..."));
  }

  lines.push("");
  lines.push("  " + chalk.white("Q") + chalk.gray(" Quit"));
  lines.push("");
  return lines.join("\n");
}

function render() {
  switch (state) {
    case "key_select": logUpdate(renderKeySelect()); break;
    case "key_input": logUpdate(renderKeyInput()); break;
    case "key_validating": logUpdate(renderValidating()); break;
    case "workspace_select": logUpdate(renderWorkspaceSelect()); break;
    case "duration_select": logUpdate(renderDurationSelect()); break;
    case "running": logUpdate(renderRunning()); break;
  }
}

// ============================================================================
// State transitions
// ============================================================================

async function validateAndProceed(key) {
  state = "key_validating";
  errorMessage = "";

  for (const env of API_ENVIRONMENTS) {
    statusMessage = `Trying ${env.name}...`;
    render();

    try {
      userInfo = await apiRequest(env.url, "/me", key);
      apiUrl = env.url;
      apiKey = key;

      // Auto-save
      const userName = userInfo.name || userInfo.email.split("@")[0];
      const label = `${userName} (${env.name})`;
      const keys = loadKeys();
      const entry = { label, key, email: userInfo.email, env: env.name, apiUrl };
      const existing = keys.findIndex((k) => k.key === key);
      if (existing >= 0) keys[existing] = entry;
      else keys.push(entry);
      saveKeys(keys);

      // Reload savedKeys
      savedKeys.length = 0;
      savedKeys.push(...loadKeys());

      transitionToWorkspaceSelect();
      return;
    } catch {
      // Try next env
    }
  }

  errorMessage = "Key not valid on dev or prod";
  state = "key_input";
  render();
}

async function validateStoredKey(stored) {
  state = "key_validating";
  statusMessage = `Validating on ${stored.env}...`;
  errorMessage = "";
  render();

  try {
    userInfo = await apiRequest(stored.apiUrl, "/me", stored.key);
    apiUrl = stored.apiUrl;
    apiKey = stored.key;
    transitionToWorkspaceSelect();
  } catch {
    errorMessage = "Key expired or invalid. Delete it and add a new one.";
    state = "key_select";
    render();
  }
}

function transitionToWorkspaceSelect() {
  workspaceChoices = userInfo.workspaces || [];
  wsSelected.clear();

  if (workspaceChoices.length === 0) {
    errorMessage = "No workspaces found";
    state = "key_select";
    render();
    return;
  }

  if (workspaceChoices.length === 1) {
    // Auto-select single workspace
    wsSelected.add(0);
    selectedWorkspaces = [workspaceChoices[0]];
    cursor = 3; // default to 30 min
    state = "duration_select";
    render();
    return;
  }

  cursor = 0;
  state = "workspace_select";
  render();
}

function startDaemon() {
  const workspaceSlugs = selectedWorkspaces.map((ws) => ws.slug);

  logUpdate.clear();
  state = "running";
  startTime = Date.now();

  poller = createPoller(apiUrl, apiKey, workspaceSlugs);
  pool = createPool();

  // Suppress doHit console output (we show stats in our dashboard instead)
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => {
    const msg = args.join(" ");
    // Capture simulator output as logs but don't print
    if (msg.includes("W1 ") || msg.includes("[pool]")) {
      addLog(msg.slice(0, 100));
      return;
    }
    origLog(...args);
  };
  console.warn = (...args) => {
    addLog(args.join(" ").slice(0, 100));
  };

  pool.start().catch((err) => addLog(`Pool error: ${err.message}`));

  // Timeout
  if (timeoutMinutes > 0) {
    timeoutTimer = setTimeout(() => {
      addLog("Timeout reached");
      shutdown();
    }, timeoutMinutes * 60_000);
  }

  // Poll loop
  async function pollLoop() {
    while (state === "running") {
      try {
        const newLinks = await poller.poll();
        for (const link of newLinks) {
          addLog(`NEW: ${link.shortLink} (${link.workspace})`);
          await pool.addUrl(link.shortLink);
        }
      } catch (err) {
        addLog(`Poll error: ${err.message}`);
      }
      await sleep(5000);
    }
  }
  pollLoop();

  // Render loop
  setInterval(render, 1000);
  render();
}

function shutdown() {
  if (pool) pool.stop();
  if (timeoutTimer) clearTimeout(timeoutTimer);

  logUpdate.clear();
  const stats = pool ? pool.getStats() : { totalHits: 0, totalErrors: 0, urlCount: 0, perUrl: {} };
  const elapsed = startTime ? Math.floor((Date.now() - startTime) / 60_000) : 0;

  console.log();
  console.log(chalk.bold("  Summary") + chalk.dim(` (${elapsed} min)`));
  console.log(`  Total hits:   ${stats.totalHits}`);
  console.log(`  Total errors: ${stats.totalErrors}`);
  console.log(`  URLs tracked: ${stats.urlCount}`);
  console.log(`  Links seen:   ${poller ? poller.getSeenCount() : 0}`);

  if (Object.keys(stats.perUrl).length > 0) {
    console.log();
    for (const [url, s] of Object.entries(stats.perUrl)) {
      const shortUrl = url.replace(/^https?:\/\//, "");
      console.log(chalk.dim(`  ${shortUrl}`) + ` — ${s.hits} hits, ${s.uniqueIps} unique IPs`);
    }
  }
  console.log();
  process.exit(0);
}

// ============================================================================
// Keyboard handler (one handler, state-based routing)
// ============================================================================

function handleKeypress(str, key) {
  if (key.name === "c" && key.ctrl) {
    if (state === "running") shutdown();
    else process.exit(0);
  }

  switch (state) {
    case "key_select": {
      const choices = keyChoices();
      if (key.name === "up") {
        cursor = (cursor - 1 + choices.length) % choices.length;
      } else if (key.name === "down") {
        cursor = (cursor + 1) % choices.length;
      } else if (key.name === "return") {
        const choice = choices[cursor];
        if (choice.value === null) {
          // Add new key
          textInput = "";
          errorMessage = "";
          state = "key_input";
        } else {
          validateStoredKey(choice.value);
          return; // async — will render when done
        }
      } else if (str === "d" || str === "D") {
        // Delete selected key
        const choice = choices[cursor];
        if (choice.value) {
          const keys = loadKeys();
          const idx = keys.findIndex((k) => k.key === choice.value.key);
          if (idx >= 0) {
            keys.splice(idx, 1);
            saveKeys(keys);
            savedKeys.length = 0;
            savedKeys.push(...keys);
            if (cursor >= keyChoices().length) cursor = Math.max(0, keyChoices().length - 1);
          }
        }
      } else if (str === "q" || str === "Q") {
        process.exit(0);
      }
      render();
      break;
    }

    case "key_input": {
      if (key.name === "escape") {
        cursor = 0;
        state = "key_select";
        errorMessage = "";
      } else if (key.name === "return") {
        if (textInput.trim()) {
          validateAndProceed(textInput.trim());
          return; // async
        }
      } else if (key.name === "backspace") {
        textInput = textInput.slice(0, -1);
      } else if (str && !key.ctrl && !key.meta && str.length === 1) {
        textInput += str;
      }
      render();
      break;
    }

    case "workspace_select": {
      if (key.name === "up") {
        cursor = (cursor - 1 + workspaceChoices.length) % workspaceChoices.length;
      } else if (key.name === "down") {
        cursor = (cursor + 1) % workspaceChoices.length;
      } else if (str === " ") {
        if (wsSelected.has(cursor)) wsSelected.delete(cursor);
        else wsSelected.add(cursor);
      } else if (str === "a" || str === "A") {
        if (wsSelected.size === workspaceChoices.length) wsSelected.clear();
        else workspaceChoices.forEach((_, i) => wsSelected.add(i));
      } else if (key.name === "return") {
        if (wsSelected.size === 0) wsSelected.add(cursor);
        selectedWorkspaces = Array.from(wsSelected).map((i) => workspaceChoices[i]);
        cursor = 3; // default 30 min
        state = "duration_select";
      }
      render();
      break;
    }

    case "duration_select": {
      if (key.name === "up") {
        cursor = (cursor - 1 + DURATIONS.length) % DURATIONS.length;
      } else if (key.name === "down") {
        cursor = (cursor + 1) % DURATIONS.length;
      } else if (key.name === "return") {
        timeoutMinutes = DURATIONS[cursor].value;
        startDaemon();
        return;
      }
      render();
      break;
    }

    case "running": {
      if (str === "q" || str === "Q") {
        shutdown();
      }
      break;
    }
  }
}

// ============================================================================
// Entry point
// ============================================================================

if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", handleKeypress);
} else {
  console.error("zlink-demon requires a terminal (TTY)");
  process.exit(1);
}

// Handle no saved keys — go straight to key input
if (savedKeys.length === 0) {
  state = "key_input";
  textInput = "";
}

render();
