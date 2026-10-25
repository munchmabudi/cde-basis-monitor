# CDE Basis Monitor

A local dashboard for Coinbase Derivatives Exchange (CDE) **dated futures vs perpetual futures**: it annualizes the futures basis, compares it with perp funding, and shows where the spreads are rich or cheap, at mid and at the actual bid/ask. It uses only Coinbase's **public, unauthenticated** market-data endpoints, so there are no API keys to set up.

It runs entirely on your own machine. Nothing is sent anywhere unless you turn on Telegram alerts.

> Not financial advice. This is research tooling; verify numbers against your own screens before trading on them.

## Quick start

1. Install [Node.js](https://nodejs.org) **18 or newer** (it uses the built-in `fetch`). No `npm install` is needed for the CDE monitor: it has no dependencies.
2. Get the code:
   ```
   git clone https://github.com/munchmabudi/cde-basis-monitor.git
   cd cde-basis-monitor
   ```
3. Start it:
   ```
   node monitor_cde_basis.js
   ```
4. Open **http://localhost:8080**. The first poll takes a few seconds; history (charts, z-scores) builds up as it keeps running.

Useful options: `--port 8081`, `--poll 30000` (ms between polls), `--once` (poll once, log, exit), `--dryrun` (console summary). Run `node monitor_cde_basis.js --once` first if you just want to check it can reach Coinbase.

The dashboard only listens on `127.0.0.1`, so it is not reachable from other machines.

## The tabs

| Tab | What it's for |
|---|---|
| **Overview** | Every token ranked by its best spread across the three pairs. |
| **Front vs Perp / Front vs Back / Term Structure** | The same data sliced by pair: front month vs perp, front vs back month, or all three together. |
| **Bid/Ask (executable)** | Each spread priced at the **spread bid and ask** (bid of one leg minus ask of the other) and converted to APY, plus an **APY per tick** column (how far the spread APY moves for one minimum price move) and boxes to type your own working bid/offer and see their APYs. Click the underlined headers (including Token) to sort. |
| **My Positions (APY)** | Enter positions by hand (outright or spread, long/short, optional notional) and rank them by the APY you are *earning*: you receive when short and the APY is positive, or long and it is negative. Positions are pinned to the exact contracts, so they survive month expiries (an expired month shows EXPIRED). |
| **Volume** | Average daily volume for front and back months. |
| **Calibration** | Measures real arrival rate, persistence and half-life of spreads from the monitor's own logged history (needs a few weeks of data to mean much). |

Click a token name for its history chart (mean ± 2σ and ±3σ bands, 24h / 1 week / 30 days). The nav and most pages auto-refresh.

### How the numbers are built

- **Dated basis APY** = (future − index) / index × (365 days / time to expiry).
- **Perp funding APY** = funding rate × payments per year (hourly funding); it can be negative.
- **Spread APY** (Overview, Front vs Perp, etc.) = the difference of the two legs' APYs at **mid** prices.
- **Bid/Ask tab**: spread = first leg − second leg in price terms (for example `AVAX 1–Perp` = AVAX front − AVAX perp), annualized over the time until the legs converge. It reads each leg's live order book, so it will not exactly match the mid-based tabs, which measure each leg against the index.
- Cost of capital is deliberately ignored: for futures-vs-perp or futures-vs-futures on the same exchange it roughly nets out.
- Safety rails: contracts inside 24 hours of expiry are flagged and ranked last (annualizing a tiny basis over a tiny window explodes), and any APY above 3000% is treated as bad data.

## Optional: Telegram alerts

Alerts fire when a spread crosses an entry threshold and re-arm only after it falls back below a lower clear threshold, so you don't get repeats while a spread flickers around one level.

1. Copy `.env.example` to `.env` and fill in `CDE_BASIS_TELEGRAM_BOT_TOKEN` and `CDE_BASIS_TELEGRAM_CHAT_ID`.
2. Restart the monitor. Thresholds and the list of "major" tokens can be edited live at **/alerts/settings**.

With no Telegram variables set, alerts just print to the console. **`.env` is git-ignored; never commit or share it.**

## Where your data lives (`data/`, git-ignored)

| File | Contents |
|---|---|
| `cde_basis_LOG.jsonl` | One line per poll. Powers charts, z-scores and Calibration. |
| `archive/` | Older polls rotated out of the active log (nothing is deleted). |
| `cde_basis_my_positions.json` | Your manually entered positions. |
| `cde_basis_positions.json`, `cde_basis_hidden.json`, `cde_basis_alert_settings.json` | Pinned tokens, hidden tokens, alert settings. |

The repo's `.gitignore` excludes `data/*.json`, `data/*.jsonl` and `.env`, so your positions and secrets are not committed. Each person who runs this builds their own history from scratch.

The active log is rotated automatically at startup and once a day so it stays small (default: keep 60 days; change with `CDE_BASIS_MAX_LOG_DAYS`). Stats and Calibration read it as a stream and keep only bare numbers in memory (a ~90,000-poll log uses roughly 450 MB at peak), reading just the newly appended lines on each poll.

## Running it 24/7

It is a plain Node process, so run it under whatever you like: Windows Task Scheduler ("at log on", restart on failure), `pm2 start monitor_cde_basis.js`, or a systemd service. Task Scheduler and pm2 both need the working directory set to the repo folder.

## Other tools in this repo

- **`cde_basis_rotation_simulator.html`**: open it in a browser (no server needed; it loads its chart library from the internet, so you need to be online). A Monte Carlo simulator for whether automatically rolling capital into the best available basis trade beats holding a flat BTC basis, under different volatility / mean-reversion / correlation regimes, with fees and maker rebates. Its sliders are guesses until you feed it numbers from the Calibration tab.
- **`snapshot_futures_volume.js`**: `node snapshot_futures_volume.js` prints a table of front/back-month volume for every token (`--json` for raw output).
- **`capture_cde_settlements.js`**: pulls the settlement rows from Coinbase's public Historical Data page into a growing local archive. The page only shows a rolling few days, so run it daily (for example from Task Scheduler) to build a real history. See the comment at the top of the file for usage.

## Tests

```
node tests/cde_basis/run_all.js
```

Plain Node, no dependencies. They cover the position APY logic and its sign rule, the contract-pinning across expiries, the bid/ask spread math (checked against hand-computed values), and the order-book fetcher's rate-limit handling.

## Known limits

- Coinbase's public endpoints are rate limited. The Bid/Ask tab paces its order-book requests (about 5 per second, cached 30 seconds) and retries on HTTP 429; the first visit fills in over ~15 seconds, then stays warm in the background for 15 minutes after you last look.
- Order-book requests are sequential, so quotes can be up to ~15 seconds old (shown at the top of the tab).
- Spot prices from the public spot feed do not always match the futures' scale for some tokens, so they are only used as a guarded fallback for tokens without a perp index.
- Calibration numbers are provisional until there are weeks of history.
