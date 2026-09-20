// alerts/mm_sim_alert.js

function fmtBps(n) { return (n==null||isNaN(n))?'N/A':`${n>=0?'+':''}${n.toFixed(1)}`; }
function fmtUsd(n) { return (n==null||isNaN(n))?'N/A':`${n>=0?'+':'-'}$${Math.abs(n).toFixed(0)}`; }
function icon(p)   { return p?'✅':'❌'; }

// Scenarios A-E apply to BTC/ETH/SOL/HYPE/XRP
// Scenarios F-G apply to LTC/LINK/BCH (and are also shown for all assets as reference)
const SCENARIOS_MAIN = [
  { key:'A', desc:'±4b  $75k  5bp maker',  appliesTo: null },  // null = all assets
  { key:'B', desc:'±8b  $75k  5bp maker',  appliesTo: null },
  { key:'C', desc:'±4b  $37.5k 5bp maker', appliesTo: null },
  { key:'D', desc:'±4b  $75k  0bp maker',  appliesTo: null },
  { key:'E', desc:'±8b  $75k  0bp maker',  appliesTo: null },
];

const SCENARIOS_FG = [
  { key:'F', desc:'±10b $10k  5bp maker',  appliesTo: ['LTC','LINK','BCH'] },
  { key:'G', desc:'±10b $10k  0bp maker',  appliesTo: ['LTC','LINK','BCH'] },
];

function combNet(sim, key) {
  const s = sim[`scenario${key}`];
  if (!s) return null;
  return {
    bps: s.bidFill.netBps + s.askFill.netBps,
    usd: s.bidFill.netUsd + s.askFill.netUsd,
    partial: !s.bidFill.hlFullyFilled || !s.askFill.hlFullyFilled,
  };
}

function formatCell(net) {
  if (!net) return '—';
  const p = net.usd >= 0;
  const warn = net.partial ? '⚠' : '';
  return `${fmtBps(net.bps)}b(${fmtUsd(net.usd)})${icon(p)}${warn}`;
}

/**
 * Consolidated table — one section per scenario group, one row per asset.
 */
function buildConsolidatedMMMessage(assetResults) {
  // Separate assets into main group and FG group
  const fgAssets   = ['LTC','LINK','BCH','SUI','DOT','DOGE','SHIB'];
  const mainAssets = assetResults.filter(r => !fgAssets.includes(r.assetKey));
  const fgResults  = assetResults.filter(r => fgAssets.includes(r.assetKey));

  // Count profitable combos for header icon
  let profitCount = 0;
  for (const {assetKey, sim} of assetResults) {
    if (!sim) continue;
    const scenarios = fgAssets.includes(assetKey)
      ? SCENARIOS_FG
      : [...SCENARIOS_MAIN, ...SCENARIOS_FG];
    for (const {key} of scenarios) {
      const n = combNet(sim, key);
      if (n && n.usd > 0) profitCount++;
    }
  }
  const hi = profitCount >= 4 ? '🎯' : profitCount >= 1 ? '⚡' : '📊';

  const lines = [
    `${hi} <b>MM SIM — COMBINED NET (bid + ask per fill)</b>`,
    `<i>net = half-spread earned − HL hedge cost − fees</i>`,
    ``,
  ];

  // ── SECTION 1: Main assets (A-E) ──────────────────────────────
  if (mainAssets.length > 0) {
    const midLine = mainAssets.filter(r=>r.sim)
      .map(r => {
        const prec = r.sim.kalshiMid > 100 ? 0 : r.sim.kalshiMid > 1 ? 4 : 6;
        return `${r.assetKey} $${r.sim.kalshiMid.toFixed(prec)}`;
      }).join('  ');
    lines.push(`<b>── BTC / ETH / SOL / HYPE / XRP ──</b>`);
    lines.push(`Kalshi mids: ${midLine}`, ``);

    for (const { key, desc } of SCENARIOS_MAIN) {
      lines.push(`<b>[${key}] ${desc}</b>`);
      for (const { assetKey, sim } of mainAssets) {
        if (!sim) { lines.push(`  ${assetKey}: no data`); continue; }
        const n = combNet(sim, key);
        lines.push(`  ${assetKey.padEnd(4)}: ${formatCell(n)}`);
      }
      lines.push('');
    }
  }

  // ── SECTION 2: LTC / LINK / BCH (F and G only) ───────────────
  if (fgResults.length > 0) {
    const midLine2 = fgResults.filter(r=>r.sim)
      .map(r => {
        const prec = r.sim.kalshiMid > 100 ? 0 : r.sim.kalshiMid > 1 ? 4 : 6;
        return `${r.assetKey} $${r.sim.kalshiMid.toFixed(prec)}`;
      }).join('  ');
    lines.push(`<b>── LTC / LINK / BCH / SUI / DOT / DOGE / SHIB ──</b>`);
    lines.push(`Kalshi mids: ${midLine2}`, ``);

    for (const { key, desc } of SCENARIOS_FG) {
      lines.push(`<b>[${key}] ${desc}</b>`);
      for (const { assetKey, sim } of fgResults) {
        if (!sim) { lines.push(`  ${assetKey}: no data`); continue; }
        const n = combNet(sim, key);
        lines.push(`  ${assetKey.padEnd(4)}: ${formatCell(n)}`);
      }
      lines.push('');
    }
  }

  lines.push(`🕐 ${new Date().toUTCString()}`);
  return lines.join('\n');
}

/**
 * Single-asset message for individual alerts.
 */
function buildMMSimMessage(sim, assetKey) {
  const fgAssets = ['LTC','LINK','BCH','SUI','DOT','DOGE','SHIB'];
  const isFG = fgAssets.includes(assetKey);
  const scenarios = isFG ? SCENARIOS_FG : [...SCENARIOS_MAIN, ...SCENARIOS_FG];
  const prec = sim.kalshiMid > 100 ? 0 : sim.kalshiMid > 1 ? 4 : 6;

  const lines = [`📊 <b>MM SIM [${assetKey}]</b>  mid $${sim.kalshiMid.toFixed(prec)}`, ``];
  for (const {key, desc} of scenarios) {
    const n = combNet(sim, key);
    if (!n) continue;
    lines.push(`[${key}] ${desc}: ${formatCell(n)}`);
  }
  lines.push(`\n🕐 ${new Date().toUTCString()}`);
  return lines.join('\n');
}

function consoleOneLiner(sim, assetKey) {
  const fgAssets = ['LTC','LINK','BCH','SUI','DOT','DOGE','SHIB'];
  const isFG = fgAssets.includes(assetKey);
  const keys = isFG ? ['F','G'] : ['A','B','C','D','E','F','G'];
  const lines = ['  MM sim:'];
  for (const key of keys) {
    const n = combNet(sim, key);
    if (!n) continue;
    lines.push(`    [${key}] ${fmtBps(n.bps)}b(${fmtUsd(n.usd)})${icon(n.usd>=0)}${n.partial?'⚠':''}`);
  }
  return lines.join('\n');
}

module.exports = { buildMMSimMessage, buildConsolidatedMMMessage, consoleOneLiner };
