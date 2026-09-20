# CDE Basis vs Perp Funding — Complete Spec & Build-Out

> Self-contained briefing for a code-build/code-review agent (e.g. Claude Code).
> Everything below is VERIFIED against live public API pulls on 2026-08-19/20, not assumed.

> **Source of truth for code:** the raw files `analysis/cde_basis.js` and `monitor_cde_basis.js`
> (in this same dir). Share those directly for review — do NOT re-bundle code into a markdown
> wrapper; that drifted stale once and the `.js` files are the only authoritative source. This
> `.md` is the narrative/math/spec doc only.

---

## GROUP 1 — THE MATH (APYs to compare)

Goal: decide, per underlying, **which is cheaper to hold LONG right now**: the dated future or the perp-style future. All cost numbers are **long-side carry** (positive = costs the long).

### Inputs
- `F` = dated future mid price
- `P` = perp-style future mid price
- `S` = spot/index price for the underlying
- `Tms` = dated future time-to-expiry in **milliseconds**
- `funding_rate` = per-period funding decimal (CAN BE NEGATIVE)
- `funding_interval` = e.g. `"3600s"` → `fundingSec = 3600`
- `hMs` = hold horizon in ms (default = the token's front-dated `Tms`)

### Formulas
```
periodsPerYear(sec) = 365*24*3600 / sec          // hourly => 8760

datedBasisAPY   = (F - S)/S * (365*24*3600*1000 / Tms) * 100
perpFundingAPY  = funding_rate * periodsPerYear(sec) * 100
perpGapPct      = (P - S)/S * 100                 // instantaneous rich/cheap vs index

allInDatedPct(F,S,Tms,hMs) = (F - S)/S * (hMs / Tms) * 100
allInPerpPct(P,S,rate,sec,hMs) = perpGapPct + rate*(hMs/1000/sec)*100
```
- **Cheaper-to-LONG** = lower all-in cost. Spread trade = short the expensive leg, long the cheap leg.
- **Divergence signal** = `datedBasisAPY - perpFundingAPY` (hold-dated-to-expiry view).
  - `> 0` → future is **rich** → short future / long perp captures the spread.
  - `< 0` → perp is **rich** → long future / short perp.

### Horizon caveat (critical)
`allInDated` only fully realizes at expiry. Over a shorter hold `h < T`, it scales by `h/T`.
Funding accrues continuously (`h/period`). For a real hold `h`, compare the two **actual** dollar
carries over `h`, not the full-year APYs. (Worked live example: over an 8.74d BTC hold, the perp's
cheap entry gap beat the annualized-funding view and flipped the verdict.)

---

## GROUP 2 — BEST WAY TO GET API DATA

### Endpoint (PUBLIC, NO AUTH)
```
GET https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE
GET https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT
```
- Both return `num_products` = array length, `pagination.has_next = false` → **complete in one page**
  (100 futures, 923 spot verified). NO pagination handling needed today.
- Bothenvelope: `{ products: [...], num_products, pagination:{has_next,has_prev,next_cursor,prev_cursor} }`.

### Field path (per future product)
`product.future_product_details.<field>`:
- `contract_root_unit` — underlying key (BTC, ETH, … ; CDE-prefixed for synth). USE THIS to pair legs.
- `contract_code` — ticker prefix (BIT, BIP, …).
- `contract_expiry_type` — **ALWAYS "EXPIRING"** (even for perps). IGNORE as a discriminator.
- `funding_interval` — `"3600s"` present ⇒ **perp-style**; absent ⇒ **dated**. (THE real split.)
- `funding_rate` — decimal, **can be negative**.
- `funding_time` — next funding payment ISO.
- `index_price` — present **only** on perp-style; this is the canonical `S`.
- `time_to_expiry_ms` — present on all 100; used for dated basis annualization.
- `contract_size`, `contract_expiry`, `open_interest`, `settlement_price`.
- `product.mid_market_price` — **use this for F and P** (true mid; `product.price` = last trade, differs).
- `product.approximate_quote_24h_volume` — USD notional → liquidity flag.
- `product.best_bid_price` / `best_ask_price` — **empty strings** (no public book). Never synthesize a spread.

### Spot product
`product_id` like `BTC-USD`, `product.price` = mid. Used only as a dated-only fallback for `S`.

### VERIFIED corrections vs naive assumptions
1. Perp S = `index_price` on the perp-style contract, NOT the separate spot call.
2. **Spot feed is scale-inconsistent** for some roots: `SHIB-USD` spot = 0.00000469 while SHIB
   futures mid = 0.004685 (1000× smaller). Feeding that as `S` produced a 99,894% PHANTOM basis.
   → When a perp exists, `S = perp.index_price` for BOTH legs. Spot feed only used for dated-only
   roots, gated by a 50%-band phantom-pair guard vs the future mid.
3. Stale-mid guard: some dated contracts report `mid = 0` → drop from basis.
4. CDE perp funding is **hourly** (8760/yr), not 8h (1095).
5. `funding_rate` negative on some perps (e.g. TEK −0.00001) → FundAPY can be negative.

---

## GROUP 3 — CONTRACT SPECS (verified universe)

- **100 futures total**: 29 perp-style (hourly funding) + 71 dated.
- **17 both (dated + perp):** ADA, AVAX, BCH, BNB, BTC, DOGE, DOT, ETH, HBAR, HYPE, LINK, LTC, SHIB, SOL, SUI, XLM, XRP
- **12 perp-only:** AAVE, ENA, NEAR, ONDO, PAXG, PEPE, ZEC + 5 synth (CDEAI, CDECHN, CDEDEF, CDETEK, CDEUS5)
- **7 dated-only synth (NO spot, NO perp):** CDECU, CDEGLD, CDEMC, CDENGS, CDEOIL, CDEPT, CDESIL → `NO_S`, out of scope.
- **BNB has both** (BNF dated + BNB-20DEC30 perp). ADA/DOGE/DOT/XLM/HBAR/BCH all have perps.
- Contract sizes (from API, authoritative): BTC 0.01, ETH 0.1, SOL 5, XRP 500, DOGE 5000, AAVE 5, PAXG 1, BNB 1, etc.

### Flags the monitor emits
`NEAR_DATED` (<30d to expiry — noisy/basis converges fast), `LOW_LIQ` (24h USD vol < 100k),
`NO_S` (no valid spot/index), `NO_S_DATED` (perp present but dated S rejected).

---

## BUILD-OUT PROCESS (what was actually written & verified)

Two Node (CommonJS, Node 24) files in `OneDrive/Desktop/perp-arb/`:

1. **`analysis/cde_basis.js`** — pure parsing + calculators + append-only JSONL logger.
   - `buildSnapshot(fut, spot)` → `{generatedAt, horizonDays, rows[]}`.
   - `logPoll(snap)` → appends `{t, tokens:{ROOT:{v,bApy,fApy,gap,aD,aP,div,fl}}}` to `data/cde_basis_LOG.jsonl`.
   - Exports all pure math fns for unit testing.
   - Verified: 36 token rows, sane APYs, phantom basis eliminated.

2. **`monitor_cde_basis.js`** — `fetchJSON` (AbortController 15s timeout) both endpoints in parallel,
   `buildSnapshot`, `logPoll`, then an `http` dashboard (dark table, auto-refresh 5s, `/api/snapshot`,
   `/health`). `setInterval` poll loop. CLI: `--once --port --poll --dryrun`; env overrides.
   - Verified: live poll ~340ms, dashboard served 36 rows, JSON snapshot returns 36 rows.

### Verification done
- Live pulls of both endpoints (100/100, 923/923, complete pages).
- Per-token BTC math matches by hand (basisAPY 19.5%, funding 19.3%).
- SHIB phantom-basis caught + fixed (scale guard).
- Stale-mid (`mid=0`) handled.
- Dashboard HTTP + JSON served successfully in a live background run.

### Known gaps for v1 (out of scope, noted for next phase)
- No historical funding (needs CDP API key — `GET /api/v1/instruments/{id}/funding`).
- No real-time bid/ask (needs INTX WebSocket LEVEL1 channel).
- Dated-only synth tokens have no computable S.
- Not yet a Windows service / scheduled task (mirror existing `CDE MM SIM` pattern).
- No Telegram alerts yet (repo has `alerts/` infra to wire).

---

## REVIEW STATUS (Claude Code pass, 2026-08-20 — all 7 findings resolved)

1. **[FIXED] Silent null funding in `allInPerpPct`.** Added `rate == null` guard so a missing
   funding rate returns `null` (not `0`), instead of silently dropping the funding leg and
   risking a wrong "cheaper to LONG" verdict. Mirrors the existing `perpFundingAPY` guard.
2. **[FIXED] Horizon override wired.** `buildSnapshot` accepts `opts.horizonDays`; `monitor_cde_basis.js`
   now reads `--horizon-days N` / `CDE_BASIS_HORIZON_DAYS` and applies it as a global hold window for
   ALL rows (not just each token's own expiry). Verified: 5-day hold shrinks/converges all-in vs
   hold-to-expiry — the exact sign-flip scenario the spec flagged. `snap.horizonOverride` flags it.
3. **[FIXED] Bind localhost only.** `server.listen(PORT, '127.0.0.1', ...)`; removed
   `access-control-allow-origin: *`. Data no longer reachable off-box.
4. **[FIXED] Non-transitive sort.** Replaced with a strict total order: dated-leg tokens first
   (by basisAPY desc), then non-dated (by root asc). Deterministic across V8 versions.
5. **[FIXED] Dead ternary.** `oi: num(d.open_interest)` (the `p.future_product_details ?` branch was
   unreachable since `d` is already that object).
6. **[FIXED] Perp stale-mid guard.** Added `perpMidOk = perp && perp.mid > 0`; `perpGapPct` and
   `allInPerpPct` now return `null` on `mid=0` (was silently computing −100% gap).
7. **[FIXED] Misleading dashboard subtitle.** Horizon label now states whether it's a global override
   ("all rows") or per-row ("each row uses its own front-dated expiry").

Verified with a 10-case unit harness (null-rate, horizon flip, perp stale-mid, sort total-order) —
all pass — plus live `--once` polls (36 rows, ~300ms) and a localhost-bind reachability check.

---

## NEXT PHASE — mean-reversion / z-score on history (the user's stated next step)
Once `data/cde_basis_LOG.jsonl` accumulates polls, layer:
- Rolling mean/σ of `divergence` (basis−funding) per token → **z-score**.
- `z > +2` ⇒ future historically rich vs perp → short-future/long-perp is statistically stretched.
- `z < −2` ⇒ perp rich → reverse.
- Per-token **historical ranges** (min/max/percentile) of basisAPY, fundAPY, gap.
- Regime detection: funding stickier in trend (persists), basis converges at expiry (mean-reverts to 0 at T).
- Suggested: a second module `analysis/cde_basis_stats.js` reading the JSONL (mirror the existing
  `analysis/cde_viability_logger.js` `rollup()` pattern) + a sparkline column on the dashboard.
