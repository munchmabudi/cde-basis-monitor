// gen_capital_csv.js — emits capital_explorer.csv from the DATA already embedded
// in capital_explorer.html (no network; perfectly consistent with the HTML).
// Columns mirror the HTML explorer's default scenario (CDE perp 10x / futures 4x,
// hedge = cheapest per token) and add stipend / RoR / leverage / 2x-3x presets.
// Run: node gen_capital_csv.js
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'capital_explorer.html'), 'utf8');
const start = html.indexOf('const DATA = ') + 'const DATA = '.length;
const end = html.indexOf(';\nconst VENUE_SHORT');
if (start < 0 || end < 0) { console.error('Could not locate embedded DATA'); process.exit(1); }
const DATA = JSON.parse(html.slice(start, end));
const VIA = (DATA.viability && DATA.viability.via) ? DATA.viability.via : {};

// RAW numeric (2 decimals, no thousands commas) so CSV parses cleanly in Sheets.
const usd = n => (typeof n === 'number' ? n.toFixed(2) : '');
const fmtN = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '');

const rows = DATA.rows;
const out = [];
out.push([
  'token','leg','notional',
  'cde_margin_default_one_side','cde_margin_default_both_sides',
  'cde_margin_conservative_one_side','cde_margin_2x_both_sides','cde_margin_3x_both_sides',
  'hedge_cheapest','hedge_hyperliquid','hedge_okx','hedge_deribit','hedge_kraken','hedge_coinbase','hedge_lighter',
  'hedge_lev_cheapest','weekday_stipend','weekend_stipend','stipend_total',
  'total_capital','ror_pct','viability_24h_pct','viability_7d_pct'
].join(','));

for (const r of rows) {
  const cdeDefaultOne = r.leg === 'fut' ? r.cde25 : r.cde10;     // 10x perp / 25% fut
  const cdeDefaultBoth = cdeDefaultOne * 2;                       // both sides (bid+offer)
  const cdeConservativeOne = r.leg === 'fut' ? r.cde25 : r.cde20; // 20% perp conservative
  const cde2xBoth = r.notional * 0.50 * 2;                        // 2x -> 50% IM, both sides
  const cde3xBoth = r.notional * 0.3333 * 2;                      // 3x -> 33% IM, both sides

  // cheapest hedge (min numeric across venues)
  let hedgeCheapest = Infinity;
  for (const v of DATA.venues) { const x = r.hedge[v]; if (typeof x === 'number' && x < hedgeCheapest) hedgeCheapest = x; }
  if (hedgeCheapest === Infinity) hedgeCheapest = 0;

  // cheapest-lev venue (min numeric leverage)
  let levVenue = null, levVal = Infinity;
  for (const v of DATA.venues) { const l = r.lev[v]; if (typeof l === 'number' && l < levVal) { levVal = l; levVenue = v; } }
  const levTxt = levVenue ? (levVal + 'x @' + levVenue) : 'n/a';

  const isAlt = !DATA.majors.includes(r.assetKey);
  const st = DATA.stipend[r.leg][isAlt ? 'alt' : 'major'];
  const stipTotal = st.weekday + st.weekend;

  const totalCap = cdeDefaultBoth + hedgeCheapest;
  const ror = totalCap > 0 ? (stipTotal / totalCap * 100) : 0;

  const via = VIA[r.assetKey] || {};
  const v24 = (via.v24 != null) ? via.v24.toFixed(2) : '';
  const v7  = (via.v7  != null) ? via.v7.toFixed(2)  : '';

  const cell = (n, d) => (typeof n === 'number' ? (d != null ? n.toFixed(d) : n) : '');
  out.push([
    r.assetKey, r.leg, usd(r.notional),
    usd(cdeDefaultOne), usd(cdeDefaultBoth),
    usd(cdeConservativeOne), usd(cde2xBoth), usd(cde3xBoth),
    usd(hedgeCheapest),
    usd(r.hedge.hyperliquid), usd(r.hedge.okx), usd(r.hedge.deribit),
    usd(r.hedge.kraken), usd(r.hedge.coinbase), usd(r.hedge.lighter),
    levTxt,
    usd(st.weekday), usd(st.weekend), usd(stipTotal),
    usd(totalCap), fmtN(ror), v24, v7
  ].join(','));
}

const csvPath = path.join(__dirname, 'capital_explorer.csv');
fs.writeFileSync(csvPath, out.join('\n') + '\n');
console.log('[gen] wrote ' + csvPath + '  (' + rows.length + ' rows)');
