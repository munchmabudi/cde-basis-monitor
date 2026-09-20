# CDE Dated Futures MM vs Perp Hedge — Screener

## Purpose

For each token that has CDE **dated futures** (first two expirations: front month
+ second month) **and** a CDE **perp**, this screener answers:

> If we post a 10 bps bid/ask on the dated future at $5k notional and hedge each
> fill in the CDE perp, is the hedge profitable after fees?

## Model

### Legs

| Leg | What | Venue | Book? |
|-----|------|-------|-------|
| **MM** | Post bid/ask on the dated future | CDE exchange-traded futures (nano contracts) | ❌ No public book (empty strings) |
| **Hedge** | Offset each fill in the perp | CDE perpetual swap | ❌ No public book (empty strings) |

CDE has **no public order book** (best_bid / best_ask are empty strings on the
REST API — only authenticated FIX has depth). So both legs use the **keyless
synthetic-quote model**: assume full fill at the reference midpoint, with a
synthetic bid/ask width.

### Parameters (user-specified)

| Parameter | Value | Notes |
|-----------|-------|-------|
| Quote width | 10 bps total (5 bps each side) | `widthBps` in code |
| Notional per side | $5,000 | `notionalUsd` |
| Fee per contract | $0.07 ($0.02 clearing + $0.05 exchange) | Per side, per leg |
| Contract count | `floor($5000 / (contract_size × mid))` | Rounded down |

### Contract specs (CDE nano, from API `contract_size`)

All CDE futures are nano contracts. The API returns `contract_size` as a string
giving the underlying units per contract:

| Token | Contract size | Example: $5k → n contracts |
|-------|--------------|--------------------------|
| BTC | 0.01 BTC | 6 contracts |
| ETH | 0.10 ETH | 18 contracts |
| SOL | 5 SOL | 8 contracts |
| XRP | 500 XRP | 7 contracts |
| DOGE | 5,000 DOGE | 11 contracts |
| SHIB | 10,000 SHIB | 90 contracts |
| ADA | 1,000 ADA | 22 contracts |

### Math (per fill)

When someone hits our quote on the dated future, we hedge in the perp:

```
n          = floor($5,000 / (contract_size × front_mid))
actual_notional = n × contract_size × front_mid
half_spread = 0.0005 × actual_notional          # 5bps × notional
fees        = 2 × $0.07 × n                       # future leg + perp leg
net_per_fill = half_spread − fees
```

**Verdict: profitable if net_per_fill > 0.**

### Why some tokens fail

The half-spread is fixed at ~$2.50 per fill. Fees scale with contract count:
tokens with tiny contract sizes (SHIB, AVAX, DOT, ADA) need many contracts to
reach $5k notional, so fees eat the spread.

```
Token  | n_ctr | half_spread | fees  | net    | Verdict
-------|-------|-------------|-------|--------|----------
BTC    |   6   | $2.44       | $0.84 | +$1.60 | ✅
XRP    |   7   | $2.32       | $0.98 | +$1.48 | ✅
SOL    |   8   | $2.27       | $1.12 | +$1.15 | ✅
ETH    |  18   | $2.37       | $2.52 | -$0.15 | ❌
SHIB   |  90   | $2.48       | $12.60| -$10.12| ❌
```

### Carry signal (context, not edge)

Even if per-fill edge > 0, the basis between the dated future and the perp
diverges from the perp's funding rate over time:

```
basisAPY  = (F − index) / index × (SECS_PER_YEAR / Tms_ms) × 1000
fundAPY   = funding_rate × (SECS_PER_YEAR / funding_interval_s) × 100
divergence = basisAPY − fundAPY
```

- **Positive divergence**: future is rich vs perp + funding → favors short
  future / long perp carry
- **Negative divergence**: future is cheap → favors long future / short perp

This is shown as "FrontCarry" in the Telegram message and "Carry F/B" in the
HTML. It's a *secondary* signal — the primary verdict is per-fill edge.

### Slippage

Since there's no public CDE order book, **slippage = 0** (keyless midpoint fill).
The half-spread (5 bps) is the only liquidity compensation. If you had access
to the FIX book, you could walk real depth and compute actual hedge slippage —
this model leaves that as a plug-in improvement.

## Files

| File | Role |
|------|------|
| `analysis/cde_dated_mm.js` | Pure sim: `parseProducts`, `simulateLeg`, `simulateAllTokens` |
| `monitor_cde_dated_mm.js` | Monitor: fetch API, run sim, publish Telegram + HTML |
| `references/cde_dated_mm.md` | This document |

## Usage

```bash
# One-shot dry run (console + HTML file, no Telegram)
node monitor_cde_dated_mm.js --dryrun --once

# Live monitor (polls every 60s, heartbeat to Telegram every 1h)
node monitor_cde_dated_mm.js

# Live monitor on a different port / poll interval
CDE_DATED_MM_PORT=8090 CDE_DATED_MM_POLL_MS=120000 node monitor_cde_dated_mm.js
```

### Env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `CDE_DATED_MM_PORT` | `8080` | HTML dashboard port |
| `CDE_DATED_MM_POLL_MS` | `60000` | Poll interval (ms) |
| `CDE_DATED_MM_HEARTBEAT_MS` | `3600000` | Telegram summary interval (1h) |
| `CDE_DATED_MM_WIDTH_BPS` | `10` | Bid/ask width (bps) |
| `CDE_DATED_MM_NOTIONAL` | `5000` | USD notional per side |
| `CDE_DATED_MM_FEE` | `0.07` | Fee per contract ($) |
| `CDE_DATED_MM_BOT_TOKEN` | (fallback `TELEGRAM_BOT_TOKEN`) | Telegram bot token |
| `CDE_DATED_MM_CHAT_ID` | (fallback `TELEGRAM_CHAT_ID_KALSHI`) | Telegram chat ID |

### Telegram output

The monitor sends a summary message on each heartbeat (default: hourly) with:

- Header: `🎯 CDE DATED FUTURES MM — N/17 profitable`
- Sorted table: token, front/back net edge, carry, fees, contract count
- Compact list of unprofitable tokens
- Timestamp

The full sortable table is also written to `cde_dated_mm_screen.html` and
served on `http://localhost:8080/screen`.
