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
| **Quote sheet (shadow)** | Where we *would* quote each spread, in ticks, with the future order price that goes with it, plus a log of simulated fills built from the public trade tape. Sends no orders. Off by default; start the monitor with `CDE_TAPE=1` (see below). |
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

## Quote sheet and fill logger (shadow mode)

Start with `set CDE_TAPE=1` (Windows cmd) or add `CDE_TAPE=1` to `.env`. Every 15 s (`CDE_TAPE_SWEEP_MS`) it reads the order books of the perp and dated futures and the recent trades of each dated future. For every tape trade it assumes **we were the maker** (a taker buy means the maker sold; a taker sell means the maker bought), assumes the hedge was done on the other leg's touch at that moment, and records the synthetic spread price we would have traded at, how many ticks it was from the synthetic touch, and how stale the hedge quote was. The Quote sheet tab turns that into quotes: fair value from a time-decayed average of the spread's own APY, costs in ticks (fees + slippage + buffer), the highest bid and lowest offer that still earn the minimum edge, and a ladder with the future order price (`hedge-leg bid + spread bid`, `hedge-leg ask + spread offer`). Once enough simulated fills exist, the top level is chosen by expected profit per hour instead of the cost limit.

Settings (env vars): `CDE_TAPE_ROOTS` (e.g. `ETH,SOL`), `CDE_Q_EMIN`, `CDE_Q_BETA`, `CDE_Q_SLIP`, `CDE_Q_LEVELS` (default 1 = best bid and best offer only; 3 gives a ladder), `CDE_Q_CLIP_USD`, `CDE_Q_FEE_EXCHANGE` (default $0.03 per contract per trade), `CDE_Q_FEE_CLEARING` (default $0.02), `CDE_Q_FEE_BASIS` (`fill` charges one hedged fill, $0.10; `roundtrip` charges open + close, $0.20), `CDE_TAPE_PAIRS` (default perp-hedged spreads only; `all` adds the 1–2 calendar spread), `CDE_Q_HALFLIFE_MIN`, `CDE_Q_WARMUP_MIN`, `CDE_Q_KAPPA`, `CDE_TAPE_SIDE` (`auto`, `taker` or `maker`: whether the feed's trade side is the aggressor). Output: `/fills.csv`, `/api/quotes`, `/api/curve?root=ETH&pair=FRONT_PERP&side=BUY`.

Reading the sheet: click an underlined header to sort (the choice is remembered); the default is **Total $/hr** (edge plus volume incentive per hour at the top quote), highest first. **Edge $/fill** is profit per fill after costs for one clip; **Fills/hr** and **Contracts/hr** come from the simulated tape fills (each fill capped at the clip); **Shadow P&L (24h)** is what the current top quote would have earned on those fills, saved in `cde_shadow_pnl.jsonl`; **24h volume** is the quoted future's traded USD. For the volume incentive set `CDE_Q_MONTHLY_VOLUME` to the total CDE contracts per month (the pool is $5,000 per 1%; change with `CDE_Q_INCENTIVE_USD` and `CDE_Q_INCENTIVE_PCT`); without it the incentive columns show "off". The spread links above the table filter by 1–Perp, 2–Perp or 1–2.

Each tape trade is counted once and hedged on the perp. The 1–2 route reuses the same trades hedged on the other future, so its P&L is an alternative, not extra; it is off unless `CDE_TAPE_PAIRS=all`. Fees count both legs of a hedged fill ($0.05 × 2). Slippage is a flat allowance (`CDE_Q_SLIP`, plus the β buffer); the sheet flags a quote when the hedge leg's best price shows fewer contracts than our clip.

Limits: hedge quotes are samples a few seconds apart, not the exact quote at the trade time, and the tape shows nothing about queue position, so simulated fills are an upper bound.

## Next funding and funding direction

The **Next funding** column (Overview, Front vs Perp, Term Structure and Bid/Ask) shows where perp funding is heading. If the exchange feed carries a predicted rate for the current period (the monitor looks for fields like `next_funding_rate` or `predicted_funding_rate`), it shows that rate as an APY, an arrow, and the move against the last paid rate. If the feed has none, it shows the direction of the perp's premium to its index, averaged over the last 15 minutes against the 15 minutes before: a rising premium means funding is trending higher. That needs about 15 minutes of data after each restart.

On the Bid/Ask tab, the **My bid APY** and **My offer APY** cells (and the Bid APY and Ask APY cells) get a small ▲ or ▼ with the number of APY points they would move because of the funding change. A move of at least 2 points is highlighted (`CDE_FUND_ALERT_APY` changes that). The "use predicted funding" box prices the APYs on the predicted rate instead of the last paid one. `node probe_funding.js BTC` prints every funding-related field the feed carries, so you can see whether a predicted rate is there.

## Month rolls

Nothing is hard-coded to a month. The front month is the soonest-expiring dated contract still listed and the back month is the next one, read from the exchange feed, so when a month expires the next ones move up by themselves. The quote sheet remembers fair value and fill history per contract, so a month that moves from 2nd to 1st keeps its history and the newly listed month starts fresh, and it does not quote a contract that expires in under a day (`CDE_Q_MIN_DAYS`). `node list_expiries.js` prints every dated contract with its expiry date and weekday straight from the feed (for example `node list_expiries.js BTC ETH`).

## Where your data lives (`data/`, git-ignored)

| File | Contents |
|---|---|
| `cde_basis_LOG.jsonl` | One line per poll. Powers charts, z-scores and Calibration. |
| `archive/` | Older polls rotated out of the active log (nothing is deleted). |
| `cde_shadow_pnl.jsonl` | Credited shadow fills behind the quote sheet's Shadow P&L column. |
| `cde_sim_fills.jsonl` | Simulated fills from the quote sheet's trade tape (only when `CDE_TAPE=1`). |
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
