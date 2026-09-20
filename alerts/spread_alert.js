// alerts/spread_alert.js
// Formats Telegram messages for the MM thesis monitoring.
// Two message types:
//   1. MM opportunity alert — when net edge per fill turns positive
//   2. Spread report — periodic summary of spread history + MM thesis metrics

function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return 'N/A';
  return n.toFixed(d);
}
function fmtBps(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${n >= 0 ? '+' : ''}${fmt(n, 1)}bps`;
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${n >= 0 ? '+' : ''}${fmt(n, 3)}%`;
}
function fmtUsd(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

/**
 * Alert fired when the MM thesis turns net-positive.
 * i.e. Kalshi spread is wide enough that quoting it + hedging on HL
 * generates positive expected value per fill.
 */
function buildMMAlert(mm, kalshiStats, hlStats) {
  const lines = [
    `🎯 <b>MM OPPORTUNITY — KALSHI/HL</b>`,
    ``,
    `<b>── SPREAD COMPARISON ──</b>`,
    `Kalshi:       ${fmtBps(mm.kalshiSpreadBps)} wide  (½ = ${fmtBps(mm.kalshiHalfSpreadBps)} earn per fill)`,
    `Hyperliquid:  ${fmtBps(mm.hlSpreadBps)} wide  (½ = ${fmtBps(mm.hlHalfSpreadBps)} slippage to hedge)`,
    `Spread ratio: ${fmt(mm.spreadRatio, 1)}x  (Kalshi vs HL)`,
    ``,
    `<b>── P&L PER KALSHI FILL (${mm.assumedHoldingHours}h hold) ──</b>`,
    `Earn Kalshi half-spread:  ${fmtBps(mm.kalshiEarnBps)}`,
    `Pay HL taker fee:         ${fmtBps(-mm.hlTakerFeeBps)}`,
    `Pay HL spread slippage:   ${fmtBps(-mm.hlSlippageBps)}`,
    `Pay Kalshi maker fee:     ${fmtBps(-mm.kalshiMakerFeeBps)}`,
    `Funding carry (net):      ${fmtBps(mm.fundingCarryBps)}`,
    `  HL funding:    ${fmtPct(mm.hlAnnualFundingPct)}/yr`,
    `  Kalshi funding:${fmtPct(mm.kalshiAnnualFundingPct)}/yr`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `<b>Net per fill: ${fmtBps(mm.netEdgePerFillBps)} → ${fmtUsd(mm.netEdgePerFillUsd)} on $${(25000).toLocaleString()}</b>`,
    `Break-even Kalshi spread: ${fmtBps(mm.breakEvenKalshiSpreadBps)}`,
    ``,
    kalshiStats ? `Kalshi spread 1h avg: ${fmtBps(kalshiStats.avg)}  min: ${fmtBps(kalshiStats.min)}  max: ${fmtBps(kalshiStats.max)}` : '',
    hlStats     ? `HL spread 1h avg:     ${fmtBps(hlStats.avg)}  min: ${fmtBps(hlStats.min)}  max: ${fmtBps(hlStats.max)}` : '',
    ``,
    `🕐 ${new Date().toUTCString()}`,
  ].filter((l) => l !== undefined);

  return lines.join('\n');
}

/**
 * Periodic spread report — included in the hourly heartbeat.
 * Shows rolling spread stats and current MM thesis viability.
 */
function buildSpreadReport(mm, kalshiStats, hlStats, kalshiSnap, hlSnap) {
  const viableStr = mm.viable ? '✅ VIABLE' : '❌ not viable';

  const lines = [
    `<b>── SPREAD & MM THESIS ──</b>`,
    ``,
    `<b>Current spreads:</b>`,
    `Kalshi:  bid $${fmt(kalshiSnap?.bestBid, 0)}  ask $${fmt(kalshiSnap?.bestAsk, 0)}  width: ${fmtBps(mm.kalshiSpreadBps)}`,
    `HL:      bid $${fmt(hlSnap?.bestBid, 0)}  ask $${fmt(hlSnap?.bestAsk, 0)}  width: ${fmtBps(mm.hlSpreadBps)}`,
    `Ratio:   ${fmt(mm.spreadRatio, 1)}x wider on Kalshi`,
    ``,
    kalshiStats
      ? `<b>Kalshi spread (last ${kalshiStats.n} min):</b>  avg ${fmtBps(kalshiStats.avg)}  min ${fmtBps(kalshiStats.min)}  max ${fmtBps(kalshiStats.max)}`
      : '',
    hlStats
      ? `<b>HL spread (last ${hlStats.n} min):</b>      avg ${fmtBps(hlStats.avg)}  min ${fmtBps(hlStats.min)}  max ${fmtBps(hlStats.max)}`
      : '',
    ``,
    `<b>MM thesis (quote Kalshi, hedge HL):</b> ${viableStr}`,
    `Net per fill: ${fmtBps(mm.netEdgePerFillBps)}  Break-even spread needed: ${fmtBps(mm.breakEvenKalshiSpreadBps)}`,
    `Funding carry (${mm.assumedHoldingHours}h): ${fmtBps(mm.fundingCarryBps)}  HL: ${fmtPct(mm.hlAnnualFundingPct)}/yr`,
  ].filter((l) => l !== undefined);

  return lines.join('\n');
}

module.exports = { buildMMAlert, buildSpreadReport };
