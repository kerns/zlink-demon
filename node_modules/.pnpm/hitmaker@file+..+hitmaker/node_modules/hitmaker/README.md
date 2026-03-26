# Hitmaker

Traffic simulation tool for testing analytics, redirect services, and link tracking systems. Features an interactive terminal UI, supports multiple concurrent links, and generates diverse, realistic traffic patterns.

## Features

- Realistic traffic simulation with diverse user agents, locations, IPs, referers
- Real-time terminal dashboard with stats and controls
- Multi-link support for testing multiple URLs simultaneously
- Configurable IP uniqueness to simulate unique visitors
- Phase-based traffic alternating between active and idle periods
- Interactive controls for navigation, pause/restart, and monitoring
- Persistent configuration saved between sessions

## Installation

```bash
npm install -g hitmaker
```

## Quick Start

**Single URL**
```bash
hitmaker https://example.com/link
```

**Multiple URLs**
```bash
hitmaker https://example.com/a https://example.com/b https://example.com/c
```

**From text file** (one URL per line)
```bash
hitmaker links.txt
```

**Mix and match**
```bash
hitmaker https://example.com/direct links.txt https://example.com/another
```

## Interactive Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate between links |
| K | Kill/Restart selected process |
| C | Open configuration |
| Q | Quit all processes |

## Configuration

Press `C` while running to open the interactive configuration modal. Settings are persisted to `~/.hitmaker/config.json`.

You can also use environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_PER_MIN` | 1 | Minimum hits per minute (active phase) |
| `MAX_PER_MIN` | 15 | Maximum hits per minute (active phase) |
| `CONCURRENT` | 1 | Concurrent workers per link |
| `METHOD` | GET | HTTP method (GET, HEAD, POST) |
| `TIMEOUT_MS` | 15000 | Request timeout (ms) |
| `DEVICE_RATIO` | 50 | Desktop percentage of non-unknown traffic (0-100) |
| `UNKNOWN_RATIO` | 0 | Percentage of traffic from unknown devices — bots, crawlers, CLI tools (0-100) |
| `UNIQUE_IP_PROB` | 0.95 | Probability of unique IP (0.0-1.0) |
| `MIN_ACTIVE` | 5 | Minimum active phase duration (minutes) |
| `MAX_ACTIVE` | 25 | Maximum active phase duration (minutes) |
| `IDLE_ODDS` | 0.5 | Probability of entering idle phase (0.0-1.0) |
| `MIN_IDLE` | 2 | Minimum idle phase duration (minutes) |
| `MAX_IDLE` | 45 | Maximum idle phase duration (minutes) |

**Simulate returning visitors:**
```bash
UNIQUE_IP_PROB=0.5 hitmaker https://example.com/link
```

**High traffic mode:**
```bash
MIN_PER_MIN=50 MAX_PER_MIN=200 hitmaker https://example.com/link
```

## Dashboard Layout

```
 💥 HITMAKER  Running: 3/3 │ Total Hits: 1247

    NAME              HITS    RATE      ERRORS  URL
───────────────────────────────────────────────────────────────────────────────
▸ ● link1             512     15/min    0       https://example.com/link1
  ● link2             398     12/min    0       https://example.com/link2
  ○ link3             337     -         1       https://example.com/link3

───────────────────────────────────────────────────────────────────────────────
 Recent Output
  [link1] 2024-01-05T12:34:56.789Z W1 #512 200 New York, NY, US 8.12.34.56
  [link2] 2024-01-05T12:34:57.123Z W1 #398 200 Copenhagen, 84, DK 5.123.45.67

  ↑/↓ Navigate │ K Kill/Restart │ C Config │ Q Quit
```

## Status Indicators

| Symbol | Status |
|--------|--------|
| ● (green) | Active - running and making requests |
| ○ (gray) | Idle - in sleep phase |
| ◌ (blue) | Starting - initializing |
| ◼ (gray) | Stopped - killed by user |
| ✗ (red) | Crashed - exited with error |

## Architecture

Each link runs as a separate child process for isolation:

- Complete isolation (no shared state)
- Stability (one crash doesn't affect others)
- OS-level process management
- True concurrency

```
hitmaker (parent)
├── worker.js (child) -> link1
├── worker.js (child) -> link2
└── worker.js (child) -> link3
```

## Text File Format

One URL per line. Lines starting with `#` are comments:

```text
# Production links
https://example.com/link1
https://example.com/link2

# Staging links
https://staging.example.com/test1
```

## Programmatic Usage

```javascript
import { TrafficSimulator } from "hitmaker/simulator";

const simulator = new TrafficSimulator("https://example.com/link", {
  MIN_PER_MIN: 10,
  MAX_PER_MIN: 50,
  DEVICE_RATIO: 70, // 70% desktop, 30% mobile (of non-unknown traffic)
  UNKNOWN_RATIO: 10, // 10% unknown devices (bots, crawlers, CLI tools)
});

await simulator.start();

// Get current stats
const stats = simulator.getStats();
console.log(`Hits: ${stats.hitCounter}, Unique IPs: ${stats.uniqueIps}`);

// Stop after 5 minutes
setTimeout(() => simulator.stop(), 5 * 60 * 1000);
```

## URL Parameters

Configure dynamic URL parameters through the interactive config (press `C`). Each parameter has:
- **Key**: The parameter name
- **Value**: Optional value (empty = just adds `?key`)
- **Probability**: Chance (0-100%) of including this parameter

### Payloads

Parameters can optionally carry **payloads** — weighted sets of extra key-value pairs that fire alongside the parameter. When a parameter fires and has payloads, one is chosen by weight and its params are appended to the URL.

This is useful for simulating QR code scans with realistic variant data (city, campaign, media type, etc.), UTM parameters, or other tracking scenarios.

To manage payloads, open the URL params editor (`C` → URL Parameters → Enter) and press `P` on any parameter.

```
Config (C) → URL Parameters (Enter) → Select param → P (Payloads)
  → Payload List: ↑/↓ Navigate, N Name/Weight, Enter Edit params, +/- Add/Delete
    → Payload Detail: ↑/↓ Navigate, Enter Edit, +/- Add/Delete key-value pairs
```

**Example config** (`~/.hitmaker/config.json`):
```json
{
  "URL_PARAMS": [
    {
      "key": "qr", "value": "1", "probability": 35,
      "payloads": [
        { "name": "Billboard", "weight": 2, "params": { "city": "copenhagen", "media": "billboard" } },
        { "name": "Bus Stop",  "weight": 1, "params": { "city": "berlin", "media": "bus-stop" } }
      ]
    }
  ]
}
```

Parameters without payloads work exactly as before — no breaking change.

## License

MIT
