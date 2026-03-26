#!/usr/bin/env node
// worker.js
// Worker process that runs the traffic simulator for a single URL
// This is spawned as a child process by the main index.js

import { TrafficSimulator } from "./simulator.js";

const targetUrl = process.argv[2];

if (!targetUrl) {
  console.error("ERROR: No target URL provided to worker");
  process.exit(1);
}

// Create and start simulator
const simulator = new TrafficSimulator(targetUrl);

// Listen for IPC messages from parent (proxy list updates)
process.on("message", (msg) => {
  if (msg.type === "proxy_list") {
    simulator.proxyPool.setProxyList(msg.list);
  }
});

// Handle graceful shutdown
process.on("SIGTERM", () => {
  simulator.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  simulator.stop();
  process.exit(0);
});

// Start the simulator
simulator.start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
