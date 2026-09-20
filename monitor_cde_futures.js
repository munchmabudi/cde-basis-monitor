// monitor_cde_futures.js — SEPARATE CDE MM SIM fed by Deribit.
//
// Same engine (analysis/mm_sim_cde simulateCDE) and same KPIs as monitor_cde.js
// (half-spread − best hedge cost − $0.02/contract), but the reference + hedge
// venue is Deribit's live L2 book (public WS, no auth). Scope: MAJORS only.
//
//   - Perp future (BTC-PERPETUAL …) = reference anchor AND hedge leg (basis ≈ spot).
//   - Dated futures (BTC-29AUG25 …) = BASIS READOUT only (reference overlay), not
//     a hedge — term-structure carry is surfaced, not crossed, until modeled.
//
// Runs as its own Windows scheduled task "CDE FUTURES MM SIM" so it is fully
// independent of the perp-style CDE MM SIM (different process, same Telegram chat,
// distinct [DERIBIT] alert header).
//
// Env: CDE_FUT_DRYRUN=1 => print to console, do NOT send to Telegram.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const config = require('./config');
const { simulateCDE } = require('./analysis/mm_sim_cde');
const { sendMessage } = require('./alerts/telegram');
const { buildOneMessage, consoleOneLinerCDE } = require('./alerts/mm_sim_cde_alert');
const deribit = require('./venues/deribit');

const DRYRUN = !!process.env.CDE_FUT_DRYRUN;
const FCFG = config.cdeFutures;

const lastAlerted = {};
function isOnCooldown(key, ms) { const l = lastAlerted[key]; return l && (Date.now() - l < ms); }
function markAlerted(key) { lastAlerted[key] = Date.now(); }

const HEARTBEAT_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
let lastHeartbeat = 0;

async function fetchSnap(arg) {
  const withTimeout = Promise.race([
    deribit.getSnapshot(arg).catch(e => ({ venue: 'deribit', error: e.message })),
    new Promise(r => setTimeout(() => r({ venue: 'deribit', error: 'timeout' }), FETCH_TIMEOUT_MS)),
  ]);
  return withTimeout;
}

async function processAsset(assetKey) {
  const cdeCfg = FCFG.assets[assetKey] || {};
  const inst = FCFG.instruments[cdeCfg.notionalHint];
  if (!inst) return { assetKey, cdeCfg, sim: null };

  // ensure perp (ref+hedge) AND dated (basis readout) books are subscribed
  await deribit.client.ensure(inst.perp);
  for (const d of (inst.dated || [])) await deribit.client.ensure(d);

  // perp future = ref + hedge
  const snaps = await Promise.all([fetchSnap(inst.perp)]);
  const refSnap = snaps[0];
  if (!refSnap || refSnap.error) {
    console.warn(`  [${assetKey}] ⚠ deribit ${inst.perp}: ${refSnap && refSnap.error}`);
    return { assetKey, cdeCfg, sim: null };
  }
  const valid = snaps.filter(s => s && !s.error);
  const sim = simulateCDE(refSnap, valid, { ...cdeCfg, feePerContractUsd: FCFG.feePerContractUsd });
  console.log(`  [${assetKey}] deribit(${inst.perp}) mid=$${(refSnap.bestBid + refSnap.bestAsk) / 2} | ${sim.cdeFullContracts} ctr @ $${Math.round(sim.notional)}`);
  console.log(consoleOneLinerCDE(sim, assetKey));
  return { assetKey, cdeCfg, sim, refSnap, inst };
}

// basis readout: mid of each dated future vs perp mid, in bps
function basisReadout(results) {
  const lines = ['<b>── Dated-future BASIS (Deribit, perp vs front-dated) ──</b>'];
  for (const { assetKey, inst, refSnap } of results) {
    if (!inst || !refSnap) continue;
    const perpMid = (refSnap.bestBid + refSnap.bestAsk) / 2;
    const dated = inst.dated.map(name => {
      const b = deribit.getBook(name);
      if (!b || b.bids.size === 0 || b.asks.size === 0) return null;
      const bid = Math.max(...b.bids.keys());
      const ask = Math.min(...b.asks.keys());
      const mid = (bid + ask) / 2;
      const bps = (mid / perpMid - 1) * 1e4;
      return `${name.replace('-PERPETUAL', '')}: ${bps >= 0 ? '+' : ''}${bps.toFixed(1)}bp`;
    }).filter(Boolean);
    lines.push(`  ${assetKey.padEnd(5)} perp $${perpMid.toLocaleString()}  ${dated.join('  ') || '—'}`);
  }
  return lines.join('\n');
}

async function runCheck() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] CDE FUTURES MM SIM (Deribit) check...`);
  const assetKeys = Object.keys(FCFG.assets);
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

  const msg = buildOneMessage(cdeResults, 'Major', 'CDE FUTURES MM SIM [DERIBIT]');
  const basis = basisReadout(results);
  const full = (msg ? msg + '\n\n' : '') + basis + `\n\n🕐 ${new Date().toUTCString()}`;

  if (DRYRUN) {
    console.log(`[DRYRUN] would send:\n${full}`);
  } else if (anyProfit && !isOnCooldown('cde_fut', config.alertCooldownMs)) {
    await sendMessage(full);
    markAlerted('cde_fut');
  }

  const now = Date.now();
  if (!DRYRUN && now - lastHeartbeat >= HEARTBEAT_MS) {
    await sendMessage(full);
    lastHeartbeat = now;
  }
  console.log(`[done] ${Date.now() - t0}ms\n`);
}

function start() {
  console.log('[cde-futures-mm-sim] assets: ' + Object.keys(FCFG.assets).join(', '));
  console.log(`  venue=deribit(WS) poll=${config.pollIntervalMs / 1000}s DRYRUN=${DRYRUN}`);
  runCheck().catch(e => console.error('Error:', e));
  setInterval(() => runCheck().catch(e => console.error('Error:', e)), config.pollIntervalMs);
}

if (require.main === module) { start(); }
else { module.exports = { start, runCheck, processAsset }; }
