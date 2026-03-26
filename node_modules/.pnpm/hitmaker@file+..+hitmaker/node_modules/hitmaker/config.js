// config.js
// Configuration management with persistent storage

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".hitmaker");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LOCAL_CONFIG_FILE = ".hitmaker.json";

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  MIN_PER_MIN: 1,
  MAX_PER_MIN: 15,
  CONCURRENT: 1,
  METHOD: "GET",
  TIMEOUT_MS: 5000,
  DEVICE_RATIO: 50, // 50 = 50% desktop, 50% mobile (of non-unknown traffic)
  UNKNOWN_RATIO: 0, // % of total traffic that uses unknown/unclassifiable device
  MIN_ACTIVE: 5,
  MAX_ACTIVE: 25,
  IDLE_ODDS: 0.5,
  MIN_IDLE: 2,
  MAX_IDLE: 45,
  UNIQUE_IP_PROB: 0.95,
  PROXY_MODE: "none",           // "none" | "free" | "url" | "service"
  PROXY_SERVICE_URL: "",        // rotating proxy endpoint (service mode) — persists across mode switches
  PROXY_LIST_URL: "",           // proxy list URL or file path (url mode)
  PROXY_REFRESH_MIN: 10,       // how often to refresh free proxy list (minutes)
  URL_PARAMS: [
    { key: "qr", value: "1", probability: 35 },
  ],
};

/**
 * Load local config from .hitmaker.json in the current working directory
 * Returns null if no local config exists
 */
export function loadLocalConfig() {
  const localPath = join(process.cwd(), LOCAL_CONFIG_FILE);
  if (existsSync(localPath)) {
    try {
      return JSON.parse(readFileSync(localPath, "utf-8"));
    } catch (err) {
      console.warn("Failed to load local config:", err.message);
      return null;
    }
  }
  return null;
}

/**
 * Load saved configuration from disk
 * Priority: local (.hitmaker.json) > global (~/.hitmaker/config.json) > defaults
 */
export function loadConfig() {
  let config = { ...DEFAULT_CONFIG };

  // Layer 1: global config
  if (existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      config = { ...config, ...saved };
    } catch (err) {
      console.warn("Failed to load global config, using defaults:", err.message);
    }
  }

  // Layer 2: local config (overrides global)
  const local = loadLocalConfig();
  if (local) {
    config = { ...config, ...local };
  }

  return config;
}

/**
 * Check if a local config file exists in the current directory
 */
export function hasLocalConfig() {
  return existsSync(join(process.cwd(), LOCAL_CONFIG_FILE));
}

/**
 * Save configuration to a local .hitmaker.json in the current directory
 */
export function saveLocalConfig(config) {
  try {
    const localPath = join(process.cwd(), LOCAL_CONFIG_FILE);
    writeFileSync(localPath, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error("Failed to save local config:", err.message);
    return false;
  }
}

/**
 * Save configuration to disk
 */
export function saveConfig(config) {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error("Failed to save config:", err.message);
    return false;
  }
}

/**
 * Merge saved config with environment variables
 * Priority: env vars > saved config > defaults
 */
export function getConfig() {
  const saved = loadConfig();
  
  return {
    MIN_PER_MIN: Number(process.env.MIN_PER_MIN || saved.MIN_PER_MIN),
    MAX_PER_MIN: Number(process.env.MAX_PER_MIN || saved.MAX_PER_MIN),
    CONCURRENT: Number(process.env.CONCURRENT || saved.CONCURRENT),
    METHOD: process.env.METHOD || saved.METHOD || DEFAULT_CONFIG.METHOD,
    TIMEOUT_MS: Number(process.env.TIMEOUT_MS || saved.TIMEOUT_MS),
    DEVICE_RATIO: Number(process.env.DEVICE_RATIO || saved.DEVICE_RATIO),
    UNKNOWN_RATIO: Number(process.env.UNKNOWN_RATIO ?? saved.UNKNOWN_RATIO ?? DEFAULT_CONFIG.UNKNOWN_RATIO),
    MIN_ACTIVE: Number(process.env.MIN_ACTIVE || saved.MIN_ACTIVE),
    MAX_ACTIVE: Number(process.env.MAX_ACTIVE || saved.MAX_ACTIVE),
    IDLE_ODDS: Number(process.env.IDLE_ODDS || saved.IDLE_ODDS),
    MIN_IDLE: Number(process.env.MIN_IDLE || saved.MIN_IDLE),
    MAX_IDLE: Number(process.env.MAX_IDLE || saved.MAX_IDLE),
    UNIQUE_IP_PROB: Number(process.env.UNIQUE_IP_PROB || saved.UNIQUE_IP_PROB),
    PROXY_MODE: process.env.PROXY_MODE || saved.PROXY_MODE || DEFAULT_CONFIG.PROXY_MODE,
    PROXY_SERVICE_URL: process.env.PROXY_SERVICE_URL || process.env.PROXY_URL || saved.PROXY_SERVICE_URL || saved.PROXY_URL || DEFAULT_CONFIG.PROXY_SERVICE_URL,
    PROXY_LIST_URL: process.env.PROXY_LIST_URL || saved.PROXY_LIST_URL || DEFAULT_CONFIG.PROXY_LIST_URL,
    PROXY_REFRESH_MIN: Number(process.env.PROXY_REFRESH_MIN || saved.PROXY_REFRESH_MIN || DEFAULT_CONFIG.PROXY_REFRESH_MIN),
    URL_PARAMS: saved.URL_PARAMS || DEFAULT_CONFIG.URL_PARAMS,
  };
}

/**
 * Config field definitions for the UI
 */
export const CONFIG_FIELDS = [
  // Traffic section
  {
    type: "separator",
    label: "Traffic",
  },
  {
    key: "MIN_PER_MIN",
    label: "Min Hits/Min",
    type: "number",
    min: 1,
    max: 1000,
    step: 1,
    format: (v) => v.toString(),
  },
  {
    key: "MAX_PER_MIN",
    label: "Max Hits/Min",
    type: "number",
    min: 1,
    max: 1000,
    step: 1,
    format: (v) => v.toString(),
  },
  {
    key: "CONCURRENT",
    label: "Concurrent Workers",
    type: "number",
    min: 1,
    max: 10,
    step: 1,
    format: (v) => v.toString(),
  },
  {
    key: "TIMEOUT_MS",
    label: "Timeout (ms)",
    type: "number",
    min: 1000,
    max: 60000,
    step: 1000,
    format: (v) => `${v}ms`,
  },
  // Requests section
  {
    type: "separator",
    label: "Requests",
  },
  {
    key: "METHOD",
    label: "HTTP Method",
    type: "select",
    options: ["GET", "HEAD", "POST"],
    format: (v) => v,
  },
  {
    key: "DEVICE_RATIO",
    label: "Desktop %",
    type: "slider",
    min: 0,
    max: 100,
    step: 5,
    format: (v) => `${v}% desktop / ${100 - v}% mobile`,
  },
  {
    key: "UNKNOWN_RATIO",
    label: "Unknown Device %",
    type: "slider",
    min: 0,
    max: 100,
    step: 5,
    format: (v) => `${v}% unknown / ${100 - v}% desktop+mobile`,
  },
  {
    key: "UNIQUE_IP_PROB",
    label: "Unique IP %",
    type: "slider",
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => `${(v * 100).toFixed(0)}%`,
  },
  {
    key: "URL_PARAMS",
    label: "URL Parameters",
    type: "special",
    format: (v) => {
      const payloadCount = v.reduce((sum, p) => sum + (p.payloads ? p.payloads.length : 0), 0);
      if (payloadCount > 0) {
        return `${v.length} param${v.length !== 1 ? "s" : ""}, ${payloadCount} payload${payloadCount !== 1 ? "s" : ""}`;
      }
      return `${v.length} configured`;
    },
  },
  // Proxy section
  {
    type: "separator",
    label: "Proxy",
  },
  {
    key: "PROXY_MODE",
    label: "Proxy Mode",
    type: "select",
    options: ["none", "free", "url", "service"],
    format: (v) => {
      const labels = { none: "Off (header spoof)", free: "Free proxies", url: "Custom list", service: "Rotating service" };
      return labels[v] || v;
    },
  },
  {
    key: "PROXY_SERVICE_URL",
    label: "Service URL",
    type: "text",
    visibleWhen: (config) => config.PROXY_MODE === "service",
    format: (v) => v ? (v.length > 35 ? v.slice(0, 32) + "..." : v) : "(not set)",
  },
  {
    key: "PROXY_LIST_URL",
    label: "List URL/File",
    type: "text",
    visibleWhen: (config) => config.PROXY_MODE === "url",
    format: (v) => v ? (v.length > 35 ? v.slice(0, 32) + "..." : v) : "(not set)",
  },
  {
    key: "PROXY_REFRESH_MIN",
    label: "Refresh Interval",
    type: "number",
    min: 1,
    max: 60,
    step: 1,
    visibleWhen: (config) => config.PROXY_MODE === "free" || config.PROXY_MODE === "url",
    format: (v) => `${v} min`,
  },
  // Schedule section
  {
    type: "separator",
    label: "Schedule",
  },
  {
    key: "MIN_ACTIVE",
    label: "Active Min",
    type: "number",
    min: 1,
    max: 120,
    step: 1,
    format: (v) => `${v} min`,
  },
  {
    key: "MAX_ACTIVE",
    label: "Active Max",
    type: "number",
    min: 1,
    max: 120,
    step: 1,
    format: (v) => `${v} min`,
  },
  {
    key: "IDLE_ODDS",
    label: "Idle Chance",
    type: "slider",
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => `${(v * 100).toFixed(0)}%`,
  },
  {
    key: "MIN_IDLE",
    label: "Idle Min",
    type: "number",
    min: 1,
    max: 120,
    step: 1,
    format: (v) => `${v} min`,
  },
  {
    key: "MAX_IDLE",
    label: "Idle Max",
    type: "number",
    min: 1,
    max: 2880,
    step: 1,
    format: (v) => `${v} min`,
  },
];

