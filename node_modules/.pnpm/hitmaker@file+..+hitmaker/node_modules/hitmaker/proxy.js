// proxy.js
// Proxy pool manager for rotating IP addresses through real proxies
// Supports: free proxy lists (ProxyScrape), custom proxy URLs/files, and paid rotating services
//
// Architecture:
//   - "service" mode: each worker uses the rotating endpoint directly (no shared pool)
//   - "free"/"url" mode: parent process fetches & health-checks ONCE, then distributes
//     alive proxies to workers via IPC. Workers report failures back to parent.

import http from "http";
import https from "https";
import net from "net";
import { readFileSync, existsSync } from "fs";

// ============================================================================
// ProxyPool — used by the PARENT process to fetch, health-check, and manage
// ============================================================================

export class ProxyPool {
  constructor(config = {}) {
    this.mode = config.PROXY_MODE || "none";
    this.proxyUrl = this.mode === "service"
      ? (config.PROXY_SERVICE_URL || config.PROXY_URL || "")
      : (config.PROXY_LIST_URL || config.PROXY_URL || "");
    this.refreshMin = config.PROXY_REFRESH_MIN || 10;

    this.proxies = [];
    this.refreshTimer = null;
    this.isRefreshing = false;
    this.stats = { total: 0, alive: 0, dead: 0, checks: 0, lastRefresh: null };
  }

  /**
   * Initialize — fetch and health-check proxies (parent-side only)
   */
  async init() {
    if (this.mode === "none") return;

    if (this.mode === "service") {
      if (!this.proxyUrl) {
        console.warn("PROXY_MODE=service but no PROXY_URL set, falling back to none");
        this.mode = "none";
        return;
      }
      console.log(`Proxy mode: service → ${this.proxyUrl.replace(/\/\/.*:.*@/, "//***:***@")}`);
      return;
    }

    if (this.mode === "url") {
      await this._loadFromUrl();
    } else if (this.mode === "free") {
      await this._fetchFreeProxies();
    }

    if (this.proxies.length > 0) {
      await this._healthCheckAll();
    }

    // Schedule periodic refresh
    if (this.refreshMin > 0) {
      this.refreshTimer = setInterval(() => this.refresh(), this.refreshMin * 60 * 1000);
    }

    console.log(`Proxy pool ready: ${this.stats.alive} alive / ${this.stats.total} total`);
  }

  /**
   * Get the list of alive proxy URLs — for sending to workers via IPC
   */
  getAliveList() {
    return this.proxies.filter((p) => p.alive).map((p) => p.url);
  }

  /**
   * Mark a proxy as failed (called when worker reports a failure)
   */
  markFailed(proxyUrl) {
    const proxy = this.proxies.find((p) => p.url === proxyUrl);
    if (proxy) {
      proxy.failures++;
      if (proxy.failures >= 3) {
        proxy.alive = false;
        this._updateStats();
      }
    }
  }

  /**
   * Refresh pool and return updated alive list
   */
  async refresh() {
    if (this.isRefreshing) return this.getAliveList();
    this.isRefreshing = true;

    try {
      if (this.mode === "free") await this._fetchFreeProxies();
      else if (this.mode === "url") await this._loadFromUrl();
      await this._healthCheckAll();
      this.stats.lastRefresh = new Date();
    } finally {
      this.isRefreshing = false;
    }
    return this.getAliveList();
  }

  getStats() { return { ...this.stats, mode: this.mode }; }

  destroy() {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  _updateStats() {
    this.stats.alive = this.proxies.filter((p) => p.alive).length;
    this.stats.dead = this.stats.total - this.stats.alive;
  }

  // ==========================================================================
  // Fetching
  // ==========================================================================

  async _fetchFreeProxies() {
    const sources = [
      { url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=anonymous,elite", protocol: "http" },
      { url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=5000&country=all", protocol: "socks4" },
      { url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=all", protocol: "socks5" },
    ];

    const newProxies = [];
    for (const source of sources) {
      try {
        const body = await this._httpGet(source.url);
        for (const line of body.split("\n").map((l) => l.trim()).filter(Boolean)) {
          const [host, port] = line.split(":");
          if (host && port) {
            newProxies.push({
              url: `${source.protocol}://${host}:${port}`,
              protocol: source.protocol,
              host, port: parseInt(port),
              alive: true, lastCheck: null, failures: 0,
            });
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch ${source.protocol} proxies:`, err.message);
      }
    }

    const existingUrls = new Set(this.proxies.map((p) => p.url));
    for (const proxy of newProxies) {
      if (!existingUrls.has(proxy.url)) this.proxies.push(proxy);
    }

    if (this.proxies.length > 2000) {
      this.proxies.sort((a, b) => (b.alive - a.alive) || ((b.lastCheck || 0) - (a.lastCheck || 0)));
      this.proxies = this.proxies.slice(0, 2000);
    }

    this.stats.total = this.proxies.length;
    console.log(`Fetched proxies: ${newProxies.length} from APIs, pool size: ${this.proxies.length}`);
  }

  async _loadFromUrl() {
    if (!this.proxyUrl) return;
    let body;
    if (existsSync(this.proxyUrl)) body = readFileSync(this.proxyUrl, "utf-8");
    else if (this.proxyUrl.startsWith("http")) body = await this._httpGet(this.proxyUrl);
    else { console.warn(`PROXY_URL "${this.proxyUrl}" is neither a file nor URL`); return; }

    const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    this.proxies = [];
    for (const line of lines) {
      let url, protocol, host, port;
      if (line.includes("://")) {
        url = line; const parsed = new URL(line);
        protocol = parsed.protocol.replace(":", ""); host = parsed.hostname; port = parseInt(parsed.port);
      } else {
        [host, port] = [line.split(":")[0], parseInt(line.split(":")[1])];
        protocol = "http"; url = `http://${host}:${port}`;
      }
      if (host && port) this.proxies.push({ url, protocol, host, port, alive: true, lastCheck: null, failures: 0 });
    }
    this.stats.total = this.proxies.length;
    console.log(`Loaded ${this.proxies.length} proxies from ${this.proxyUrl}`);
  }

  // ==========================================================================
  // Health checking
  // ==========================================================================

  async _healthCheckAll() {
    const CONCURRENCY = 50;
    const TIMEOUT = 5000;
    let checked = 0, alive = 0;
    const shuffled = [...this.proxies].sort(() => Math.random() - 0.5);

    for (let i = 0; i < shuffled.length; i += CONCURRENCY) {
      const batch = shuffled.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((p) => this._checkProxy(p, TIMEOUT)));

      for (let j = 0; j < batch.length; j++) {
        checked++;
        batch[j].lastCheck = Date.now();
        if (results[j].status === "fulfilled" && results[j].value) {
          batch[j].alive = true; batch[j].failures = 0; alive++;
        } else {
          batch[j].alive = false;
        }
      }
      if (alive >= 200) break;
    }

    this._updateStats();
    this.stats.checks++;
    console.log(`Health check: ${this.stats.alive} alive / ${checked} checked / ${this.stats.total} total`);
  }

  _checkProxy(proxy, timeout = 5000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeout);
      try {
        if (proxy.protocol === "socks4" || proxy.protocol === "socks5") {
          const socket = net.createConnection(proxy.port, proxy.host, () => {
            clearTimeout(timer); socket.destroy(); resolve(true);
          });
          socket.on("error", () => { clearTimeout(timer); resolve(false); });
          socket.setTimeout(timeout, () => { socket.destroy(); clearTimeout(timer); resolve(false); });
        } else {
          const req = http.request({
            host: proxy.host, port: proxy.port,
            path: "http://httpbin.org/ip", method: "GET", timeout,
            headers: { Host: "httpbin.org" },
          }, (res) => { res.resume(); clearTimeout(timer); resolve(res.statusCode < 500); });
          req.on("error", () => { clearTimeout(timer); resolve(false); });
          req.on("timeout", () => { req.destroy(); clearTimeout(timer); resolve(false); });
          req.end();
        }
      } catch { clearTimeout(timer); resolve(false); }
    });
  }

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith("https") ? https : http;
      const req = lib.get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._httpGet(res.headers.location).then(resolve, reject);
        }
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    });
  }
}

// ============================================================================
// WorkerProxyPool — lightweight pool used by WORKER processes
// Receives a pre-checked proxy list from the parent via IPC.
// ============================================================================

export class WorkerProxyPool {
  constructor(config = {}) {
    this.mode = config.PROXY_MODE || "none";
    this.serviceUrl = config.PROXY_SERVICE_URL || config.PROXY_URL || "";
    this.proxyList = [];  // Array of proxy URL strings (set by parent via IPC)
    this.index = 0;
  }

  async init() {
    if (this.mode === "service") {
      if (!this.serviceUrl) { this.mode = "none"; return; }
      console.log(`Proxy mode: service → ${this.serviceUrl.replace(/\/\/.*:.*@/, "//***:***@")}`);
    } else if (this.mode === "free" || this.mode === "url") {
      console.log(`Proxy mode: ${this.mode} (waiting for pool from parent...)`);
    }
  }

  /**
   * Receive updated proxy list from parent
   */
  setProxyList(list) {
    this.proxyList = list;
    this.index = Math.floor(Math.random() * list.length); // randomize start offset
    console.log(`Received ${list.length} proxies from parent`);
  }

  /**
   * Get the next proxy URL for a request
   */
  getProxy() {
    if (this.mode === "none") return null;
    if (this.mode === "service") return this.serviceUrl;

    if (this.proxyList.length === 0) return null;
    const proxy = this.proxyList[this.index % this.proxyList.length];
    this.index = (this.index + 1) % this.proxyList.length;
    return proxy;
  }

  markFailed(proxyUrl) {
    // Report to parent — the parent manages the canonical pool
    if (process.send) {
      process.send({ type: "proxy_failed", url: proxyUrl });
    }
    // Also remove locally to avoid retrying immediately
    const idx = this.proxyList.indexOf(proxyUrl);
    if (idx !== -1) this.proxyList.splice(idx, 1);
  }

  destroy() {}
}

// ============================================================================
// Proxy Agent Factory
// ============================================================================

export async function createProxyAgent(proxyUrl, targetProtocol) {
  const proxyProtocol = new URL(proxyUrl).protocol;

  if (proxyProtocol === "socks4:" || proxyProtocol === "socks5:") {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    return new SocksProxyAgent(proxyUrl);
  }

  if (targetProtocol === "https:") {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    return new HttpsProxyAgent(proxyUrl);
  } else {
    const { HttpProxyAgent } = await import("http-proxy-agent");
    return new HttpProxyAgent(proxyUrl);
  }
}
