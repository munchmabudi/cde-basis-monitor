// capital_model.js — CDE MM capital-requirement model (analysis, standalone).
//
// For every CDE component in BOTH sims (perp-style CDE MM SIM + Deribit
// futures CDE MM SIM), compute the capital you must post to quote a bid AND an
// offer, then on the hedge leg to cover a full fill:
//
//   CDE leg:    notional = sizeContracts × multiplier × mid
//               cdeMargin = notional × cde.initialMarginRate   (10% = 10x, ASSUMED)
//   Hedge leg:  hedgeNotional = notional (USD-notional matched)
//               hedgeMargin = hedgeNotional / hedgeLeverage    (per venue/asset)
//
// Sums bid and offer SEPARATELY across all components, per side, plus a
// worst-case "both legs filled" total. Prints a report; exports computeCapital().
//
// NOTE on data integrity (do not fake margins):
//   - CDE IM rate = 10% DEFAULT, flagged `margin.cde.assumed` (Coinbase
//     Derivatives clearing margin is distinct from the retail perp table).
//   - Hedge leverage: HL/OKX = LIVE API; Deribit/Kraken = documented; Lighter =
//     unknown (flagged). All from config.margin.venues with source tags.

const config = require('./config');

function levFor(venue, asset) {
  const v = config.margin.venues[venue];
  if (!v) return null;
  if (v.source === 'unk') return { lev: null, source: 'unk' };
  const lev = v.byAsset[asset] ?? v.byAsset['_default'] ?? null;
  return { lev, source: v.source };
}

// mid prices: pull minimal live mids for the assets we need.
async function getMids() {
  const mids = {};
  // BTC/ETH spot via Binance public mirror (spot-only, reachable) — reliable.
  try {
    const https = require('https');
    const bin = (sym) => new Promise((res) => {
      const req = https.request({ host: 'data-api.binance.vision', path: `/api/v3/ticker/price?symbol=${sym}`, method: 'GET' },
        r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(parseFloat(JSON.parse(b).price)); } catch { res(null); } }); });
      req.on('error', () => res(null)); req.end();
    });
    mids.BTC = await bin('BTCUSDT');
    mids.ETH = await bin('ETHUSDT');
  } catch {}
  // Hyperliquid mids for the rest
  try {
    const http = require('http');
    const meta = await new Promise((res, rej) => {
      const req = http.request({ host: 'api.hyperliquid.xyz', path: '/info', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b))); });
      req.write(JSON.stringify({ type: 'metaAndAssetCtxs' })); req.on('error', rej); req.end();
    });
    const names = meta[0].universe.map(u => u.name);
    const src = { SOL:'SOL', XRP:'XRP', AVAX:'AVAX', BCH:'BCH', ADA:'ADA', LINK:'LINK', DOGE:'DOGE', LTC:'LTC', DOT:'DOT', XLM:'XLM', HBAR:'HBAR', SUI:'SUI', PEPE:'PEPE', BNB:'BNB', HYPE:'HYPE', NEAR:'NEAR', ONDO:'ONDO', ENA:'ENA', AAVE:'AAVE', ZEC:'ZEC', PAXG:'PAXG', kSHIB:'kSHIB' };
    for (const [k, coin] of Object.entries(src)) {
      if (k in mids) continue;
      const i = names.indexOf(coin);
      if (i >= 0) mids[k] = parseFloat(meta[1][i].markPx);
    }
  } catch {}
  return mids;
}

function computeForSim(assetMap, hedgeVenue, mids, label) {
  const cdeIM = config.margin.cde.initialMarginRate;
  const cdeIMc = config.margin.cde.conservativeRate;
  const rows = [];
  let bidCde = 0, offCde = 0, bidCdeC = 0, offCdeC = 0, bidHedge = 0, offHedge = 0, hedgeUnk = false;
  for (const [assetKey, cfg] of Object.entries(assetMap)) {
    const mid = mids[cfg.notionalHint];
    if (!mid) { rows.push({ assetKey, error: 'no mid' }); continue; }
    const notional = cfg.sizeContracts * cfg.multiplier * mid;
    const cdeMargin = notional * cdeIM;        // aggressive 10x / 10%
    const cdeMarginC = notional * cdeIMc;      // conservative 5x / 20%
    const h = levFor(hedgeVenue, cfg.notionalHint);
    const hedgeMargin = h.lev ? notional / h.lev : null;
    if (!h.lev) hedgeUnk = true;
    bidCde += cdeMargin; offCde += cdeMargin;
    bidCdeC += cdeMarginC; offCdeC += cdeMarginC;
    if (hedgeMargin != null) { bidHedge += hedgeMargin; offHedge += hedgeMargin; }
    rows.push({
      assetKey, notional, cdeMargin, cdeMarginC,
      hedgeVenue, hedgeLev: h.lev, hedgeSource: h.source, hedgeMargin,
    });
  }
  return { label, hedgeVenue, rows, totals: { bidCde, offCde, bidCdeC, offCdeC, bidHedge, offHedge, hedgeUnk, cdeIM, cdeIMc } };
}

function fmtUsd(n) { return n == null ? 'n/a' : '$' + Math.round(n).toLocaleString(); }

// ── Combined ALL-VENUES table ───────────────────────────────────
// One table across BOTH sims. Per token: notional, CDE margin @10%/@20%, and
// hedge margin at EVERY venue that lists that asset (HL/OKX/Deribit/Kraken/
// Coinbase/Lighter). Lighter leverage unknown → "n/a". Venue with no instrument
// for the asset → "—" (not applicable, not zero). Bottom: sums for posting a
// BID AND OFFER on all tokens (2x single-side), both CDE scenarios.
const ALL_VENUES = ['hyperliquid', 'okx', 'deribit', 'kraken', 'coinbase', 'lighter'];

// legs: [{ name, assetMap, cdeIM, cdeIMc }]  — e.g. perp (10%/20%) + futures (25%=4x)
// Each leg iterates its assetMap; all legs share the same hedge-venue leverage.
function buildCombined(legs, mids, label) {
  const rows = [];
  let sCde = 0, sCdeC = 0, sCdeFut = 0;
  const sHedge = {}; ALL_VENUES.forEach(v => sHedge[v] = 0);
  let anyUnk = false, anyNa = false;

  for (const leg of legs) {
    for (const [assetKey, cfg] of Object.entries(leg.assetMap)) {
      const mid = mids[cfg.notionalHint];
      if (!mid) { rows.push({ assetKey, simName: leg.name, error: 'no mid' }); continue; }
      const notional = cfg.sizeContracts * cfg.multiplier * mid;
      const cdeMargin = notional * leg.cdeIM;
      const cdeMarginC = notional * leg.cdeIMc;
      if (leg.cdeIMc === config.margin.cde.futuresRate) sCdeFut += cdeMargin; // fut-leg single-side total
      const hedge = {};
      for (const v of ALL_VENUES) {
        const h = levFor(v, cfg.notionalHint);
        if (h == null) { hedge[v] = 'NA'; anyNa = true; continue; }
        if (h.lev == null) { hedge[v] = 'unk'; anyUnk = true; continue; }
        hedge[v] = notional / h.lev;
        sHedge[v] += hedge[v];
      }
      sCde += cdeMargin; sCdeC += cdeMarginC;
      rows.push({ assetKey, simName: leg.name, notional, cdeMargin, cdeMarginC, hedge });
    }
  }
  return { label, rows, sums: { sCde, sCdeC, sCdeFut, sHedge }, flags: { anyUnk, anyNa } };
}

function combinedReport(table) {
  const m = config.margin.cde;
  const aggr = (m.initialMarginRate * 100).toFixed(0);
  const cons = (m.conservativeRate * 100).toFixed(0);
  const fut = (m.futuresRate * 100).toFixed(0);
  const out = [];
  out.push(`\n=== COMBINED CDE CAPITAL (perp + dated futures) — ALL HEDGE VENUES ===`);
  out.push(`CDE perp IM: ${aggr}% (10x) & ${cons}% (5x) [ASSUMED]. CDE futures IM: ${fut}% (4x) [ASSUMED].`);
  out.push(`Bid+offer = CDE 2x (both sides). Hedge = ONE side at venue leverage. Lighter lev = n/a. "—" = venue lacks instrument.\n`);
  const hdr = '  ' + 'token'.padEnd(7) + ' ' + 'leg'.padEnd(5) + ' ' + 'notional'.padStart(13) +
    ' ' + `CDE${aggr}`.padStart(9) + ' ' + `CDE${cons}`.padStart(9) + ' ' + `CDE${fut}`.padStart(9) +
    ALL_VENUES.map(v => ('h:' + v.slice(0,4)).padStart(9)).join('');
  out.push(hdr);
  for (const r of table.rows) {
    if (r.error) { out.push('  ' + r.assetKey.padEnd(7) + ' ' + r.simName.padEnd(5) + ' ' + r.error); continue; }
    const cdeFut = r.notional * config.margin.cde.futuresRate;
    let line = '  ' + r.assetKey.padEnd(7) + ' ' + (r.simName === 'perp' ? 'perp' : 'fut').padEnd(5) +
      ' ' + fmtUsd(r.notional).padStart(13) +
      ' ' + fmtUsd(r.cdeMargin).padStart(9) + ' ' + fmtUsd(r.cdeMarginC).padStart(9) + ' ' + fmtUsd(cdeFut).padStart(9);
    for (const v of ALL_VENUES) {
      const val = r.hedge[v];
      const s = (val === 'NA' || val === 'unk' || val === '—') ? val : fmtUsd(val);
      line += ' ' + s.padStart(9);
    }
    out.push(line);
  }
  // sums (single-side)
  const s = table.sums;
  let sumLine = '  ' + 'TOTAL'.padEnd(7) + ' ' + ''.padEnd(5) + ' ' + ''.padStart(13) +
    ' ' + fmtUsd(s.sCde).padStart(9) + ' ' + fmtUsd(s.sCdeC).padStart(9) + ' ' + fmtUsd(s.sCdeFut).padStart(9);
  for (const v of ALL_VENUES) sumLine += ' ' + fmtUsd(s.sHedge[v]).padStart(9);
  out.push(sumLine);
  // cheapest single hedge venue per token (realistic: you hedge on ONE venue, ONE side)
  let cheapHedge = 0;
  for (const r of table.rows) {
    if (r.error || !r.hedge) continue;
    let best = Infinity;
    for (const v of ALL_VENUES) {
      const val = r.hedge[v];
      if (typeof val === 'number' && val < best) best = val;
    }
    if (best < Infinity) cheapHedge += best;
  }
  out.push('  (cheapest single hedge venue per token, ONE side only — realistic)');
  out.push('');
  out.push('  >> Required capital to QUOTE (post bid+offer) on CDE AND hedge ONE side:');
  out.push('     CDE perp both sides = ' + fmtUsd(s.sCde * 2) + ' @' + aggr + '%   /   ' + fmtUsd(s.sCdeC * 2) + ' @' + cons + '%');
  out.push('     CDE futures both sides = ' + fmtUsd(s.sCdeFut * 2) + ' @' + fut + '% (4x)');
  out.push('     + cheapest single hedge (ONE side):');
  out.push('       TOTAL perp   @' + aggr + '%: ' + fmtUsd(s.sCde * 2 + cheapHedge) + '   (CDE ' + fmtUsd(s.sCde * 2) + ' + hedge ' + fmtUsd(cheapHedge) + ')');
  out.push('       TOTAL perp   @' + cons + '%: ' + fmtUsd(s.sCdeC * 2 + cheapHedge) + '   (CDE ' + fmtUsd(s.sCdeC * 2) + ' + hedge ' + fmtUsd(cheapHedge) + ')');
  out.push('       TOTAL fut    @' + fut + '%: ' + fmtUsd(s.sCdeFut * 2 + cheapHedge) + '   (CDE ' + fmtUsd(s.sCdeFut * 2) + ' + hedge ' + fmtUsd(cheapHedge) + ')');
  for (const v of ALL_VENUES) {
    const hv = s.sHedge[v];
    if (hv > 0) out.push('     (if hedged ONLY on ' + v + ', one side = ' + fmtUsd(hv) + ' → perp total @' + aggr + '%: ' + fmtUsd(s.sCde * 2 + hv) + ')');
  }
  if (table.flags.anyUnk) out.push('  [Lighter hedge = n/a (leverage unknown), excluded from cheapest]');
  if (table.flags.anyNa) out.push('  [some venues have no config entry for an asset]');
  return out.join('\n');
}

function report(sims) {
  const assumed = config.margin.cde.assumed;
  const aggr = (config.margin.cde.initialMarginRate * 100).toFixed(0);
  const cons = (config.margin.cde.conservativeRate * 100).toFixed(0);
  let out = [];
  out.push(`\n=== CDE MM CAPITAL REQUIREMENTS ${assumed ? '(CDE IM = ASSUMED 10%/20%)' : ''} ===`);
  out.push(`CDE initial margin: ${aggr}% (${aggr==='10'?'10x':'?'} aggressive) AND ${cons}% (${cons==='20'?'5x':'?'} conservative)  ${assumed ? '[ASSUMED — Coinbase Derivatives clearing margin not yet confirmed]' : '[confirmed]'}\n`);
  for (const s of sims) {
    out.push(`-- ${s.label} --`);
    const hv = s.hedgeVenue || '';
    const hpad = 'hedge@' + hv;
    out.push('  ' + 'asset'.padEnd(6) + ' ' + 'notional'.padStart(14) +
      ' ' + `CDE ${aggr}%`.padStart(11) + ' ' + `CDE ${cons}%`.padStart(11) +
      '  ' + hpad.padEnd(12) + ' ' + 'hedgeLev'.padStart(8) +
      ' ' + 'hedgeMargin'.padStart(12) + ' ' + 'src'.padStart(5));
    for (const r of s.rows) {
      if (r.error) { out.push('  ' + r.assetKey.padEnd(6) + ' ' + r.error); continue; }
      out.push('  ' + r.assetKey.padEnd(6) + ' ' + fmtUsd(r.notional).padStart(14) +
        ' ' + fmtUsd(r.cdeMargin).padStart(11) + ' ' + fmtUsd(r.cdeMarginC).padStart(11) +
        '  ' + r.hedgeVenue.padStart(12) + ' ' + String(r.hedgeLev).padStart(8) + ' ' + fmtUsd(r.hedgeMargin).padStart(12) + ' ' + r.hedgeSource.padStart(5));
    }
    const t = s.totals;
    out.push('  ' + 'TOTAL'.padEnd(6) + ' ' + ''.padStart(14) +
      ' ' + fmtUsd(t.bidCde).padStart(11) + ' ' + fmtUsd(t.bidCdeC).padStart(11) +
      '  ' + ''.padStart(12) + ' ' + ''.padStart(8) + ' ' + fmtUsd(t.bidHedge).padStart(12) + ' (bid hedge)');
    out.push('  >> BID side:  CDE@' + aggr + '%=' + fmtUsd(t.bidCde) + '   CDE@' + cons + '%=' + fmtUsd(t.bidCdeC) +
      '   + hedge=' + fmtUsd(t.bidHedge || 0) + '  =>  ' + aggr + '%:' + fmtUsd(t.bidCde + (t.bidHedge || 0)) + '   ' + cons + '%:' + fmtUsd(t.bidCdeC + (t.bidHedge || 0)) + (t.hedgeUnk ? '  [hedge UNKNOWN-lev]' : ''));
    out.push('  >> OFFER side: CDE@' + aggr + '%=' + fmtUsd(t.offCde) + '   CDE@' + cons + '%=' + fmtUsd(t.offCdeC) +
      '   + hedge=' + fmtUsd(t.offHedge || 0) + '  =>  ' + aggr + '%:' + fmtUsd(t.offCde + (t.offHedge || 0)) + '   ' + cons + '%:' + fmtUsd(t.offCdeC + (t.offHedge || 0)));
    out.push('  >> WORST CASE (bid+offer both filled):  ' + aggr + '%:' + fmtUsd(t.bidCde + t.offCde + (t.bidHedge || 0) + (t.offHedge || 0)) +
      '    ' + cons + '%:' + fmtUsd(t.bidCdeC + t.offCdeC + (t.bidHedge || 0) + (t.offHedge || 0)));
    out.push('');
  }
  return out.join('\n');
}


function buildCsv(table, filepath) {
  const cols = ['token', 'leg', 'notional', 'cde_margin_10pct', 'cde_margin_20pct', 'cde_margin_25pct_fut',
    'hedge_hyperliquid', 'hedge_okx', 'hedge_deribit', 'hedge_kraken', 'hedge_coinbase', 'hedge_lighter'];
  const lines = [cols.join(',')];
  const money = (n) => (typeof n === 'number' ? n.toFixed(2) : (n == null ? '' : n));
  const futRate = config.margin.cde.futuresRate;
  for (const r of table.rows) {
    if (r.error) { lines.push([r.assetKey, r.simName, '', '', '', '', '', '', '', '', '', '', r.error].join(',')); continue; }
    const cdeFut = r.notional * futRate;
    lines.push([
      r.assetKey, r.simName, money(r.notional), money(r.cdeMargin), money(r.cdeMarginC), money(cdeFut),
      money(r.hedge.hyperliquid), money(r.hedge.okx), money(r.hedge.deribit),
      money(r.hedge.kraken), money(r.hedge.coinbase), money(r.hedge.lighter),
    ].join(','));
  }
  const s = table.sums;
  lines.push([
    'TOTAL', '', '', money(s.sCde), money(s.sCdeC), money(s.sCdeFut),
    money(s.sHedge.hyperliquid), money(s.sHedge.okx), money(s.sHedge.deribit),
    money(s.sHedge.kraken), money(s.sHedge.coinbase), money(s.sHedge.lighter),
  ].join(','));
  const fs = require('fs');
  fs.writeFileSync(filepath, lines.join('\n'));
  return filepath;
}

module.exports = { computeForSim, report, levFor, buildCombined, combinedReport, buildCsv, getMids };

if (require.main === module) {
  (async () => {
    const mids = await getMids();
    const sims = [
      computeForSim(config.cde.assets, config.cde.hedgeVenues[0], mids, 'PERP CDE MM SIM (hedge: hyperliquid)'),
      computeForSim(config.cdeFutures.assets, 'deribit', mids, 'DERIBIT FUTURES CDE MM SIM (hedge: deribit)'),
    ];
    console.log(report(sims));
    // Combined all-venues table: perp (10%/20%) + dated futures (25%=4x), all tokens
    const m = config.margin.cde;
    const combined = buildCombined([
      { name: 'perp',    assetMap: config.cde.assets,        cdeIM: m.initialMarginRate, cdeIMc: m.conservativeRate },
      { name: 'fut',     assetMap: config.cde.assets,        cdeIM: m.futuresRate,       cdeIMc: m.futuresRate },
    ], mids, 'COMBINED');
    console.log(combinedReport(combined));

    // CSV output if --csv passed
    if (process.argv.includes('--csv')) {
      const out = require('path').join(__dirname, 'cde_capital_combined.csv');
      const written = buildCsv(combined, out);
      console.log('\n[csv] wrote ' + written);
    }
  })();
}
