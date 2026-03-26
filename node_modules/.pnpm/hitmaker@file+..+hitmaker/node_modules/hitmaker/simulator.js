// simulator.js
// Core traffic simulation engine
// Simulates realistic web traffic with diverse user agents, locations, IPs, and referers

import http from "http";
import https from "https";
import { lookup as dnsLookup } from "dns";
import { WorkerProxyPool, createProxyAgent } from "./proxy.js";

// DNS cache with 60s TTL — avoids repeated getaddrinfo calls
// (macOS .local mDNS resolution adds ~5s per uncached lookup)
const DNS_TTL_MS = 60_000;
const dnsCache = new Map();
function cachedLookup(hostname, options, callback) {
  const key = `${hostname}:${options.family || 0}`;
  const cached = dnsCache.get(key);
  if (cached && Date.now() - cached.ts < DNS_TTL_MS) {
    return process.nextTick(callback, null, cached.address, cached.family);
  }
  dnsLookup(hostname, options, (err, address, family) => {
    if (!err) dnsCache.set(key, { address, family, ts: Date.now() });
    callback(err, address, family);
  });
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Get configuration from environment variables with sensible defaults
 */
export function getConfig() {
  let urlParams = [];
  try {
    urlParams = process.env.URL_PARAMS ? JSON.parse(process.env.URL_PARAMS) : [];
  } catch (e) {
    console.warn("Failed to parse URL_PARAMS:", e.message);
  }
  
  return {
    MIN_PER_MIN: Number(process.env.MIN_PER_MIN || 1),
    MAX_PER_MIN: Number(process.env.MAX_PER_MIN || 100),
    CONCURRENT: Number(process.env.CONCURRENT || 1),
    METHOD: process.env.METHOD || "GET",
    TIMEOUT_MS: Number(process.env.TIMEOUT_MS || 5000),
    DEVICE_RATIO: Number(process.env.DEVICE_RATIO || 50), // 50% desktop by default
    UNKNOWN_RATIO: Number(process.env.UNKNOWN_RATIO || 0),
    MIN_ACTIVE: Number(process.env.MIN_ACTIVE || 5),
    MAX_ACTIVE: Number(process.env.MAX_ACTIVE || 25),
    IDLE_ODDS: Number(process.env.IDLE_ODDS || 0.5), // 50% chance
    MIN_IDLE: Number(process.env.MIN_IDLE || 2),
    MAX_IDLE: Number(process.env.MAX_IDLE || 45),
    UNIQUE_IP_PROB: Number(process.env.UNIQUE_IP_PROB || 0.95), // 95% unique visitors
    PROXY_MODE: process.env.PROXY_MODE || "none",
    PROXY_SERVICE_URL: process.env.PROXY_SERVICE_URL || process.env.PROXY_URL || "",
    PROXY_LIST_URL: process.env.PROXY_LIST_URL || "",
    PROXY_REFRESH_MIN: Number(process.env.PROXY_REFRESH_MIN || 10),
    URL_PARAMS: urlParams,
  };
}

// ============================================================================
// Data Sources for Realistic Traffic Simulation
// ============================================================================

/**
 * Desktop user agents
 */
const DESKTOP_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
];

/**
 * Mobile user agents (includes phones and tablets)
 */
const MOBILE_USER_AGENTS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; SM-X906C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

/**
 * Unknown/unclassifiable user agents — generic strings that analytics engines
 * (GA4, Plausible, Matomo, Mixpanel, etc.) cannot categorize as desktop or mobile
 */
const UNKNOWN_USER_AGENTS = [
  // Bots & crawlers — most common unknown traffic by far
  { ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", weight: 25 },
  { ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", weight: 12 },
  { ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", weight: 8 },
  { ua: "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)", weight: 5 },
  { ua: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", weight: 4 },
  { ua: "Twitterbot/1.0", weight: 4 },
  // AI agents & scrapers
  { ua: "Claude-Web/1.0 (Anthropic)", weight: 6 },
  { ua: "GPTBot/1.2 (+https://openai.com/gptbot)", weight: 6 },
  { ua: "CCBot/2.0 (https://commoncrawl.org/faq/)", weight: 3 },
  // CLI & libraries
  { ua: "curl/8.4.0", weight: 8 },
  { ua: "python-requests/2.31.0", weight: 6 },
  { ua: "node-fetch/3.3.2", weight: 3 },
  { ua: "axios/1.6.2", weight: 2 },
  { ua: "Go-http-client/2.0", weight: 3 },
  { ua: "Wget/1.21.4", weight: 2 },
  // Odd devices — rare but real
  { ua: "SmartTV/1.0 (SMART-TV; Linux; Tizen 7.0)", weight: 2 },
  { ua: "Dalvik/2.1.0 (Linux; U; Android 12; oculus Build/SQ3A.220605.009.A1)", weight: 1 },
];

const ACCEPT_LANGS = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "da-DK,da;q=0.9,en-US;q=0.8,en;q=0.7",
  "fr-FR,fr;q=0.9,en-US;q=0.8",
];

const REFERERS = [
  "https://facebook.com/",
  "https://twitter.com/",
  "https://linkedin.com/",
  "https://google.com/",
  "https://reddit.com/",
  "https://youtube.com/",
  "https://discord.com/",
  "https://slack.com/",
  "https://whatsapp.com/",
  "https://tiktok.com/",
  "https://pinterest.com/",
  "https://telegram.org/",
  "https://weibo.com/",
];

/**
 * Vercel geolocation headers simulation
 * Mix of US, Danish, and other international locations
 */
const LOCATIONS = [
  // US locations (with state codes)
  {
    country: "US",
    city: "The%20Dalles",
    region: "OR",
    latitude: "45.5946",
    longitude: "-121.1787",
  },
  {
    country: "US",
    city: "Atlanta",
    region: "GA",
    latitude: "33.7490",
    longitude: "-84.3880",
  },
  {
    country: "US",
    city: "New%20York",
    region: "NY",
    latitude: "40.7128",
    longitude: "-74.0060",
  },
  {
    country: "US",
    city: "San%20Francisco",
    region: "CA",
    latitude: "37.7749",
    longitude: "-122.4194",
  },
  // Danish locations (with numeric region codes)
  {
    country: "DK",
    city: "Copenhagen",
    region: "84",
    latitude: "55.6761",
    longitude: "12.5683",
  },
  {
    country: "DK",
    city: "Aarhus",
    region: "82",
    latitude: "56.1629",
    longitude: "10.2039",
  },
  // Other international locations
  {
    country: "DE",
    city: "Munich",
    region: "BY",
    latitude: "48.1351",
    longitude: "11.5820",
  },
  {
    country: "GB",
    city: "London",
    region: "ENG",
    latitude: "51.5074",
    longitude: "-0.1278",
  },
  {
    country: "FR",
    city: "Paris",
    region: "IDF",
    latitude: "48.8566",
    longitude: "2.3522",
  },
  // Additional international locations
  {
    country: "NL",
    city: "Amsterdam",
    region: "NH",
    latitude: "52.3676",
    longitude: "4.9041",
  },
  {
    country: "SE",
    city: "Stockholm",
    region: "AB",
    latitude: "59.3293",
    longitude: "18.0686",
  },
  {
    country: "JP",
    city: "Tokyo",
    region: "13",
    latitude: "35.6762",
    longitude: "139.6503",
  },
  {
    country: "BR",
    city: "S%C3%A3o%20Paulo",
    region: "SP",
    latitude: "-23.5505",
    longitude: "-46.6333",
  },
  {
    country: "AU",
    city: "Sydney",
    region: "NSW",
    latitude: "-33.8688",
    longitude: "151.2093",
  },
];

/**
 * First octet ranges that look realistic per country (avoid reserved ranges)
 * Each country gets multiple first-octet options for variety
 */
const IP_FIRST_OCTETS = {
  US: [
    3, 8, 13, 18, 23, 34, 35, 44, 50, 52, 54, 63, 64, 65, 66, 67, 68, 69, 70,
    71, 72, 73, 74, 75, 76, 96, 97, 98, 99, 100, 104, 107, 108, 128, 129, 130,
    131, 132, 134, 135, 136, 137, 138, 139, 140, 142, 143, 144, 147, 148, 149,
    150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164,
    165, 166, 167, 168, 170, 171, 172, 173, 174, 184, 198, 199, 204, 205, 206,
    207, 208, 209,
  ],
  DK: [
    2, 5, 31, 37, 46, 77, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92,
    93, 94, 95, 109, 176, 178, 185, 188, 193, 194, 195, 212, 213,
  ],
  DE: [
    2, 5, 31, 37, 46, 62, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
    91, 92, 93, 94, 95, 109, 134, 138, 141, 145, 146, 176, 178, 185, 188, 193,
    194, 195, 212, 213, 217,
  ],
  GB: [
    2, 5, 31, 37, 46, 51, 62, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88,
    89, 90, 91, 92, 93, 94, 95, 109, 176, 178, 185, 188, 193, 194, 195, 212,
    213, 217,
  ],
  FR: [
    2, 5, 31, 37, 46, 62, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
    90, 91, 92, 93, 94, 95, 109, 176, 178, 185, 188, 193, 194, 195, 212, 213,
    217,
  ],
  NL: [
    2, 5, 31, 37, 46, 62, 77, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91,
    92, 93, 94, 95, 109, 145, 176, 178, 185, 188, 193, 194, 195, 212, 213,
  ],
  SE: [
    2, 5, 31, 37, 46, 62, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88,
    89, 91, 92, 93, 94, 95, 109, 176, 178, 185, 188, 193, 194, 195, 212, 213,
  ],
  JP: [
    1, 14, 27, 36, 42, 49, 58, 59, 60, 61, 101, 106, 110, 111, 113, 114,
    115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 133, 150,
    153, 157, 160, 163, 175, 180, 182, 183, 202, 210, 211, 218, 219, 220,
  ],
  BR: [
    131, 138, 139, 143, 146, 152, 155, 161, 168, 170, 177, 179, 186, 187,
    189, 190, 191, 200, 201,
  ],
  AU: [
    1, 14, 27, 43, 49, 58, 59, 60, 61, 101, 103, 106, 110, 112, 113, 114,
    115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 144, 150, 175,
    180, 182, 192, 202, 203, 210, 211, 218, 219, 220,
  ],
};

/**
 * Pick a random payload from a weighted list.
 * Each payload has { name, weight, params }.
 */
function pickPayload(payloads) {
  const totalWeight = payloads.reduce((sum, p) => sum + p.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const payload of payloads) {
    roll -= payload.weight;
    if (roll <= 0) return payload;
  }
  return payloads[payloads.length - 1];
}

// ============================================================================
// Utility Functions
// ============================================================================

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randChoice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const weightedChoice = (items) => {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item.ua;
  }
  return items[items.length - 1].ua;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Generate a simulated IP address for a given country code
 * Generates fully random IPs for massive uniqueness
 * The redirect service normalizes to /24 subnet, so first 3 octets matter for uniqueness
 */
function generateFakeIp(countryCode, usedIps, uniqueIpProb) {
  // Decide if this should be a unique IP or potentially a repeat
  if (Math.random() < uniqueIpProb || usedIps.size === 0) {
    // Generate a completely unique IP
    const firstOctets = IP_FIRST_OCTETS[countryCode] || IP_FIRST_OCTETS.US;
    const octet1 = randChoice(firstOctets);
    const octet2 = randInt(0, 255);
    const octet3 = randInt(0, 255);
    const octet4 = randInt(1, 254);

    const ip = `${octet1}.${octet2}.${octet3}.${octet4}`;

    // Store the /24 subnet (what gets normalized) for potential reuse
    const subnet = `${octet1}.${octet2}.${octet3}`;
    usedIps.add(subnet);

    return ip;
  } else {
    // Return a previously used subnet (simulates repeat visitor)
    const subnets = Array.from(usedIps);
    const subnet = randChoice(subnets);
    return `${subnet}.${randInt(1, 254)}`;
  }
}

// ============================================================================
// Simulator Class
// ============================================================================

/**
 * TrafficSimulator - simulates realistic web traffic to a target URL
 */
export class TrafficSimulator {
  constructor(targetUrl, config = {}) {
    // Validate URL
    try {
      new URL(targetUrl);
    } catch {
      throw new Error(`Invalid URL provided: ${targetUrl}`);
    }

    this.targetUrl = targetUrl;
    this.config = { ...getConfig(), ...config };
    this.usedIps = new Set();
    this.hitCounter = 0;
    this.workers = [];
    this.isRunning = false;
    this.proxyPool = new WorkerProxyPool(this.config);
    this.proxyAgentCache = new Map(); // cache agents by proxy URL
  }

  /**
   * Execute a single HTTP request with simulated headers
   */
  async doHit(workerId) {
    const hitNumber = ++this.hitCounter;
    // Pick user agent: first check unknown ratio, then split desktop/mobile
    const isUnknown = Math.random() * 100 < (this.config.UNKNOWN_RATIO || 0);
    let ua;
    if (isUnknown) {
      ua = weightedChoice(UNKNOWN_USER_AGENTS);
    } else {
      const isDesktop = Math.random() * 100 < this.config.DEVICE_RATIO;
      ua = randChoice(isDesktop ? DESKTOP_USER_AGENTS : MOBILE_USER_AGENTS);
    }
    const al = randChoice(ACCEPT_LANGS);
    const ref = randChoice(REFERERS);
    const location = randChoice(LOCATIONS);
    const cacheBust = Math.random().toString(36).slice(2, 9);

    // Generate a unique fake IP for this request
    const fakeIp = generateFakeIp(
      location.country,
      this.usedIps,
      this.config.UNIQUE_IP_PROB,
    );

    // Build URL with dynamic URL parameters (and optional payloads)
    const sep = this.targetUrl.includes("?") ? "&" : "?";
    // Use cache bust as a URL fragment (not a query param) to avoid polluting url_params
    let url = this.targetUrl;
    const appliedParams = [];

    // Add URL parameters based on their probability
    // If a param has payloads, pick one by weight and append its key-value pairs too
    const paramParts = [];
    this.config.URL_PARAMS.forEach((param) => {
      if (Math.random() * 100 < param.probability) {
        if (param.value) {
          paramParts.push(`${encodeURIComponent(param.key)}=${encodeURIComponent(param.value)}`);
        } else {
          paramParts.push(encodeURIComponent(param.key));
        }
        appliedParams.push(param.key);

        // If this param has payloads, pick one and append its params
        if (param.payloads && param.payloads.length > 0) {
          const payload = pickPayload(param.payloads);
          for (const [key, value] of Object.entries(payload.params)) {
            paramParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
            appliedParams.push(`${key}=${value}`);
          }
        }
      }
    });

    if (paramParts.length > 0) {
      url += `${sep}${paramParts.join("&")}`;
    }

    // Append cache bust as fragment (not captured by url_params)
    url += `#${cacheBust}`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.TIMEOUT_MS,
    );

    const parsedUrl = new URL(url);
    const doRequest = parsedUrl.protocol === "https:" ? https.request : http.request;

    // Get proxy for this request (null if mode=none)
    const proxyUrl = this.proxyPool.getProxy();
    let agent = undefined;
    if (proxyUrl) {
      try {
        // Cache agents to avoid creating new ones per request
        if (!this.proxyAgentCache.has(proxyUrl)) {
          this.proxyAgentCache.set(proxyUrl, await createProxyAgent(proxyUrl, parsedUrl.protocol));
        }
        agent = this.proxyAgentCache.get(proxyUrl);
      } catch (err) {
        // Fall back to direct connection if agent creation fails
        this.proxyPool.markFailed(proxyUrl);
      }
    }

    // When using a real proxy, don't spoof any headers — let the proxy's real IP
    // and Vercel's own geo-detection handle everything.
    // When not using proxy (mode=none), keep the full header spoofing behavior.
    const useRealProxy = !!agent;
    const headers = {
      "User-Agent": ua,
      "Accept-Language": al,
      Referer: ref,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };
    if (!useRealProxy) {
      // Full header spoofing — only when no real proxy
      headers["x-forwarded-for"] = fakeIp;
      headers["x-real-ip"] = fakeIp;
      headers["x-vercel-ip-country"] = location.country;
      headers["x-vercel-ip-city"] = location.city;
      headers["x-vercel-ip-country-region"] = location.region;
      headers["x-vercel-ip-latitude"] = location.latitude;
      headers["x-vercel-ip-longitude"] = location.longitude;
    }

    try {
      const res = await new Promise((resolve, reject) => {
        const req = doRequest(url, {
          method: this.config.METHOD,
          signal: controller.signal,
          lookup: agent ? undefined : cachedLookup, // skip DNS cache when proxied
          agent,
          headers,
        }, (response) => {
          response.resume(); // drain body immediately
          resolve(response);
        });
        req.on("error", reject);
        req.end();
      });

      const ipLabel = useRealProxy ? "PROXY" : fakeIp;
      const locationLabel = useRealProxy ? "→ proxy" : `${decodeURIComponent(location.city)}, ${location.region}, ${location.country}`;
      console.log(
        new Date().toISOString(),
        `W${workerId}`,
        `#${hitNumber}`,
        res.statusCode,
        locationLabel,
        ipLabel,
        ua.split(" ")[0],
        appliedParams.length > 0 ? `[${appliedParams.join(",")}]` : "",
      );

      return { success: true, status: res.statusCode, hitNumber };
    } catch (err) {
      // Mark proxy as failed so pool can rotate away from it
      if (proxyUrl) this.proxyPool.markFailed(proxyUrl);

      console.warn(
        new Date().toISOString(),
        `W${workerId}`,
        `#${hitNumber}`,
        "ERROR",
        err.message,
      );
      return { success: false, error: err.message, hitNumber };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Active phase - make requests at a random rate
   */
  async activePhase(workerId, minutes) {
    const rate = randInt(this.config.MIN_PER_MIN, this.config.MAX_PER_MIN);
    console.log(
      new Date().toISOString(),
      `W${workerId}`,
      `ACTIVE for ${minutes} min @ ~${rate}/min`,
    );

    const end = Date.now() + minutes * 60 * 1000;
    while (Date.now() < end && this.isRunning) {
      const hitStart = Date.now();
      await this.doHit(workerId);
      const elapsed = Date.now() - hitStart;

      // interval per request in ms, minus time already spent on the fetch
      const base = 60000 / rate;
      const jitter = Math.round(base * (Math.random() * 0.2 - 0.1)); // ±10%
      const remaining = Math.max(0, base + jitter - elapsed);
      if (remaining > 0) await sleep(remaining);
    }
  }

  /**
   * Idle phase - sleep for a random duration
   */
  async idlePhase(workerId, minutes) {
    console.log(
      new Date().toISOString(),
      `W${workerId}`,
      `IDLE for ${minutes} min`,
    );
    await sleep(minutes * 60 * 1000);
  }

  /**
   * Worker loop - alternates between active and idle phases
   */
  async workerLoop(id) {
    while (this.isRunning) {
      // active phase
      const activeMinutes = randInt(
        this.config.MIN_ACTIVE,
        this.config.MAX_ACTIVE,
      );
      await this.activePhase(id, activeMinutes);

      // transition
      if (Math.random() < this.config.IDLE_ODDS && this.isRunning) {
        const idleMinutes = randInt(
          this.config.MIN_IDLE,
          this.config.MAX_IDLE,
        );
        await this.idlePhase(id, idleMinutes);
      }
    }
  }

  /**
   * Start the simulator
   */
  async start() {
    if (this.isRunning) {
      console.warn("Simulator is already running");
      return;
    }

    this.isRunning = true;
    console.log(`Starting traffic simulator for ${this.targetUrl}`);
    console.log("Config:", this.config);

    // Initialize proxy pool (no-op if mode=none)
    await this.proxyPool.init();

    for (let i = 0; i < this.config.CONCURRENT; i++) {
      const worker = this.workerLoop(i + 1).catch((e) =>
        console.error(`Worker ${i + 1} crashed:`, e),
      );
      this.workers.push(worker);
      await sleep(200); // stagger startup
    }
  }

  /**
   * Stop the simulator
   */
  stop() {
    this.isRunning = false;
    this.proxyPool.destroy();
    this.proxyAgentCache.clear();
    console.log("Stopping simulator...");
  }

  /**
   * Get current statistics
   */
  getStats() {
    return {
      hitCounter: this.hitCounter,
      uniqueIps: this.usedIps.size,
      isRunning: this.isRunning,
    };
  }
}
