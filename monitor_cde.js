// monitor_cde.js — CDE MM SIM standalone monitor.
//
// Model (CDE MM SIM — standalone):
//   - Quote CDE bid/ask at  refMid ∓ width  around the REFERENCE venue mid
//     (default Hyperliquid). For underlyings Hyperliquid doesn't list, fall back
//     to a keyless Coinbase SPOT mid. Assume full CDE size fills at that price
//     (CDE book never fetched).
//   - Hedge by walking one of several HEDGE venue books (perps + optional
//     futures venue), picking the cheapest fully-filling venue per leg.
//   - No CDE API key or CDE order book required.
//   - Alerts labeled "CDE MM SIM", split into MAJOR and ALT lists.
//
// Env: CDE_DRYRUN=1  => print message to console, do NOT send to Telegram
//                      (and always print, even with no profitable token, for QA).

const path = require('path');
// Load .env from THIS script's directory so the scheduled task (which may run
// with a different working directory, e.g. C:\Windows\system32) still picks up
// the Telegram credentials. override:true keeps .env authoritative over any
// stale HKCU\Environment vars.
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const config = require('./config');
const { simulateCDE } = require('./analysis/mm_sim_cde');
const { sendMessage } = require('./alerts/telegram');
const { buildOneMessage, consoleOneLinerCDE } = require('./alerts/mm_sim_cde_alert');
const { logPoll } = require('./analysis/cde_viability_logger');
const hl_asset = require('./venues/hl_asset');

const DRYRUN = !!process.env.CDE_DRYRUN;

// ── Venue registry ──────────────────────────────────────────────
const VENUES = {
  hyperliquid: hl_asset,
  kraken:      require('./venues/kraken_asset'),
  okx:         require('./venues/okx_asset'),
  coinbase:    require('./venues/coinbase_asset'),
  lighter:     require('./venues/lighter'),
  coinbase_spot: require('./venues/coinbase_spot'),
};

// Map a CDE underlying (notionalHint) to a Hyperliquid coin.
const HL_COIN = {
  BTC: 'BTC', ETH: 'ETH', SOL: 'SOL', XRP: 'XRP',
  LTC: 'LTC', DOGE: 'DOGE', AVAX: 'AVAX', LINK: 'LINK',
  SUI: 'SUI', BNB: 'BNB', HYPE: 'HYPE', DOT: 'DOT',
  XLM: 'XLM', kSHIB: 'kSHIB', HBAR: 'HBAR', BCH: 'BCH', ADA: 'ADA',
  // new alts added 2026-08-13 (underlyings listed on Hyperliquid perps)
  AAVE: 'AAVE', ONDO: 'ONDO', NEAR: 'NEAR', ENA: 'ENA',
  ZEC: 'ZEC', PEPE: 'PEPE', PAXG: 'PAXG',
  // COIN50: index, no Hyperliquid/spot feed — left out (sim shows no data)
};

const lastAlerted = {};
function isOnCooldown(key, ms) { const last = lastAlerted[key]; return last && (Date.now() - last < ms); }
function markAlerted(key) { lastAlerted[key] = Date.now(); }

let lastHeartbeat = 0;
const HEARTBEAT_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

async function fetchSnap(name, arg) {
  const mod = VENUES[name];
  if (!mod) return { venue: name, error: 'no module' };
  const withTimeout = Promise.race([
    mod.getSnapshot(arg).catch(e => ({ venue: name, error: e.message })),
    new Promise(r => setTimeout(() => r({ venue: name, error: 'timeout' }), FETCH_TIMEOUT_MS)),
  ]);
  return withTimeout;
}

// ── Process one CDE asset ────────────────────────────────────────
async function processAsset(assetKey) {
  const cdeCfg = config.cde.assets[assetKey] || {};
  const refName = config.cde.referenceVenue || 'hyperliquid';
  const spotName = config.cde.spotFallbackVenue || 'coinbase_spot';
  const hedgeNames = config.cde.hedgeVenues || ['hyperliquid', 'kraken', 'okx', 'lighter'];

  const underlying = cdeCfg.notionalHint;            // e.g. 'BTC', 'kSHIB'
  const refAsset = config.assets[underlying] || (HL_COIN[underlying] ? { hlCoin: HL_COIN[underlying] } : undefined);
  // Some underlyings have a spot feed but no Hyperliquid book (e.g. PEPE). Force
  // the keyless Coinbase SPOT fallback for those so they still get a ref mid.
  // (Tokens with no feed at all — e.g. COIN50 index — stay on HL and show no data.)
  const forceSpotRef = !!cdeCfg.refSpotFallback;

  // Reference snapshot: HL if we have a mapping (and HL lists it), else keyless Coinbase spot.
  const refFetchName = (refAsset && !forceSpotRef) ? refName : spotName;
  const refArg = (refAsset && !forceSpotRef) ? refAsset : underlying;

  // Hedge asset override (e.g. 1kPEPE hedged with HL kPEPE = 1000 PEPE/coin).
  // The hedge walk is in USD notional, so the per-PEPE unit conversion is handled
  // by the venue's price — no explicit multiplier. Defaults to refAsset.
  const hedgeAsset = cdeCfg.hedgeCoin ? { hlCoin: cdeCfg.hedgeCoin } : refAsset;

  // Hedge venues need the asset object (for their ticker/instId); if no mapping,
  // they'll return "no data" and that token is skipped (can't hedge it).
  // NOTE: coinbase_spot is ONLY a reference-mid fallback — never a hedge venue
  // (it has no walkable order book). Exclude it from the hedge pool so alts that
  // fall back to spot for the ref mid don't get a phantom spot "hedge" fill.
  const hedgePool = hedgeNames.filter(n => n !== spotName);
  const venueNames = Array.from(new Set([refFetchName, ...hedgePool]));
  const snaps = await Promise.all(venueNames.map(n => fetchSnap(n, n === refFetchName ? refArg : hedgeAsset)));

  const byName = {};
  snaps.forEach(s => { if (s && !s.error) byName[s.venue] = s; });
  const errors = snaps.filter(s => !s || s.error);
  errors.forEach(s => console.warn(`  [${assetKey}] ⚠ ${s.venue}: ${s.error}`));

  const refSnap = byName[refFetchName];
  const valid   = Object.values(byName);

  if (!refSnap || valid.length === 0) {
    console.warn(`  [${assetKey}] CDE sim skipped (no reference/hedge data)`);
    return { assetKey, cdeCfg, sim: null };
  }

  const sim = simulateCDE(refSnap, valid, cdeCfg);
  console.log(`  [${assetKey}] ref(${refSnap.venue}/${underlying}) mid=$${(refSnap.bestBid + refSnap.bestAsk) / 2} | ${sim.cdeFullContracts} ctr @ $${Math.round(sim.notional)}`);
  console.log(consoleOneLinerCDE(sim, assetKey));

  return { assetKey, cdeCfg, sim, refSnap };
}

// ── Main poll cycle ──────────────────────────────────────────────
async function runCheck() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] CDE MM SIM check...`);

  const assetKeys = Object.keys(config.cde.assets);
  const results = [];
  for (const key of assetKeys) {
    try { results.push(await processAsset(key)); }
    catch (e) { console.error(`[${key}] Fatal:`, e.message); }
  }

  const cdeResults = results.filter(r => r.sim);
  if (cdeResults.length === 0) { console.log(`[done] ${Date.now() - t0}ms (no data)\n`); return; }

  const anyProfit = cdeResults.some(({ sim }) => {
    const s = sim.scenarioA;
    return s && (s.bidFill.netUsd + s.askFill.netUsd) > 0;
  });

  // Build Major + Alt as TWO separate messages (Telegram 4096-char cap).
  const msgMajor = buildOneMessage(cdeResults, 'Major');
  const msgAlt   = buildOneMessage(cdeResults, 'Alt');

  if (DRYRUN) {
    if (msgMajor) console.log(`[DRYRUN] would send:\n${msgMajor}`);
    if (msgAlt)   console.log(`[DRYRUN] would send (ALT):\n${msgAlt}`);
  } else if (anyProfit) {
    if (!isOnCooldown('cde_major', config.alertCooldownMs)) {
      if (msgMajor) await sendMessage(msgMajor);
      markAlerted('cde_major');
    }
    if (!isOnCooldown('cde_alt', config.alertCooldownMs)) {
      if (msgAlt) await sendMessage(msgAlt);
      markAlerted('cde_alt');
    }
  }

  // Heartbeat (live only): send both sections regardless of profit.
  const now = Date.now();
  if (!DRYRUN && now - lastHeartbeat >= HEARTBEAT_MS) {
    if (msgMajor) await sendMessage(msgMajor);
    if (msgAlt)   await sendMessage(msgAlt);
    lastHeartbeat = now;
  }

  // Persist this poll's per-token viability snapshot (append-only, guarded).
  logPoll(results);

  console.log(`[done] ${Date.now() - t0}ms\n`);
}

function start() {
  console.log('[cde-mm-sim] assets: ' + Object.keys(config.cde.assets).join(', '));
  console.log(`  ref=${config.cde.referenceVenue} hedge=${(config.cde.hedgeVenues || []).join(',')} poll=${config.pollIntervalMs / 1000}s DRYRUN=${DRYRUN}`);
  runCheck().catch(e => console.error('Error:', e));
  setInterval(() => runCheck().catch(e => console.error('Error:', e)), config.pollIntervalMs);
}

if (require.main === module) { start(); }
else { module.exports = { start, runCheck, processAsset }; }
