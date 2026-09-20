// alerts/telegram.js
// Reuses the same Telegram bot/channel pattern from your existing IV
// monitoring setup. Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from
// process.env (set these in your .env file alongside your other keys).

const config = require('../config');

async function sendMessage(text) {
  const token = process.env[config.telegram.botTokenEnv];
  const chatId = process.env[config.telegram.chatIdEnv];

  if (!token || !chatId) {
    console.error('[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment');
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[telegram] Send failed: ${res.status} ${body}`);
  }
}

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return 'N/A';
  return n.toFixed(decimals);
}

function fmtBps(bps) {
  if (bps == null || isNaN(bps)) return 'N/A';
  return `${bps >= 0 ? '+' : ''}${fmt(bps, 1)} bps`;
}

function fmtPct(pct) {
  if (pct == null || isNaN(pct)) return 'N/A';
  return `${pct >= 0 ? '+' : ''}${fmt(pct, 3)}%`;
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Build a nicely formatted alert message for a single pair opportunity.
 *
 * @param {object} edge - result from analysis/edge.js evaluatePair()
 * @param {object} snapA - venue snapshot (for current prices/funding context)
 * @param {object} snapB - venue snapshot
 */
function buildOpportunityMessage(edge, snapA, snapB) {
  const long = edge.longVenue.toUpperCase();
  const short = edge.shortVenue.toUpperCase();
  const longSnap = [snapA, snapB].find((s) => s.venue === edge.longVenue);
  const shortSnap = [snapA, snapB].find((s) => s.venue === edge.shortVenue);

  const emoji = edge.netEdgeBps >= 30 ? '🚨' : '⚡';

  const lines = [
    `${emoji} <b>BTC PERP ARB SIGNAL</b>`,
    ``,
    `<b>Trade:</b> LONG ${long} / SHORT ${short}`,
    `<b>Notional:</b> $${edge.notionalUsd.toLocaleString()} | Hold est: ${edge.assumedHoldingHours}h`,
    ``,
    `<b>── PRICES ──</b>`,
    `${long}  bid: $${fmt(longSnap?.bestBid, 0)}  ask: $${fmt(longSnap?.bestAsk, 0)}  mark: $${fmt(longSnap?.markPrice, 0)}`,
    `${short}  bid: $${fmt(shortSnap?.bestBid, 0)}  ask: $${fmt(shortSnap?.bestAsk, 0)}  mark: $${fmt(shortSnap?.markPrice, 0)}`,
    `Entry fills (avg): LONG $${fmt(edge.longFill?.avgPrice, 1)}  SHORT $${fmt(edge.shortFill?.avgPrice, 1)}`,
    ``,
    `<b>── FUNDING (annualized) ──</b>`,
    `${long}: ${fmtPct(edge.longAnnualFundingPct)}/yr  (you pay as long)`,
    `${short}: ${fmtPct(edge.shortAnnualFundingPct)}/yr  (you receive as short)`,
    `Net funding carry over ${edge.assumedHoldingHours}h: ${fmtBps(edge.fundingEdgeBpsOverHolding)}`,
    ``,
    `<b>── EDGE BREAKDOWN ──</b>`,
    `Price discrepancy:      ${fmtBps(edge.priceEdgeBps)}`,
    `Funding carry (${edge.assumedHoldingHours}h):   ${fmtBps(edge.fundingEdgeBpsOverHolding)}`,
    `Entry fees (both legs): ${fmtBps(-edge.entryFeeBps)}`,
    `Est. exit cost:         ${fmtBps(-edge.estimatedExitCostBps)}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `<b>Net edge: ${fmtBps(edge.netEdgeBps)} → ${fmtUsd(edge.netEdgeUsd)} on $${edge.notionalUsd.toLocaleString()}</b>`,
    ``,
    `⚠️ Kalshi perps schema unverified — confirm manually before trading`,
    `🕐 ${new Date().toUTCString()}`,
  ];

  return lines.join('\n');
}

/**
 * Build a summary heartbeat message (sent even when no opportunity exists,
 * so you know the monitor is still running). Sent less frequently than
 * the opportunity check — caller controls when to invoke this.
 */
function buildHeartbeatMessage(snapshots, edges) {
  const ts = new Date().toUTCString();
  const lines = [
    `📡 <b>BTC PERP MONITOR — no arb above threshold</b>`,
    ``,
  ];

  for (const snap of snapshots) {
    if (!snap || snap.error) {
      lines.push(`${(snap?.venue ?? 'unknown').toUpperCase()}: ❌ fetch error`);
      continue;
    }
    const fundingPct = snap.fundingRate * (8760 / snap.fundingIntervalHours) * 100;
    lines.push(
      `<b>${snap.venue.toUpperCase()}</b>  mark: $${fmt(snap.markPrice, 0)}  bid/ask: ${fmt(snap.bestBid, 0)}/${fmt(snap.bestAsk, 0)}  funding: ${fmtPct(fundingPct)}/yr`
    );
  }

  if (edges.length > 0) {
    lines.push(``, `<b>Best pair:</b>`);
    const best = edges.slice().sort((a, b) => (b.netEdgeBps ?? -999) - (a.netEdgeBps ?? -999))[0];
    if (best.tradeable) {
      lines.push(
        `LONG ${best.longVenue.toUpperCase()} / SHORT ${best.shortVenue.toUpperCase()} → net ${fmtBps(best.netEdgeBps)}`
      );
    } else {
      lines.push(`${best.longVenue.toUpperCase()} vs ${best.shortVenue.toUpperCase()}: ${best.reason}`);
    }
  }

  lines.push(``, `🕐 ${ts}`);
  return lines.join('\n');
}

module.exports = { sendMessage, buildOpportunityMessage, buildHeartbeatMessage };
