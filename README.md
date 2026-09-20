# perp-arb — BTC Perpetual Arb Monitor

Polls Kalshi, Binance, and Hyperliquid BTC perpetual markets every minute.
When a fee-adjusted, slippage-aware edge between any two venues exceeds your
threshold, fires a Telegram alert with a full P&L breakdown.

---

## File Structure

```
perp-arb/
├── monitor.js          ← main loop (run standalone or require() into server.js)
├── diagnose.js         ← one-shot raw API dump — run this first
├── config.js           ← all tunable parameters (fees, thresholds, intervals)
├── venues/
│   ├── binance.js      ← USDM futures: premiumIndex + bookTicker + depth
│   ├── hyperliquid.js  ← metaAndAssetCtxs + l2Book (POST /info, no auth)
│   └── kalshi.js       ← perps /margin/* endpoints — SCHEMA UNVERIFIED, see below
├── analysis/
│   └── edge.js         ← slippage walk, fee math, funding normalization, net edge
└── alerts/
    └── telegram.js     ← message formatter + send()
```

---

## Setup

**1. Install deps**
```bash
cd perp-arb && npm install
```

**2. Environment** — add to your existing `.env`:
```
TELEGRAM_BOT_TOKEN=your_existing_bot_token
TELEGRAM_CHAT_ID=your_existing_channel_id
# No Kalshi or exchange API keys needed for public market data
```

**3. Verify Kalshi endpoints before running the monitor**
```bash
node diagnose.js 2>&1 | tee diagnose-output.txt
```

Open `diagnose-output.txt`. For Kalshi you're looking for:
- The exact ticker string (might be `KXBTCPERP`, `BTC-PERP`, or something else)
- The field names for mark price, best bid, best ask on the market object
- Which endpoint returns the current funding rate and what the field is called
- The order book structure (arrays of `[price, qty]`? objects with `px`/`sz`?)

Then update `venues/kalshi.js → parseSnapshot()` to match. Binance and
Hyperliquid should work immediately without changes.

**4. Tune parameters** in `config.js`:
- `notionalUsd` — size you'd actually consider trading ($25k default)
- `alertThresholdBps` — minimum net edge to alert (15 bps default). Consider
  starting higher (25–30 bps) until Kalshi schema is confirmed, to avoid false
  positives from parsing errors.
- `assumedHoldingHours` — affects how much of the annualized funding edge
  you credit to this specific trade (8h default = one Binance/Kalshi funding period)
- `fees` — double-check these against each venue's live fee schedule. Kalshi
  perps fees in particular are a separate schedule from their event-contract
  parabolic formula.

**5. Run**
```bash
node monitor.js          # standalone
# or
npm start
```

---

## How the Edge Math Works

For each pair (e.g. long Hyperliquid / short Binance):

```
Net edge (bps) =
  + price discrepancy (avg fill short - avg fill long, in bps of notional)
  + funding carry over holding period
      (shortVenueFunding - longVenueFunding, annualized, scaled to holdingHours)
  - entry fees (taker on both legs)
  - estimated exit fees (symmetric estimate = entry fees)
```

Slippage is estimated by walking the actual order book depth against your
`notionalUsd`, not just using the touch price. If the book can't absorb your
full size, the pair is flagged `insufficient_liquidity` rather than reporting
a fictional fill price.

Funding intervals differ across venues:
- **Binance**: every 8 hours (standard)
- **Kalshi**: every 8 hours (capped at 2% per window per docs)
- **Hyperliquid**: every 1 hour

All funding rates are normalized to annualized % before comparison, then scaled
back to the assumed holding period so the bps figure is comparable to the price
edge and fee costs.

---

## Integration into server.js

If you want this running inside your existing Node.js scheduler rather than
as a separate process:

```js
// In your server.js, near your other scheduled jobs:
const perpArb = require('./perp-arb/monitor');
perpArb.start();
```

The module uses its own `setInterval` and won't interfere with your hourly
IV collector or existing Telegram delivery. Both will share the same process
and the same Telegram bot/channel (since they read from the same `.env`).

---

## Caveats

1. **Kalshi schema is unverified** — the perps API launched weeks ago and I
   couldn't reach `external-api.kalshi.com` from my build environment. Run
   `diagnose.js` first and update `venues/kalshi.js` to match live field names.

2. **Fees will drift** — all three venues adjust fee schedules periodically.
   Verify against live fee pages before sizing any real position around the
   alert output.

3. **This is a signal, not a trade** — the monitor is deliberately built to
   tell you when an opportunity *looks* interesting, not to auto-execute.
   Actual execution (sizing, margin, timing, execution risk, basis risk on
   unwind) requires a more robust system. That's the point: watch this output
   for a week and see if Kalshi-Binance basis or Kalshi-HL funding differentials
   are real and persistent before building out execution.

4. **Kalshi liquidity** — BTCPERP is new. The book may be thin enough that
   `insufficient_liquidity` fires often even when the price basis looks
   interesting. If so, reduce `notionalUsd` in config.js to see what's
   actually achievable given current depth.
