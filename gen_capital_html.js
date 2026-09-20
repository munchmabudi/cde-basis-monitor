// gen_capital_html.js — generates an interactive standalone HTML capital explorer.
// Run: node gen_capital_html.js   ->  writes capital_explorer.html
// The HTML has dropdowns: tokens to include, strategy (perp/futures/both),
// CDE leverage scenario, hedge venue. Recomputes client-side, no server needed.
// THIS FILE IS A BUILD TOOL — not part of the running monitors. Delete anytime.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getMids, buildCombined, levFor } = require('./capital_model');
// Viability: read the CDE MM SIM append-only log (if present) and roll up 24h/7d.
let VIA = { empty: true };
try {
  const { rollup } = require('./analysis/cde_viability_logger');
  const r24 = rollup(24 * 3600 * 1000);
  const r7  = rollup(7 * 24 * 3600 * 1000);
  const via = {};
  const vkeys = new Set([...Object.keys(r24.perToken || {}), ...Object.keys(r7.perToken || {})]);
  for (const k of vkeys) {
    const a = (r24.perToken || {})[k], b = (r7.perToken || {})[k];
    via[k] = {
      v24: a && a.eitherPct != null ? a.eitherPct : null,
      n24: a && a.ok != null ? a.ok : 0,
      v7:  b && b.eitherPct != null ? b.eitherPct : null,
      n7:  b && b.ok != null ? b.ok : 0,
    };
  }
  VIA = { via, empty: Object.keys(via).length === 0, generatedAt: r24.generatedAt };
} catch (e) {
  VIA = { empty: true, error: e.message };
}

(async () => {
  const mids = await getMids();
  const m = config.margin.cde;
  const ALL_VENUES = ['hyperliquid', 'okx', 'deribit', 'kraken', 'coinbase', 'lighter'];

  // Futures leg only for tokens that actually have a CDE dated future product.
  const futAssets = {};
  for (const k of m.futuresTokens) if (config.cde.assets[k]) futAssets[k] = config.cde.assets[k];

  const combined = buildCombined([
    { name: 'perp', assetMap: config.cde.assets, cdeIM: m.initialMarginRate, cdeIMc: m.conservativeRate },
    { name: 'fut',  assetMap: futAssets,          cdeIM: m.futuresRate,       cdeIMc: m.futuresRate },
  ], mids, 'COMBINED');

  const rows = combined.rows
    .filter(r => !r.error)
    .map(r => {
      // leverage per venue for this token (from config.margin.venues)
      const lev = {};
      for (const v of ALL_VENUES) {
        const lf = levFor(v, r.assetKey);
        lev[v] = (lf && lf.lev != null) ? lf.lev : (lf && lf.source === 'unk' ? 'unk' : 'NA');
      }
      return {
        assetKey: r.assetKey,
        leg: r.simName,
        notional: r.notional,
        cde10: r.cdeMargin,
        cde20: r.cdeMarginC,
        cde25: r.notional * m.futuresRate,
        hedge: r.hedge,
        lev,
      };
    });

  const data = {
    cde: { initialMarginRate: m.initialMarginRate, conservativeRate: m.conservativeRate, futuresRate: m.futuresRate, assumed: m.assumed },
    venues: ALL_VENUES,
    majors: ['BTC','ETH','SOL','XRP','nBTC','nETH','nSOL','nXRP'],
    stipend: {
      perp: { alt: { weekday: 3000, weekend: 1500 }, major: { weekday: 0, weekend: 0 } },
      fut:  { alt: { weekday: 2000, weekend: 1000 }, major: { weekday: 0, weekend: 0 } },
    },
    rows,
    viability: VIA,
  };

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>CDE MM Viability</title>
<style>
 body{font:14px/1.4 system-ui,Segoe UI,Arial;margin:0;padding:18px;background:#0f1115;color:#e6e6e6}
 h1{font-size:18px;margin:0 0 6px} .sub{color:#9aa;font-size:12px;margin-bottom:14px}
 .controls{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:14px;background:#171a21;padding:12px;border-radius:8px}
 .ctl{display:flex;flex-direction:column;gap:4px} .ctl label{font-size:11px;color:#9aa;text-transform:uppercase}
 select,input{background:#0f1115;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:6px;padding:6px 8px;font-size:13px}
 table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
 th,td{padding:6px 8px;border-bottom:1px solid #232833;text-align:right}
 th:nth-child(1),td:nth-child(1),th:nth-child(2),td:nth-child(2){text-align:left}
 th{position:sticky;top:0;background:#171a21;color:#cdd;font-size:12px;cursor:pointer;user-select:none}
 tr:hover{background:#1b1f29}
 .tot{background:#171a21;font-weight:600}
 .tot td{border-top:2px solid #2a2f3a}
 .warn{color:#e0a;font-size:11px}
 .via-hi{color:#4caf50;font-weight:600} .via-mid{color:#cddc39} .via-lo{color:#ff9800} .via-vlo{color:#ef5350} .via-na{color:#777}
 .toklist{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto;background:#0f1115;border:1px solid #2a2f3a;border-radius:6px;padding:6px 8px;min-width:150px}
 .tokrow{display:flex;align-items:center;gap:8px;font-size:12px;padding:2px 0;cursor:pointer}
 .tokrow input{accent-color:#4a9;width:14px;height:14px}
 .tokrow.master{border-bottom:1px solid #2a2f3a;margin-bottom:4px;padding-bottom:4px;font-weight:600;color:#cdd}
 #summary{margin-top:14px;background:#171a21;padding:12px;border-radius:8px;font-size:13px;white-space:pre-line}
</style></head>
<body>
<h1>CDE MM Viability Explorer</h1>
<div class="sub">Perp + dated-futures legs, all tokens. CDE margin rates are ASSUMED (Coinbase Derivatives clearing margin not yet confirmed). Hedge = ONE side. Dropdowns recompute instantly. Viability = % of polls where combined bid+ask net &gt; 0 (matches Telegram "✅" green).</div>

<div class="controls">
  <div class="ctl"><label>Strategy</label>
    <select id="strategy">
      <option value="both">Perp + Futures (both)</option>
      <option value="perp">Perp only</option>
      <option value="fut">Futures only</option>
    </select></div>
  <div class="ctl"><label>CDE perp leverage</label>
    <select id="cdeRatePerp">
      <option value="initialMarginRate">Aggressive 10x (10%)</option>
      <option value="conservativeRate">Conservative 5x (20%)</option>
      <option value="lev2">2x (50%)</option>
      <option value="lev3">3x (33%)</option>
    </select></div>
  <div class="ctl"><label>CDE futures leverage</label>
    <select id="cdeRateFut">
      <option value="futuresRate">Futures 4x (25%)</option>
      <option value="lev2">2x (50%)</option>
      <option value="lev3">3x (33%)</option>
    </select></div>
  <div class="ctl"><label>Hedge venue</label>
    <select id="hedgeVenue">
      <option value="cheapest">Cheapest per token</option>
      <option value="hyperliquid">Hyperliquid</option>
      <option value="okx">OKX</option>
      <option value="deribit">Deribit</option>
      <option value="kraken">Kraken</option>
      <option value="coinbase">Coinbase</option>
    </select></div>
  <div class="ctl"><label>Tokens (tick to include)</label>
    <div class="toklist" id="toklist"></div></div>
</div>

<table id="tbl">
  <thead><tr>
    <th data-k="assetKey">Token</th><th data-k="leg">Leg</th><th data-k="notional">Notional</th>
    <th data-k="cde">CDE margin</th><th data-k="hedge">Hedge (1 side)</th>
    <th data-k="lev">Hedge lev</th><th data-k="lev2">Hedge cap @½lev</th>
    <th data-k="swd">Weekday Stipend</th><th data-k="swe">Weekend Stipend</th>
    <th data-k="ror">Rate of Return</th>
    <th data-k="v24">Viability 24h</th><th data-k="v7">Viability 7d</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
  <tfoot><tr class="tot" id="totrow"></tr></tfoot>
</table>
<div id="summary"></div>
<div class="warn">Lighter = n/a (leverage unknown). Deribit perp hedge only exists for BTC/ETH. "Cheapest" picks the lowest-margin venue per token.</div>

<script>
const DATA = ${JSON.stringify(data)};
const VENUE_SHORT = {hyperliquid:'HL',okx:'OKX',deribit:'DER',kraken:'KRK',coinbase:'CB',lighter:'LIT'};
// per-token include state
let included = {};
DATA.rows.forEach(r=>{ included[r.assetKey]=true; });

// build token checkbox list with master toggles: ALL / MAJORS / ALTS + individuals
const toklist = document.getElementById('toklist');
const allToks = [...new Set(DATA.rows.map(r=>r.assetKey))].sort();
const majors = DATA.majors.filter(t=>allToks.includes(t));
const alts = allToks.filter(t=>!majors.includes(t));
function addMaster(label, id, toks){
  const row=document.createElement('label'); row.className='tokrow master';
  row.innerHTML='<input type="checkbox" id="'+id+'" checked> '+label;
  toklist.appendChild(row);
  document.getElementById(id).onchange=function(){
    const v=this.checked;
    toks.forEach(t=>{ included[t]=v; const c=document.querySelector('.tokchk[data-t="'+t+'"]'); if(c) c.checked=v; });
    render();
  };
}
addMaster('Include ALL','masterAll', allToks);
addMaster('Majors only','masterMajors', majors);
addMaster('Alts only','masterAlts', alts);
allToks.forEach(t=>{
  const row=document.createElement('label'); row.className='tokrow';
  row.innerHTML='<input type="checkbox" class="tokchk" data-t="'+t+'" checked> '+t;
  toklist.appendChild(row);
});
document.querySelectorAll('.tokchk').forEach(c=>{ c.onchange=function(){ included[this.dataset.t]=this.checked; render(); }; });

const cdeCol=(row,leg,ratePerp,rateFut)=>{
  const rate = leg==='fut'?rateFut:ratePerp;
  if(rate==='lev2') return row.notional*0.50;   // 2x -> 50% IM
  if(rate==='lev3') return row.notional*0.3333; // 3x -> 33% IM
  return rate==='initialMarginRate'?row.cde10:rate==='conservativeRate'?row.cde20:row.cde25;
};
function hedgeFor(row, venue){
  if(venue==='cheapest'){ let best=Infinity; for(const v of DATA.venues){const x=row.hedge[v]; if(typeof x==='number'&&x<best)best=x;} return best===Infinity?0:best; }
  const x=row.hedge[venue]; return typeof x==='number'?x:0;
}
// resolve the leverage used for a row given the selected hedge venue (cheapest => lowest-lev venue)
function levForRow(row, venue){
  if(venue==='cheapest'){
    let best=null, bestLev=Infinity;
    for(const v of DATA.venues){ const l=row.lev[v]; if(typeof l==='number'&&l<bestLev){bestLev=l;best=v;} }
    return { venue: best, lev: bestLev };
  }
  const l=row.lev[venue];
  return { venue: venue, lev: (typeof l==='number'?l:null) };
}
const usd=n=>'$'+Math.round(n).toLocaleString();
const viaCls=p=> p>=80?'via-hi':p>=50?'via-mid':p>=25?'via-lo':'via-vlo';
const viaCell=p=> (p==null) ? '<span class="via-na">—</span>' : '<span class="'+viaCls(p)+'">'+p.toFixed(1)+'%</span>';
const fmtH=(row,venue)=>{ const x=row.hedge[venue==='cheapest'?'hyperliquid':venue];
  if(x==='unk')return 'n/a'; if(x==='NA')return '—'; return usd(x); };

function render(){
  const strat=document.getElementById('strategy').value || 'both';
  const ratePerp=document.getElementById('cdeRatePerp').value || 'initialMarginRate';
  const rateFut=document.getElementById('cdeRateFut').value || 'futuresRate';
  const hv=document.getElementById('hedgeVenue').value || 'cheapest';
  const legOk = l => strat==='both'||l===strat;
  const rows = DATA.rows.filter(r=>included[r.assetKey]&&legOk(r.leg));
  const tb=document.getElementById('tbody'); tb.innerHTML='';
  let tCde=0,tH=0,tSwd=0,tSwe=0,tRorNum=0,tRorDen=0;
  rows.forEach(r=>{
    const cde=cdeCol(r,r.leg,ratePerp,rateFut)*2;
    const h=hedgeFor(r,hv);
    const lr=levForRow(r,hv);
    const levTxt = (lr.lev!=null) ? (lr.lev+'x @'+VENUE_SHORT[lr.venue]) : 'n/a';
    tCde+=cde; tH+=h;
    const cdeUsd=usd(cde);
    const hedgeCell=(hv==='cheapest')?usd(h):fmtH(r,hv);
    const isAlt = !DATA.majors.includes(r.assetKey);
    const st = DATA.stipend[r.leg][isAlt?'alt':'major'];
    tSwd += st.weekday; tSwe += st.weekend;
    const stipTotal = st.weekday + st.weekend;
    const cap = cde + h;
    const ror = cap > 0 ? (stipTotal / cap) : 0;
    tRorNum += stipTotal; tRorDen += cap;
    const via = (DATA.viability && DATA.viability.via && DATA.viability.via[r.assetKey]) || {};
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+r.assetKey+'</td><td>'+r.leg+'</td><td>'+usd(r.notional)+'</td><td>'+cdeUsd+'</td><td>'+hedgeCell+'</td>'
      +'<td>'+levTxt+'</td><td>'+usd(h*2)+'</td>'
      +'<td>'+usd(st.weekday)+'</td><td>'+usd(st.weekend)+'</td>'
      +'<td>'+(ror*100).toFixed(2)+'%</td>'
      +'<td>'+viaCell(via.v24)+'</td><td>'+viaCell(via.v7)+'</td>';
    tb.appendChild(tr);
  });
  const totRor = tRorDen>0 ? (tRorNum/tRorDen*100).toFixed(2)+'%' : '0.00%';
  document.getElementById('totrow').innerHTML='<td>'+rows.length+' rows</td><td></td><td></td><td>'+usd(tCde)+'</td><td>'+usd(tH)+'</td><td></td><td></td><td>'+usd(tSwd)+'</td><td>'+usd(tSwe)+'</td><td>'+totRor+'</td><td></td><td></td>';
  const rpName=ratePerp==='initialMarginRate'?'10x (10%)':'5x (20%)';
  const rfName='4x (25%, futures)';
  const hvName=hv==='cheapest'?'cheapest per token':VENUE_SHORT[hv];
  const sumLines = [
    'SUMMARY',
    'Strategy: '+strat+'   CDE perp: '+rpName+'   CDE futures: '+rfName+'   Hedge: '+hvName,
    'Post bid+offer on CDE (both sides): '+usd(tCde),
    'Hedge one side: '+usd(tH),
    'TOTAL CAPITAL REQUIRED: '+usd(tCde+tH)
  ];
  if (DATA.viability && DATA.viability.empty) {
    sumLines.push('');
    sumLines.push('Viability 24h/7d: NO LOG DATA YET — run the CDE MM SIM monitor to accrue stats.');
  } else if (DATA.viability && DATA.viability.generatedAt) {
    sumLines.push('Viability generated: ' + DATA.viability.generatedAt);
  }
  document.getElementById('summary').textContent = sumLines.join(String.fromCharCode(10));
}
['strategy','cdeRatePerp','cdeRateFut','hedgeVenue'].forEach(id=>document.getElementById(id).onchange=render);
render();
</script>
</body></html>`;

  const out = path.join(__dirname, 'capital_explorer.html');
  fs.writeFileSync(out, html);
  console.log('[gen] wrote ' + out + '  (' + rows.length + ' rows, ' + data.rows.length + ' token-legs)');
})();
