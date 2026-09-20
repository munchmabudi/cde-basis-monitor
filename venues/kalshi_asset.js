// venues/kalshi_asset.js
// Generic Kalshi perp fetcher — works for any asset given its config.
// Call: getSnapshot(assetConfig) where assetConfig is one entry from config.assets

const config = require('../config');

async function fetchJson(path) {
  const res = await fetch(`${config.endpoints.kalshi.base}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kalshi ${res.status} (${path}): ${body.slice(0, 150)}`);
  }
  return res.json();
}

function toUsd(contractPrice, contractSize) {
  return parseFloat(contractPrice) / contractSize;
}

async function getSnapshot(asset) {
  const { kalshiTicker: ticker, kalshiContractSize: contractSize } = asset;

  const [marketData, fundingData, orderbookData] = await Promise.all([
    fetchJson(`/margin/markets/${ticker}`),
    fetchJson(`/margin/funding_rates/historical?ticker=${ticker}&limit=2`),
    fetchJson(`/margin/markets/${ticker}/orderbook`),
  ]);

  const market = marketData.market;

  // Update contractSize from live data if available (self-correcting)
  const liveContractSize = parseFloat(market.contract_size) || contractSize;

  const fundingRates = fundingData.funding_rates ?? [];
  const latestFunding = fundingRates[0];
  const fundingRate = latestFunding ? parseFloat(latestFunding.funding_rate) / 10000 : 0;

  const markPrice = toUsd(parseFloat(market.liquidation_mark_price?.price ?? market.price), liveContractSize);
  const bestBid   = toUsd(market.bid, liveContractSize);
  const bestAsk   = toUsd(market.ask, liveContractSize);

  // Both bid and ask arrays come back descending — reverse both
  const asks = (orderbookData.orderbook?.asks ?? [])
    .map(([p, q]) => ({ price: toUsd(p, liveContractSize), qty: parseFloat(q) }))
    .reverse();
  const bids = (orderbookData.orderbook?.bids ?? [])
    .map(([p, q]) => ({ price: toUsd(p, liveContractSize), qty: parseFloat(q) }))
    .reverse();

  return {
    venue: 'kalshi',
    asset: asset.kalshiTicker.replace('KX','').replace('PERP',''), // 'BTC', 'ETH', etc.
    markPrice,
    bestBid,
    bestAsk,
    fundingRate,
    fundingIntervalHours: 8,
    nextFundingTime: null,
    bids,
    asks,
    contractSize: liveContractSize,
    openInterest: parseFloat(market.open_interest_notional_value_dollars ?? 0),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
