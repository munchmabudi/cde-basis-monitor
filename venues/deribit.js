// venues/deribit.js
// Thin adapter: exposes a per-instrument getSnapshot(arg) in the same shape the
// CDE sim consumes ({ venue, markPrice, bestBid, bestAsk, bids, asks, ... }).
// arg = { instrument }  e.g. { instrument: 'BTC-PERPETUAL' } or a raw string.
const { client } = require('./deribit_client');

async function getSnapshot(arg) {
  const inst = typeof arg === 'string' ? arg : (arg && arg.instrument);
  if (!inst) return { venue: 'deribit', error: 'no instrument' };
  // wait for the first snapshot so we never hand the sim an empty book
  await client.ensure(inst);
  const snap = client.snapshot(inst, 'deribit');
  if (!snap) return { venue: 'deribit', error: `no book for ${inst}` };
  return snap;
}

// also expose helper to get a book directly (for dated-future basis readout)
function getBook(inst) { return client.getBook(inst); }

module.exports = { getSnapshot, getBook, client };
