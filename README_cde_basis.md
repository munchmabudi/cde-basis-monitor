# CDE Basis vs Perp Funding Monitor

Live monitor + dashboard comparing CDE **dated futures basis** against **perp-style funding**
on the same underlying, to answer: *which is cheaper to hold long right now?*

## Run
```
node monitor_cde_basis.js                 # live: dashboard + poll loop
node monitor_cde_basis.js --once          # one poll, log, exit
node monitor_cde_basis.js --dryrun        # console summary instead of nothing (logs still)
node monitor_cde_basis.js --port 8099 --poll 30000
```
**Heap note**: for large logs (>100K polls / ~800MB), launch with extra heap:
```
node --max-old-space-size=8192 monitor_cde_basis.js
```
Without this, the 4GB default V8 limit can be exceeded during stats recomputation on large log files.

Env: `CDE_BASIS_PORT`, `CDE_BASIS_POLL_MS`, `CDE_BASIS_ONCE`, `CDE_BASIS_DRYRUN`, `CDE_BASIS_LOG`.
Dashboard: `http://localhost:<port>/` (auto-refresh 5s). JSON: `/api/snapshot`. Health: `/health`.

## Files
- `analysis/cde_basis.js` — pure parsing + calculators + append-only JSONL logger.
  Exports: `buildSnapshot(fut, spot)`, `logPoll(snap)`, constants, unit-testable math fns.
- `monitor_cde_basis.js` — REST poll (no auth) + `http` dashboard server.
- `data/cde_basis_LOG.jsonl` — one line per poll: `{t, tokens:{ROOT:{v,bApy,fApy,gap,aD,aP,div,fl}}}`.

## Data source (public, no auth)
`GET https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE`
`GET ...?product_type=SPOT`

## VERIFIED facts (from live pulls — do not "trust" the API spec blindly)
- ALL 100 futures return `contract_expiry_type="EXPIRING"` (incl. perps). Discriminator is
  **`funding_interval` presence**: 29 have `"3600s"` (perp-style), 71 don't (dated).
- Perp `funding_rate` is a **decimal, can be NEGATIVE** (e.g. TEK -0.00001). Annualize with
  **8760/yr** (hourly), NOT 1095 (8h).
- Perp `index_price` is the canonical S (present on all 29 perp-style). Dated futures have
  **no index_price**.
- Use `mid_market_price` for F/P (true mid). `price` = last trade and differs.
- **Spot feed is scale-inconsistent** for some roots (SHIB-USD is 1000x smaller than SHIB futures).
  Fix already applied: when a perp exists, S = perp `index_price` for BOTH legs; spot feed is
  only a dated-only fallback, and only if within 50% of the future mid (phantom-pair guard).
- Some dated contracts report `mid=0` (stale/no-trade) → dropped from basis (stale-mid guard).
- 17 tokens have BOTH dated+perp; 12 perp-only; 7 dated-only synthetic (CDE*) with no spot
  (`NO_S` flag, basis uncomputable via this API → out of scope).
- `approximate_quote_24h_volume` = USD notional → use for `LOW_LIQ` flag (threshold 100k).

## Math (long-side carry; positive = costs the long)
- Dated basis APY = `(F-S)/S * (365*24*3600*1000 / Tms) * 100`
- Perp funding APY = `funding_rate * 8760 * 100`
- Perp gap % = `(P - index)/index * 100`
- All-in over horizon h (ms): dated `(F-S)/S*(h/T)*100`; perp `gap% + funding_rate*(h/1000/sec)*100`
- Cheaper-to-LONG = lower all-in. Spread trade = short expensive / long cheap.
- Default horizon h = the token's front-dated `time_to_expiry` (hold future to expiry).

## Guardrails (already enforced)
- No bid/ask exists on this API → never synthesize a tradeable spread; show MID-based directional
  signal only.
- Phantom-pair / scale-mismatch guard (50% band vs anchor mid).
- Stale-mid guard (mid<=0 dropped).
- Flags: `NEAR_DATED` (<30d, noisy), `LOW_LIQ`, `NO_S` / `NO_S_DATED`.
- Logging never throws into the monitor (guarded fs).

## What Claude Code should review / improve
1. **Robustness**: poll-failure handling, exponential backoff, partial-response tolerance
   (API returns paginated `products` — verify it's complete; 100 futures fits one page for now).
2. **Dedup of FUTURE+SPOT calls**: spot products are 923 — build the map once per poll (fine,
   but could cache across polls if rate-limited).
3. **Dated-only tokens with no spot**: surface S from an external spot source (Coinbase spot
   `price` is unreliable for scale — consider the perp index of a sister venue, or skip).
4. **Alerting**: threshold-cross alerts on `divergence` (basis−funding) via Telegram (the repo
   already has `alerts/` infra — wire `config.alertCooldownMs` parity).
5. **History dashboard**: sparkline of `divergence` per token from the JSONL log (regime tracking
   we discussed — funding stickier in regime, basis converges at expiry).
6. **Config**: pull poll interval / port / thresholds / token allowlist into `config.js` rather
   than argv/env only, to match repo conventions.
7. **Windows service**: document turning this into a scheduled task / PM2 for 24/7 (mirror the
   existing `CDE MM SIM` Win task).
8. **Unit tests**: the pure fns in `analysis/cde_basis.js` are testable — add a test file.
9. **Respect the data-integrity rule**: never pad the dashboard with phantom pairs; state
   "no tradeable" plainly when guards fire.
