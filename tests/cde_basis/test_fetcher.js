const m = require(require('path').join(__dirname, '..', '..', 'analysis', 'cde_basis_bidask.js'));
let fails = 0;
const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GOOD = { pricebook: { bids: [{ price: '99', size: '1' }], asks: [{ price: '101', size: '1' }], time: 'x' } };

// rate limiter mock: at most `max` requests per rolling `windowMs`; excess -> HTTP 429 (like the real failure)
function limiterFetch(max, windowMs, latencyMs = 5) {
  const hits = [];
  const f = async (url) => {
    const t = Date.now();
    while (hits.length && t - hits[0] > windowMs) hits.shift();
    f.total++;
    if (hits.length >= max) { f.rejected++; throw new Error(`HTTP 429 for ${url}`); }
    hits.push(t);
    await sleep(latencyMs);
    return GOOD;
  };
  f.total = 0; f.rejected = 0;
  return f;
}
const ids = (n) => Array.from({ length: n }, (_, i) => 'P' + i);

(async () => {
  // 1. Is the mock a fair reproduction of the bug? 75 simultaneous, unpaced requests.
  {
    const f = limiterFetch(10, 1000);
    const res = await Promise.all(ids(75).map(id => f('https://x/product_book?product_id=' + id).then(() => 'ok', () => '429')));
    const bad = res.filter(r => r === '429').length;
    ok('mock reproduces the bug: unpaced burst of 75 -> most rejected', bad >= 50, `${bad}/75 got 429 (user saw 49/75)`);
  }
  // 2. Paced at ~8/s against a 10/s limit: every book gets through, zero 429s
  {
    const f = limiterFetch(10, 1000);
    const fx = m.createBookFetcher(f, { minIntervalMs: 120, backoffMs: 50 });
    const t0 = Date.now();
    const out = await fx.getBooks(ids(40));
    const okc = [...out.values()].filter(b => !b.error).length;
    ok('paced fetch: all 40 books succeed', okc === 40, `${okc}/40 in ${Date.now() - t0}ms`);
    ok('paced fetch: zero 429s hit', f.rejected === 0, 'rejected=' + f.rejected);
  }
  // 3. Deliberately too fast (50/s vs 10/s limit): must adapt (widen spacing + retry) and still finish
  {
    const f = limiterFetch(5, 500);
    const fx = m.createBookFetcher(f, { minIntervalMs: 10, backoffMs: 100, maxRetries: 8 });
    const out = await fx.getBooks(ids(30));
    const okc = [...out.values()].filter(b => !b.error).length;
    ok('too-fast config adapts: all 30 succeed via retries', okc === 30, `${okc}/30, 429s absorbed=${fx.stats.rate429}, retries=${fx.stats.retries}`);
    ok('spacing widened after 429s', fx._interval() > 10, 'interval=' + fx._interval().toFixed(0) + 'ms');
    ok('some 429s really occurred (test is meaningful)', fx.stats.rate429 > 0);
  }
  // 4. Last-good fallback + short error text + stale cutoff (fake cache clock)
  {
    let t = 0, failing = false;
    const f = async (url) => { if (failing) throw new Error('HTTP 429 for ' + url); return GOOD; };
    const fx = m.createBookFetcher(f, { minIntervalMs: 0, maxRetries: 0, ttlMs: 1000, errorTtlMs: 500, maxStaleMs: 5000, now: () => t });
    const a = await fx.getBooks(['A']); ok('initial fetch ok, stamped fetchedAt', !a.get('A').error && a.get('A').fetchedAt === 0);
    failing = true; t = 2000;
    const b = (await fx.getBooks(['A'])).get('A');
    ok('refresh fails -> serves last good quote flagged stale (not blank)', !b.error && b.stale === true && b.bid === 99 && b.fetchedAt === 0, JSON.stringify({ stale: b.stale, bid: b.bid, fetchedAt: b.fetchedAt }));
    t = 9000;
    const c = (await fx.getBooks(['A'])).get('A');
    ok('last good too old (>5s) -> error shown', c.error === 'HTTP 429', JSON.stringify(c.error));
    ok('error text has no URL', !/https?:/.test(c.error));
    const calls = (() => { let n = 0; const g = async () => { n++; throw new Error('HTTP 500'); }; return { g, n: () => n }; })();
    let t2 = 0; const fx2 = m.createBookFetcher(calls.g, { minIntervalMs: 0, maxRetries: 0, errorTtlMs: 500, now: () => t2 });
    await fx2.getBooks(['Z']); await fx2.getBooks(['Z']); const n1 = calls.n(); t2 = 600; await fx2.getBooks(['Z']);
    ok('failures cached only briefly (errorTtl), then retried', n1 === 1 && calls.n() === 2, `calls after 2 quick reads=${n1}, after ttl=${calls.n()}`);
  }
  // 4b. permanent (404) errors are not hammered; transient ones are retried soon
  {
    let t = 0, n404 = 0, n500 = 0;
    const f = async (url) => { if (/id=GONE/.test(url)) { n404++; throw new Error('HTTP 404 for ' + url); } n500++; throw new Error('HTTP 500 for ' + url); };
    const fx = m.createBookFetcher(f, { minIntervalMs: 0, maxRetries: 0, errorTtlMs: 500, notFoundTtlMs: 60000, now: () => t });
    await fx.getBooks(['GONE', 'FLAKY']); t = 2000; await fx.getBooks(['GONE', 'FLAKY']);
    ok('404 cached long (1 request even after errorTtl)', n404 === 1, 'n404=' + n404);
    ok('500 retried after the short error TTL (2 requests)', n500 === 2, 'n500=' + n500);
    t = 61000; await fx.getBooks(['GONE']);
    ok('404 retried only after its long TTL', n404 === 2, 'n404=' + n404);
  }
  // 5. Non-blocking: returns within maxWaitMs with partial results, rest fill in afterwards
  {
    const f = limiterFetch(1000, 1000, 5);
    const fx = m.createBookFetcher(f, { minIntervalMs: 60 });
    const t0 = Date.now();
    const out = await fx.getBooks(ids(20), { maxWaitMs: 300 });
    const dt = Date.now() - t0;
    const done = [...out.values()].filter(b => !b.error).length, loading = [...out.values()].filter(b => b.error === 'loading').length;
    ok('returns promptly instead of waiting for the full sweep (20*60ms=1.2s)', dt < 1200, dt + 'ms');
    ok('partial: some ready, rest marked loading', done > 0 && loading > 0 && done + loading === 20, `ready=${done} loading=${loading}`);
    await sleep(1300);
    const out2 = await fx.getBooks(ids(20), { maxWaitMs: 300 });
    ok('background requests kept going: next call has all 20', [...out2.values()].every(b => !b.error), [...out2.values()].filter(b => b.error).length + ' still missing');
  }
  // 6. Overlapping callers share requests
  {
    let n = 0; const f = async () => { n++; await sleep(10); return GOOD; };
    const fx = m.createBookFetcher(f, { minIntervalMs: 0 });
    await Promise.all([fx.getBooks(ids(10)), fx.getBooks(ids(10)), fx.getBooks(ids(10))]);
    ok('3 simultaneous callers, 10 ids -> 10 requests', n === 10, 'requests=' + n);
  }
  // 7. Requests start in the order asked (keeps a token's legs together) and are spaced
  {
    const starts = []; const f = async (url) => { starts.push([url.match(/product_id=([^&]+)/)[1], Date.now()]); return GOOD; };
    const fx = m.createBookFetcher(f, { minIntervalMs: 40 });
    await fx.getBooks(['A', 'B', 'C', 'D']);
    ok('order preserved', starts.map(s => s[0]).join('') === 'ABCD');
    const gaps = starts.slice(1).map((s, i) => s[1] - starts[i][1]);
    ok('spaced >= ~40ms apart', gaps.every(g => g >= 35), gaps.join(','));
  }
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
})();
