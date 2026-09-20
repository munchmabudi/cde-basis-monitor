// venues/kalshi.js — final fix 2026-06-30
// Confirmed from two debug runs:
//   raw asks: DESCENDING (highest first) → reverse → ascending ✅
//   raw bids: ASCENDING (lowest first)  → reverse → descending ✅
// Both need reversing.

const config = require('../config');
const CONTRACT_SIZE = 0.0001;

async function fetchJson(path) {
  const { base } = config.endpoints.kalshi;
  const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kalshi ${res.status} (${path}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

function toUsd(contractPrice) {
  return parseFloat(contractPrice) / CONTRACT_SIZE;
}

async function getSnapshot() {
  const { ticker } = config.endpoints.kalshi;

  const [marketData, fundingData, orderbookData] = await Promise.all([
    fetchJson(`/margin/markets/${ticker}`),
    fetchJson(`/margin/funding_rates/historical?ticker=${ticker}&limit=2`),
    fetchJson(`/margin/markets/${ticker}/orderbook`),
  ]);

  const market = marketData.market;
  const fundingRates = fundingData.funding_rates ?? [];
  const latestFunding = fundingRates[0];
  const fundingRate = latestFunding ? parseFloat(latestFunding.funding_rate) / 10000 : 0;

  const markPrice = toUsd(parseFloat(market.liquidation_mark_price?.price ?? market.price));
  const bestBid = toUsd(market.bid);
  const bestAsk = toUsd(market.ask);

  // Both sides come back in the wrong order from the raw API — reverse both.
  // asks: raw DESCENDING → reverse → ASCENDING (lowest ask first) ✅
  // bids: raw ASCENDING  → reverse → DESCENDING (highest bid first) ✅
  const asks = (orderbookData.orderbook?.asks ?? [])
    .map(([p, q]) => ({ price: toUsd(p), qty: parseFloat(q) }))
    .reverse();

  const bids = (orderbookData.orderbook?.bids ?? [])
    .map(([p, q]) => ({ price: toUsd(p), qty: parseFloat(q) }))
    .reverse();

  return {
    venue: 'kalshi',
    markPrice,
    bestBid,
    bestAsk,
    fundingRate,
    fundingIntervalHours: 8,
    nextFundingTime: null,
    bids,
    asks,
    openInterest: parseFloat(market.open_interest_notional_value_dollars ?? 0),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
