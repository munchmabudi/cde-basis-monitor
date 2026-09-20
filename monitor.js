// monitor.js — v8: consolidated MM sim table across all assets

// override:true makes .env authoritative so stale Windows (HKCU) env vars
// like TELEGRAM_BOT_TOKEN cannot shadow the perp-arb credentials.
require('dotenv').config({ override: true });

const config     = require('./config');
const kalshiV    = require('./venues/kalshi_asset');
const hlV        = require('./venues/hl_asset');
const krakenV    = require('./venues/kraken_asset');
const coinbaseV  = require('./venues/coinbase_asset');
const okxV       = require('./venues/okx_asset');
const lighterV    = require('./venues/lighter');

const { evaluatePair }                                         = require('./analysis/edge');
const { record: recordSpread, rollingStats, evaluateMMThesis } = require('./analysis/spread');
const { simulate }                                             = require('./analysis/mm_sim');
const { record: recordHistory }                                = require('./analysis/history');
const { sendMessage, buildOpportunityMessage, buildHeartbeatMessage } = require('./alerts/telegram');
const { buildMMAlert, buildSpreadReport }                      = require('./alerts/spread_alert');
const { buildMMSimMessage, buildConsolidatedMMMessage, consoleOneLiner } = require('./alerts/mm_sim_alert');

const lastAlerted = {};
function isOnCooldown(key, ms) {
  const last = lastAlerted[key];
  return last && (Date.now() - last < ms);
}
function markAlerted(key) { lastAlerted[key] = Date.now(); }

let lastHeartbeat  = 0;
const HEARTBEAT_MS = 60 * 60_000;

// ── Fetch all venues for one asset ───────────────────────────────
async function fetchAsset(assetKey) {
  const asset = config.assets[assetKey];
  const [kalshi, hl, kraken, coinbase, okx, lighter] = await Promise.all([
    kalshiV.getSnapshot(asset).catch(e => ({ venue:'kalshi',      asset:assetKey, error:e.message })),
    hlV.getSnapshot(asset)    .catch(e => ({ venue:'hyperliquid', asset:assetKey, error:e.message })),
    asset.krakenTicker
      ? krakenV.getSnapshot(asset).catch(e => ({ venue:'kraken',    asset:assetKey, error:e.message }))
      : Promise.resolve(null),
    asset.coinbaseProductId
      ? coinbaseV.getSnapshot(asset).catch(e => ({ venue:'coinbase', asset:assetKey, error:e.message }))
      : Promise.resolve(null),
    asset.okxInstId
      ? okxV.getSnapshot(asset).catch(e => ({ venue:'okx',         asset:assetKey, error:e.message }))
      : Promise.resolve(null),
    lighterV.getSnapshot(asset).catch(e => ({ venue:'lighter',     asset:assetKey, error:e.message })),
  ]);
  return { kalshi, hl, kraken, coinbase, okx, lighter };
}

// ── Process one asset, return result for consolidated table ───────
async function processAsset(assetKey) {
  const snaps  = await fetchAsset(assetKey);
  const all    = [snaps.kalshi, snaps.hl, snaps.kraken, snaps.coinbase, snaps.okx, snaps.lighter].filter(Boolean);
  const errors = all.filter(s => s.error);
  const valid  = all.filter(s => !s.error);

  errors.forEach(s => console.warn(`  [${assetKey}] ⚠ ${s.venue}: ${s.error}`));

  recordHistory(assetKey, { kalshi: snaps.kalshi, hyperliquid: snaps.hl, kraken: snaps.kraken, coinbase: snaps.coinbase, okx: snaps.okx, lighter: snaps.lighter });
  valid.forEach(s => recordSpread(s));

  // Arb edges
  const edges = [];
  for (let i = 0; i < valid.length; i++)
    for (let j = i+1; j < valid.length; j++) {
      try { edges.push(evaluatePair(valid[i], valid[j], { notionalUsd: config.assets[assetKey].notionalUsd })); }
      catch(e) { edges.push({ tradeable:false, reason:e.message, longVenue:valid[i].venue, shortVenue:valid[j].venue }); }
    }

  // MM thesis + sim
  let mm = null, sim = null;
  if (snaps.kalshi && !snaps.kalshi.error && snaps.hl && !snaps.hl.error) {
    mm = evaluateMMThesis(snaps.kalshi, snaps.hl);
    try { sim = simulate(snaps.kalshi, snaps.hl, config.assets[assetKey].notionalUsd); } catch(e) {}
  }

  // Console
  const fB = n => isNaN(n||NaN)?'N/A':`${n>=0?'+':''}${n.toFixed(1)}bps`;
  const kalshiMid = snaps.kalshi?.error ? null : (snaps.kalshi.bestBid + snaps.kalshi.bestAsk) / 2;
  const priceStr = valid.map(s => {
    const m = (s.bestBid + s.bestAsk) / 2;
    const diff = kalshiMid ? ` (${(m-kalshiMid)>=0?'+':''}$${(m-kalshiMid).toFixed(m>100?2:m>1?4:6)})` : '';
    return `${s.venue}:$${m.toFixed(m>100?0:m>1?4:6)}${diff}`;
  }).join('  ');
  console.log(`  [${assetKey}] ${priceStr}`);

  const fundStr = valid.map(s => {
    const ann = s.fundingRate * (8760/s.fundingIntervalHours) * 100;
    return `${s.venue}:${ann.toFixed(2)}%`;
  }).join('  ');
  console.log(`  [${assetKey}] funding: ${fundStr}`);

  if (sim) console.log(consoleOneLiner(sim, assetKey));

  // Per-asset arb alerts
  const now = Date.now();
  let alerted = false;
  for (const edge of edges) {
    if (!edge.tradeable || !edge.aboveThreshold) continue;
    const key = `${assetKey}:${edge.longVenue}:${edge.shortVenue}`;
    if (isOnCooldown(key, config.alertCooldownMs)) continue;
    const snapA = all.find(s => s.venue === edge.longVenue);
    const snapB = all.find(s => s.venue === edge.shortVenue);
    await sendMessage(`[${assetKey}] ` + buildOpportunityMessage(edge, snapA, snapB));
    markAlerted(key); alerted = true;
  }

  return { assetKey, snaps, edges, mm, sim, alerted };
}

// ── Main poll cycle ───────────────────────────────────────────────
async function runCheck() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] Running multi-asset check...`);

  const assetKeys = Object.keys(config.assets);
  const results   = [];
  for (const key of assetKeys) {
    try { results.push(await processAsset(key)); }
    catch(e) { console.error(`[${key}] Fatal:`, e.message); }
  }

  const now      = Date.now();
  const anyAlert = results.some(r => r.alerted);

  // Build MM results for consolidated table
  const mmResults = results
    .filter(r => r.sim)
    .map(r => ({ assetKey: r.assetKey, sim: r.sim, hlSnap: r.snaps.hl, kalshiSnap: r.snaps.kalshi }));

  // Send MM table whenever any scenario turns profitable (with cooldown)
  if (mmResults.length > 0) {
    const anyProfit = mmResults.some(({sim}) =>
      ['A','B','C','D','E'].some(k => {
        const s = sim[`scenario${k}`];
        return (s.bidFill.netUsd + s.askFill.netUsd) > 0;
      })
    );
    if (anyProfit && !isOnCooldown('mm_consolidated', 30 * 60_000)) {
      await sendMessage(buildConsolidatedMMMessage(mmResults));
      markAlerted('mm_consolidated');
    }
  }

  // Hourly heartbeat: consolidated MM table + price summary
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    // 1. Price/funding summary
    const priceSummary = ['📡 <b>MULTI-ASSET PERP MONITOR</b>', ''];
    for (const r of results) {
      const { assetKey, snaps } = r;
      const all   = [snaps.kalshi, snaps.hl, snaps.kraken, snaps.coinbase, snaps.okx, snaps.lighter].filter(Boolean);
      const valid = all.filter(s => !s.error);
      const kalMid = snaps.kalshi?.error ? null : (snaps.kalshi.bestBid + snaps.kalshi.bestAsk) / 2;
      priceSummary.push(`<b>${assetKey}</b>`);
      valid.forEach(s => {
        const m   = (s.bestBid + s.bestAsk) / 2;
        const diff = kalMid && s.venue!=='kalshi' ? ` (${(m-kalMid)>=0?'+':''}$${(m-kalMid).toFixed(m>100?1:3)} vs K)` : '';
        const ann  = (s.fundingRate*(8760/s.fundingIntervalHours)*100).toFixed(3);
        priceSummary.push(`  ${s.venue}: $${m.toFixed(m>100?0:3)}${diff} | ${ann}%/yr`);
      });
      priceSummary.push('');
    }
    priceSummary.push(`🕐 ${new Date().toUTCString()}`);
    await sendMessage(priceSummary.join('\n'));

    // 2. Consolidated MM sim table (all assets × all scenarios)
    if (mmResults.length > 0) {
      await sendMessage(buildConsolidatedMMMessage(mmResults));
    }

    lastHeartbeat = now;
  }

  console.log(`[done] ${Date.now()-t0}ms\n`);
}

function start() {
  console.log('[perp-arb v8] Multi-asset: ' + Object.keys(config.assets).join(', '));
  console.log(`  Poll: ${config.pollIntervalMs/1000}s | Chart: http://localhost:3456\n`);
  runCheck().catch(e => console.error('Error:', e));
  setInterval(() => runCheck().catch(e => console.error('Error:', e)), config.pollIntervalMs);
}

if (require.main === module) { start(); }
else { module.exports = { start, runCheck }; }
