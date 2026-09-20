// monitor_cde_dated_mm.js
//
// CDE DATED FUTURES MM VS PERP HEDGE — screener + Telegram publisher.
//
// For each token with a perp + 2 dated expirations (front + back month),
// this checks: if we post 10bps bid/ask ($5k notional) on the dated future
// and hedge each fill at the perp midpoint, is the hedge profitable after
// fees ($0.07/contract = $0.02 clearing + $0.05 exchange)?
//
// CDE has NO public order book (best_bid/ask are empty strings on the REST
// API — only authenticated FIX has the book), so this uses the keyless
// synthetic-quote model: assume full fill at midpoint, with the $0.02+$0.05
// flat fee per contract. This is the only viable model for a public-data
// screener (matches the existing monitor_cde.js / monitor_cde_basis.js pattern).
//
// Env / CLI:
//   CDE_DATED_MM_PORT     (default 8080)  Dashboard port (HTML table viewer)
//   CDE_DATED_MM_POLL_MS  (default 60000) Poll interval
//   CDE_DATED_MM_ONCE=1   Run once, print summary, exit
//   CDE_DATED_MM_DRYRUN=1 Print Telegram message to console, do NOT send
//   CDE_DATED_MM_WIDTH_BPS   (default 10)   Total bid/ask spread
//   CDE_DATED_MM_NOTIONAL    (default 5000) USD per side
//   CDE_DATED_MM_FEE         (default 0.07) $/contract ($0.02+$0.05)
//   CDE_DATED_MM_BOT_TOKEN   (or TELEGRAM_BOT_TOKEN)
//   CDE_DATED_MM_CHAT_ID     (or TELEGRAM_CHAT_ID_KALSHI)
//   CDE_DATED_MM_HEARTBEAT_MS (default 3600000 = 1h) Periodic summary interval
//
// Run:  node monitor_cde_dated_mm.js                 # live: dashboard + poll
//       node monitor_cde_dated_mm.js --once          # one poll, exit
//       node monitor_cde_dated_mm.js --dryrun --once  # console only

const http = require('http');
const fs = require('fs');
const path = require('path');

// ── .env loader (cwd-independent, like monitor_cde_basis.js) ──────────
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
})();

const { parseProducts, simulateAllTokens, DEFAULT_PARAMS, DAY_MS, SECS_PER_YEAR } = require('./analysis/cde_dated_mm');

const BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const FUT_URL = `${BASE}?product_type=FUTURE`;
const FETCH_TIMEOUT_MS = 15_000;

// ── Config ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.CDE_DATED_MM_PORT || '') || 8080;
const POLL_MS = parseInt(process.env.CDE_DATED_MM_POLL_MS || '') || 60_000;
const ONCE = hasFlag('--once') || !!process.env.CDE_DATED_MM_ONCE;
const DRYRUN = hasFlag('--dryrun') || !!process.env.CDE_DATED_MM_DRYRUN;
const HEARTBEAT_MS = parseInt(process.env.CDE_DATED_MM_HEARTBEAT_MS || '') || 60 * 60_000;

const params = {
  widthBps:      parseFloat(process.env.CDE_DATED_MM_WIDTH_BPS || DEFAULT_PARAMS.widthBps),
  notionalUsd:   parseFloat(process.env.CDE_DATED_MM_NOTIONAL    || DEFAULT_PARAMS.notionalUsd),
  feePerContract: parseFloat(process.env.CDE_DATED_MM_FEE         || DEFAULT_PARAMS.feePerContract),
};

// Telegram — dedicated env vars (avoid cross-contamination with other monitors)
const BOT_TOKEN = process.env.CDE_DATED_MM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.CDE_DATED_MM_CHAT_ID   || process.env.TELEGRAM_CHAT_ID_KALSHI || '';

function hasFlag(f) { return process.argv.includes(f); }

let lastHeartbeat = 0;

// ── Data fetch ────────────────────────────────────────────────────────
async function fetchCDE() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(FUT_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.products || [];
  } finally { clearTimeout(t); }
}

// ── Telegram ──────────────────────────────────────────────────────────
let tgWarned = false;
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    if (!tgWarned) {
      console.warn('[cde-dated-mm] CDE_DATED_MM_BOT_TOKEN / CDE_DATED_MM_CHAT_ID not set — console-only.');
      tgWarned = true;
    }
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[cde-dated-mm] Telegram error: ${res.status} ${body}`);
    }
  } catch (e) {
    console.warn('[cde-dated-mm] Telegram send failed:', e.message);
  }
}

// ── Telegram message builder ──────────────────────────────────────────
function fmt(n, d=2) { return n == null || isNaN(n) ? 'N/A' : n.toFixed(d); }
function fmtBps(n) { return n == null || isNaN(n) ? 'N/A' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}b`; }
function fmtUsd(n) {
  if (n == null || isNaN(n)) return 'N/A';
  const s = n >= 0 ? '+' : '-';
  const a = Math.abs(n);
  if (a >= 1e6) return `${s}$${(a/1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a/1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(2)}`;
}

function buildTelegramMessage(results, p) {
  if (!results || results.length === 0) return `📊 <b>CDE Dated Futures MM — no data</b>\n\nNo tokens found with perp + 2 dated expirations.`;

  const profitable = results.filter(r => r.front.profitable || r.back.profitable);
  const nProf = profitable.length;
  const nTotal = results.length;

  const lines = [];
  lines.push(`🎯 <b>CDE DATED FUTURES MM — ${nProf}/${nTotal} profitable</b>`);
  lines.push(`<i>width=${p.widthBps}bps | notional=$${(p.notionalUsd/1000).toFixed(1)}k/side | fee=$${p.feePerContract.toFixed(2)}/ctr | keyless perp hedge (no public CDE book)</i>`);
  lines.push(``);

  // Top 12 by front-month net edge
  const top = results.slice(0, 12);
  lines.push(`<pre>Token   Front   Back   | FrontCarry  BackCarry  | Fees  nCtr F/B`);
  lines.push(`┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`);
  for (const r of top) {
    const fNet = r.front.netPerFill;
    const bNet = r.back.netPerFill;
    const fCarry = r.front.carry.divergence != null ? `${r.front.carry.divergence.toFixed(0)}%` : '—';
    const bCarry = r.back.carry.divergence  != null ? `${r.back.carry.divergence.toFixed(0)}%`  : '—';
    const fMark  = r.front.profitable ? '✅' : '❌';
    const bMark  = r.back.profitable  ? '✅' : '❌';
    lines.push(
      `${r.root.padEnd(7)} ` +
      `${fNet.toFixed(2).padStart(6)} ${fMark} ` +
      `${bNet.toFixed(2).padStart(6)} ${bMark} ` +
      `| ${fCarry.padStart(11)} ${bCarry.padStart(11)} ` +
      `| ${fmtUsd(r.front.feesPerFill).padStart(6)} ` +
      `${r.front.contracts}/${r.back.contracts}`
    );
  }
  lines.push(`</pre>`);

  // Not profitable list (compact)
  const notProf = results.filter(r => !r.front.profitable && !r.back.profitable);
  if (notProf.length) {
    lines.push(``);
    lines.push(`📉 <b>Not profitable (${notProf.length}):</b> ${notProf.map(r => `${r.root} (front ${fmtUsd(r.front.netPerFill)}, back ${fmtUsd(r.back.netPerFill)})`).join(' | ')}`);
  }

  lines.push(``);
  lines.push(`🕐 ${new Date().toUTCString()}`);
  return lines.join('\n');
}

// ── HTML screener (self-contained, no CDN) ────────────────────────────
const SHARED_CSS = `
  body{background:#0b0e11;color:#c9d1d9;font:13px/1.4 -apple-system,Segoe UI,Roboto,monospace;margin:0;padding:12px}
  h1{font-size:15px;margin:0 0 4px} h2{font-size:13px;margin:0 0 6px;color:#e5e7eb}
  table{border-collapse:collapse;width:100%;margin-bottom:16px}
  th,td{border:1px solid #1f2937;padding:4px 7px;text-align:right;white-space:nowrap;font-size:12px}
  th{background:#111827;color:#9ca3af;font-weight:600;cursor:pointer}
  th:hover{background:#1d2739}
  td.root{text-align:left;font-weight:600}
  td.root a{color:#60a5fa;text-decoration:none}
  .pos{color:#34d399} .neg{color:#f87171}
  .ok{color:#34d399} .bad{color:#f87171}
  .meta{color:#6b7280;font-size:11px;margin-bottom:10px}
  .sortnav{font-size:11px;margin-bottom:10px}
  tr:nth-child(even){background:#0f141a}
  .fl{font-size:9px;color:#f59e0b;padding:1px 4px;border-radius:3px}
`;

function buildHTML(results, p) {
  const sortOptions = [
    ['net', 'Combined Edge ($)'],
    ['front', 'Front Net ($)'],
    ['back', 'Back Net ($)'],
    ['carry', 'Front Carry APY'],
    ['div', 'Front Divergence'],
  ];
  let sortMode = 'net';

  const rows = results.map(r => ({
    root: r.root,
    fNet: r.front.netPerFill,
    bNet: r.back.netPerFill,
    combined: r.front.netPerFill + r.back.netPerFill,
    fCarry: r.front.carry.divergence ?? null,
    bCarry: r.back.carry.divergence  ?? null,
    fBasis: r.front.carry.basisAPY ?? null,
    fFund: r.front.carry.fundAPY   ?? null,
    fNetEdge: r.front.netPerFill,
    bNetEdge: r.back.netPerFill,
    fContracts: r.front.contracts,
    bContracts: r.back.contracts,
    fFees: r.front.feesPerFill,
    bFees: r.back.feesPerFill,
    fProf: r.front.profitable,
    bProf: r.back.profitable,
    fMid: r.front.mid,
    bMid: r.back.mid,
    pMid: r.perp.mid,
    pFundAPY: r.perp.fundAPY,
    fExpiry: r.front.expiry,
    bExpiry: r.back.expiry,
    fTmsD: r.front.Tms / DAY_MS,
    bTmsD: r.back.Tms / DAY_MS,
    fVol24: r.front.vol24,
    pVol24: r.perp.vol24,
  }));

  function rowHTML(r) {
    const fProf = r.fProf ? '<span class="ok">✅</span>' : '<span class="bad">❌</span>';
    const bProf = r.bProf ? '<span class="ok">✅</span>' : '<span class="bad">❌</span>';
    return `<tr>
      <td class="root">${r.root}</td>
      <td>${r.fMid != null ? r.fMid.toFixed(r.fMid > 100 ? 0 : r.fMid > 1 ? 2 : 6) : '—'}</td>
      <td>${r.bMid != null ? r.bMid.toFixed(r.bMid > 100 ? 0 : r.bMid > 1 ? 2 : 6) : '—'}</td>
      <td>${r.pMid != null ? r.pMid.toFixed(r.pMid > 100 ? 0 : r.pMid > 1 ? 2 : 6) : '—'}</td>
      <td class="${r.fNet >= 0 ? 'pos' : 'neg'}">${r.fNet.toFixed(2)}</td>
      <td class="${r.bNet >= 0 ? 'pos' : 'neg'}">${r.bNet.toFixed(2)}</td>
      <td class="${r.combined >= 0 ? 'pos' : 'neg'}">${r.combined.toFixed(2)}</td>
      <td>${fProf}${bProf}</td>
      <td>${r.fContracts}</td>
      <td>${r.bContracts}</td>
      <td class="${r.fFees < r.fNet ? 'pos' : 'neg'}">${r.fFees.toFixed(2)}</td>
      <td class="${r.bFees < r.bNet ? 'pos' : 'neg'}">${r.bFees.toFixed(2)}</td>
      <td>${r.fCarry != null ? (r.fCarry >= 0 ? '+' : '') + r.fCarry.toFixed(1) + '%' : '—'}</td>
      <td>${r.bCarry != null ? (r.bCarry >= 0 ? '+' : '') + r.bCarry.toFixed(1) + '%' : '—'}</td>
      <td>${r.fFund != null ? (r.fFund >= 0 ? '+' : '') + r.fFund.toFixed(1) + '%' : '—'}</td>
      <td><span class="fl">${r.fExpiry ? r.fExpiry.slice(0,10) : '—'}</span></td>
      <td><span class="fl">${r.bExpiry ? r.bExpiry.slice(0,10) : '—'}</span></td>
      <td>${r.fVol24 != null ? '$' + (r.fVol24 >= 1e6 ? (r.fVol24/1e6).toFixed(1)+'M' : r.fVol24.toFixed(0)) : '—'}</td>
    </tr>`;
  }

  function sortRows(mode) {
    const keyMap = { net: 'combined', front: 'fNet', back: 'bNet', carry: 'fCarry', div: 'fCarry' };
    const key = keyMap[mode] || 'combined';
    return [...rows].sort((a, b) => {
      const av = a[key] ?? -1e9;
      const bv = b[key] ?? -1e9;
      return bv - av;
    });
  }

  const sorted = sortRows(sortMode);
  let tableRows = sorted.map(rowHTML).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>CDE Dated Futures MM — Screener</title>
<style>${SHARED_CSS}
  th{cursor:pointer} th.sortable:hover{opacity:0.7}
  .sortnav{font-size:11px;color:#9ca3af;margin-bottom:10px}
  .sortnav a{color:#9ca3af;text-decoration:none;margin:0 4px;padding:2px 6px;border-radius:3px}
  .sortnav a.active{color:#0b0e11;background:#60a5fa;font-weight:600}
</style>
<script>
  const ALL_ROWS = ${JSON.stringify(sorted)};
  function render(mode) {
    const keyMap = {net:'combined',front:'fNet',back:'bNet',carry:'fCarry',div:'fCarry'};
    const key = keyMap[mode] || 'combined';
    const rows = [...ALL_ROWS].sort((a,b)=> (b[key] ?? -1e9) - (a[key] ?? -1e9));
    const tb = document.getElementById('tbody');
    tb.innerHTML = rows.map(r => {
      const fProf = r.fProf ? '✅' : '❌';
      const bProf = r.bProf ? '✅' : '❌';
      return '<tr>'
        + '<td class="root">' + r.root + '</td>'
        + '<td>' + (r.fMid != null ? r.fMid.toFixed(r.fMid>100?0:r.fMid>1?2:6) : '—') + '</td>'
        + '<td>' + (r.bMid != null ? r.bMid.toFixed(r.bMid>100?0:r.bMid>1?2:6) : '—') + '</td>'
        + '<td>' + (r.pMid != null ? r.pMid.toFixed(r.pMid>100?0:r.pMid>1?2:6) : '—') + '</td>'
        + '<td class="' + (r.fNet >= 0 ? 'pos' : 'neg') + '">' + r.fNet.toFixed(2) + '</td>'
        + '<td class="' + (r.bNet >= 0 ? 'pos' : 'neg') + '">' + r.bNet.toFixed(2) + '</td>'
        + '<td class="' + (r.combined >= 0 ? 'pos' : 'neg') + '">' + r.combined.toFixed(2) + '</td>'
        + '<td>' + fProf + bProf + '</td>'
        + '<td>' + r.fContracts + '</td>'
        + '<td>' + r.bContracts + '</td>'
        + '<td class="' + (r.fFees < r.fNet ? 'pos' : 'neg') + '">' + r.fFees.toFixed(2) + '</td>'
        + '<td class="' + (r.bFees < r.bNet ? 'pos' : 'neg') + '">' + r.bFees.toFixed(2) + '</td>'
        + '<td>' + (r.fCarry != null ? (r.fCarry >= 0 ? '+' : '') + r.fCarry.toFixed(1) + '%' : '—') + '</td>'
        + '<td>' + (r.bCarry != null ? (r.bCarry >= 0 ? '+' : '') + r.bCarry.toFixed(1) + '%' : '—') + '</td>'
        + '<td>' + (r.fFund != null ? (r.fFund >= 0 ? '+' : '') + r.fFund.toFixed(1) + '%' : '—') + '</td>'
        + '<td><span class="fl">' + (r.fExpiry ? r.fExpiry.slice(0,10) : '—') + '</span></td>'
        + '<td><span class="fl">' + (r.bExpiry ? r.bExpiry.slice(0,10) : '—') + '</span></td>'
        + '<td>' + (r.fVol24 != null ? '$' + (r.fVol24 >= 1e6 ? (r.fVol24/1e6).toFixed(1)+'M' : r.fVol24.toFixed(0)) : '—') + '</td>'
        + '</tr>';
    }).join('');
  }
  document.getElementById('frontNet').onclick = () => {render('front');};
  document.getElementById('backNet').onclick = () => {render('back');};
  document.getElementById('combined').onclick = () => {render('net');};
  document.getElementById('carry').onclick = () => {render('carry');};
  render('net');
</script>
</head><body>
<h1>CDE Dated Futures MM — Perp Hedge Screener</h1>
<div class="meta">width=${p.widthBps}bps | notional=$${(p.notionalUsd/1000).toFixed(1)}k/side | fee=$${p.feePerContract.toFixed(2)}/ctr ($0.02+$0.05) | keyless perp hedge (no public CDE book) · generated ${new Date().toISOString()}</div>
<div class="sortnav">
  Sort: <span class="active" id="combined">Combined Edge</span> |
  <a id="frontNet">Front Net</a> | <a id="backNet">Back Net</a> |
  <a id="carry">Front Carry</a>
</div>
<table>
<thead><tr>
  <th>Token</th><th>Front mid</th><th>Back mid</th><th>Perp mid</th>
  <th>Front net</th><th>Back net</th><th>Combined</th><th>Profitable</th>
  <th>nCtr F/B</th>
  <th>Fee F/B</th>
  <th>Carry F/B</th>
  <th>Fund APY</th>
  <th>Front expiry</th><th>Back expiry</th><th>Vol24</th>
</tr></thead>
<tbody id="tbody">${tableRows}</tbody>
</table>
</body></html>`;
}

// ── Main poll ─────────────────────────────────────────────────────────
let latest = null;

async function runCheck() {
  const t0 = Date.now();
  try {
    const products = await fetchCDE();
    const byRoot = parseProducts(products);
    const results = simulateAllTokens(byRoot, params);
    latest = results;

    const msg = buildTelegramMessage(results, params);

    if (DRYRUN) {
      console.log(msg);
      // Also write HTML for inspection
      const html = buildHTML(results, params);
      fs.writeFileSync(path.join(__dirname, 'cde_dated_mm_screen.html'), html);
      console.log(`\n[DRYRUN] HTML written to cde_dated_mm_screen.html (${results.length} tokens, ${results.filter(r=>r.front.profitable||r.back.profitable).length} profitable)`);
    } else {
      // Periodic summary heartbeat (even if no profitable tokens)
      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_MS) {
        await sendTelegram(msg);
        lastHeartbeat = now;
        console.log(`[telegram] summary sent (${new Date().toISOString()})`);
      }
      // Always write HTML
      const html = buildHTML(results, params);
      fs.writeFileSync(path.join(__dirname, 'cde_dated_mm_screen.html'), html);
    }

    console.log(`[done] ${Date.now() - t0}ms | ${results.length} tokens | ${results.filter(r => r.front.profitable || r.back.profitable).length} profitable`);
  } catch (e) {
    console.error(`[cde-dated-mm] poll failed: ${e.message}`);
    if (DRYRUN) process.exit?.(1);
  }
}

// ── HTTP server (optional HTML viewer) ────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') { res.end('ok'); return; }
  if (url.pathname === '/api/snapshot') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(latest || { error: 'no data yet' }));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/screen') {
    if (!latest) { res.end('<p>loading…</p>'); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(buildHTML(latest, params));
    return;
  }
  res.statusCode = 404; res.end('not found');
});

// ── Startup ───────────────────────────────────────────────────────────
async function start() {
  console.log(`[cde-dated-mm] width=${params.widthBps}bps notional=$${params.notionalUsd} fee=$${params.feePerContract}/ctr`);
  console.log(`[cde-dated-mm] poll=${(POLL_MS/1000).toFixed(0)}s once=${ONCE} dryrun=${DRYRUN}`);
  console.log(`[cde-dated-mm] telegram=${BOT_TOKEN && CHAT_ID ? 'configured' : 'NOT CONFIGURED (console-only)'}`);
  await runCheck();
  if (ONCE) { process.exit(0); }
  server.listen(PORT, '127.0.0.1', () => console.log(`[cde-dated-mm] dashboard http://localhost:${PORT}`));
  setInterval(() => runCheck().catch(e => console.error('poll error:', e.message)), POLL_MS);
}

if (require.main === module) start();
module.exports = { runCheck, parseProducts, simulateAllTokens, buildTelegramMessage, buildHTML };
