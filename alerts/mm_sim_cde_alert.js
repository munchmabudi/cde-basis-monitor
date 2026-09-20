// alerts/mm_sim_cde_alert.js — builds the "CDE MM SIM" consolidated message(s).
// Mirrors alerts/mm_sim_alert.js but reads the CDE sim result (multi-venue hedge)
// and labels everything CDE. Now emits TWO messages: one for Major-class tokens,
// one for Alt-class tokens (the user wants the Alts in particular). The CDE
// flat maker fee ($/contract) is shown on the scenario line, and the CDE
// contract count + notional are reported.

const config = require('../config');

function fmtBps(n) { return (n == null || isNaN(n)) ? 'N/A' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}`; }
function fmtUsd(n) { return (n == null || isNaN(n)) ? 'N/A' : `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(0)}`; }
function icon(p)   { return p ? '✅' : '❌'; }

// Scenarios: a single scenario at the fixed native width W with the CDE flat
// maker fee ($/contract). One scenario only. (Width is fixed, never widened.)
const SCENARIOS = [
  { key: 'A', feeUsd: config.cde.feePerContractUsd, widthMul: 1, feeLabel: 'fee' },
];

function combNet(sim, key) {
  const s = sim[`scenario${key}`];
  if (!s) return null;
  if (s.noHedge || !s.bidFill || !s.askFill) return { bps: NaN, usd: NaN, partial: true, hedgeVenue: 'none', noHedge: true };
  const hv = s.bidFill.venue === s.askFill.venue
    ? s.bidFill.venue
    : `${s.bidFill.venue}/${s.askFill.venue}`;
  return {
    bps: s.bidFill.netBps + s.askFill.netBps,
    usd: s.bidFill.netUsd + s.askFill.netUsd,
    partial: !s.bidFill.fullyFilled || !s.askFill.fullyFilled,
    hedgeVenue: hv,
  };
}

function formatCell(net, scenario) {
  if (!net) return '—';
  if (scenario && scenario.noHedge) return '⛔ no hedge';
  const p = net.usd >= 0;
  const warn = net.partial ? '⚠' : '';
  return `${fmtBps(net.bps)}b(${fmtUsd(net.usd)})${icon(p)}${warn} ${net.hedgeVenue}`;
}

// Count "we could profitably make markets in N tokens" = assets where BOTH the
// fee and 0-fee scenarios at the fixed width W are profitable.
function profitableTokenCount(assetResults) {
  let n = 0;
  for (const { sim } of assetResults) {
    if (!sim) continue;
    const net = combNet(sim, 'A');
    if (net && net.usd > 0) n++;
  }
  return n;
}

function buildOneMessage(assetResults, classLabel, header) {
  const results = assetResults.filter(r => r.sim && r.cdeCfg && r.cdeCfg.class === classLabel);
  if (results.length === 0) return null;
  const title = header || `CDE MM SIM [${classLabel.toUpperCase()}]`;

  // Count "no hedge available" and "profitably MM-able".
  let noHedgeCount = 0, profitCount = 0;
  for (const { sim } of results) {
    const anyNoHedge = sim.scenarioA && sim.scenarioA.noHedge;
    if (anyNoHedge) { noHedgeCount++; continue; }
    const net = combNet(sim, 'A');
    if (net && net.usd > 0) profitCount++;
  }
  const hi = profitCount >= 4 ? '🎯' : profitCount >= 1 ? '⚡' : '📊';

  const refVenue = results[0].sim.refVenue;
  const feeLabelShort = `$${config.cde.feePerContractUsd.toFixed(2)}/ctr`;

  const lines = [
    `${hi} <b>${title} — COMBINED NET (bid+ask per fill)</b>`,
    `<i>net = half-spread earned − best hedge cost − CDE maker fee · anchor: ${refVenue} mid · hedge: perps · each token's TOTAL bid/ask width (bps) is shown inline; half posted each side = W/2</i>`,
    `<i>CDE maker fee: ${feeLabelShort} flat per contract. ⚠ = size/mult uncertain · ⚠partial = hedge not fully filled.</i>`,
    ``,
  ];

  const midLine = results.map(r => {
    const prec = r.sim.refMid > 100 ? 0 : r.sim.refMid > 1 ? 4 : 6;
    const ctr  = ` (${r.sim.cdeFullContracts} ctr @ $${Math.round(r.sim.notional)})`;
    const unc  = r.cdeCfg.multiplierUncertain ? '⚠' : '';
    return `${r.assetKey}${unc} $${r.sim.refMid.toFixed(prec)}${ctr}`;
  }).join('  ');
  lines.push(`<b>── ${classLabel} tokens (${results.length}) ──</b>`);
  lines.push(`Ref mids: ${midLine}`, ``);

  for (const { key, feeUsd, feeLabel } of SCENARIOS) {
    const feeTxt = feeLabel === 'fee' ? `${feeLabelShort}` : '$0';
    lines.push(`<b>[${key}] ${feeTxt}</b>`);
    for (const { assetKey, sim, cdeCfg } of results) {
      const n = combNet(sim, key);
      const unc = cdeCfg.multiplierUncertain ? '⚠' : '';
      lines.push(`  ${assetKey.padEnd(5)}${unc} (${cdeCfg.widthBps}b): ${formatCell(n, sim[`scenario${key}`])}`);
    }
    lines.push('');
  }

  lines.push(`📈 Profitably MM-able (both A & D): ${profitCount}/${results.length}` +
              (noHedgeCount ? `  ·  ⛔ no hedge venue: ${noHedgeCount}` : ''));
  lines.push(`🕐 ${new Date().toUTCString()}`);
  return lines.join('\n');
}

function buildCDEConsolidatedMessage(assetResults) {
  const major = buildOneMessage(assetResults, 'Major');
  const alt   = buildOneMessage(assetResults, 'Alt');
  return [major, alt].filter(Boolean).join('\n\n────────────\n\n');
}

function consoleOneLinerCDE(sim, assetKey) {
  const lines = ['  CDE MM sim:'];
  for (const { key, feeLabel } of SCENARIOS) {
    const n = combNet(sim, key);
    if (!n) continue;
    lines.push(`    [${key}] ${fmtBps(n.bps)}b(${fmtUsd(n.usd)})${icon(n.usd >= 0)}${n.partial ? '⚠' : ''} ${n.hedgeVenue} ${feeLabel}`);
  }
  return lines.join('\n');
}

module.exports = { buildCDEConsolidatedMessage, buildOneMessage, consoleOneLinerCDE };
