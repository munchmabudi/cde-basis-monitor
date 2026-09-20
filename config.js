// config.js — v2: multi-asset (BTC, ETH, SOL, HYPE, XRP)
// Contract sizes confirmed from live Kalshi markets list 2026-07-06:
//   KXBTCPERP  = 0.0001 BTC
//   KXETHPERP  = 0.001  ETH
//   KXSOLPERP  = 0.1    SOL
//   KXHYPEPERP = 0.1    HYPE
//   KXXRPPERP  = 1      XRP

module.exports = {
  pollIntervalMs:      60_000,
  alertThresholdBps:   15,
  alertCooldownMs:     30 * 60_000,
  assumedHoldingHours: 8,

  assets: {
    BTC: {
      kalshiTicker:      'KXBTCPERP',
      kalshiContractSize: 0.0001,
      hlCoin:            'BTC',
      okxInstId:         'BTC-USDT-SWAP',
      krakenTicker:      'PF_XBTUSD',
      coinbaseProductId: 'BTC-PERP-INTX',
      notionalUsd:       75_000,
    },
    ETH: {
      kalshiTicker:      'KXETHPERP',
      kalshiContractSize: 0.001,
      hlCoin:            'ETH',
      okxInstId:         'ETH-USDT-SWAP',
      krakenTicker:      'PF_ETHUSD',
      coinbaseProductId: 'ETH-PERP-INTX',
      notionalUsd:       75_000,
    },
    SOL: {
      kalshiTicker:      'KXSOLPERP',
      kalshiContractSize: 0.1,
      hlCoin:            'SOL',
      okxInstId:         'SOL-USDT-SWAP',
      krakenTicker:      'PF_SOLUSD',
      coinbaseProductId: 'SOL-PERP-INTX',
      notionalUsd:       75_000,
    },
    HYPE: {
      kalshiTicker:      'KXHYPEPERP',
      kalshiContractSize: 0.1,
      hlCoin:            'HYPE',
      okxInstId:         null,
      krakenTicker:      null,
      coinbaseProductId: null,
      notionalUsd:       25_000,
    },
    XRP: {
      kalshiTicker:      'KXXRPPERP',
      kalshiContractSize: 1,
      hlCoin:            'XRP',
      okxInstId:         null,
      krakenTicker:      null,
      coinbaseProductId: null,
      notionalUsd:       25_000,
    },
    LTC: {
      kalshiTicker:      'KXLTCPERP',
      kalshiContractSize: 0.1,       // confirmed: KXLTCPERP = 0.1 LTC per contract
      hlCoin:            'LTC',
      okxInstId:         null,
      krakenTicker:      null,
      coinbaseProductId: null,
      notionalUsd:       10_000,     // criteria F/G size
    },
    LINK: {
      kalshiTicker:      'KXLINKPERP',
      kalshiContractSize: 1,         // confirmed: KXLINKPERP = 1 LINK per contract
      hlCoin:            'LINK',
      okxInstId:         null,
      krakenTicker:      null,
      coinbaseProductId: null,
      notionalUsd:       10_000,
    },
    BCH: {
      kalshiTicker:      'KXBCHPERP',
      kalshiContractSize: 0.01,
      hlCoin:            'BCH',
      okxInstId:         null,
      krakenTicker:      null,
      coinbaseProductId: null,
      notionalUsd:       10_000,
    },
    SUI: {
      kalshiTicker:      'KXSUIPERP',
      kalshiContractSize: 10,        // confirmed: KXSUIPERP = 10 SUI per contract
      hlCoin:            'SUI',
      okxInstId:         null,
      krakenTicker:      null,
      coinbaseProductId: null,
      notionalUsd:       10_000,
    },
    // DOT: KXDOTPERP exists but has NO active market (bid/ask both $0) — skipped
    // Re-enable by uncommenting when Kalshi DOT market becomes active
    // DOT: { kalshiTicker:'KXDOTPERP', kalshiContractSize:10, hlCoin:'DOT', notionalUsd:10_000 },
    DOGE: {
      kalshiTicker:      'KXDOGEPERP',
      kalshiContractSize: 100,       // confirmed: KXDOGEPERP = 100 DOGE per contract
      hlCoin:            'DOGE',
      okxInstId:         null,
      krakenTicker:      null,
      coinbaseProductId: null,
      notionalUsd:       10_000,
    },
    SHIB: {
      kalshiTicker:      'KXKSHIBPERP',
      kalshiContractSize: 1000,      // confirmed: KXKSHIBPERP = 1K kSHIB = 1000 SHIB per contract
      hlCoin:            'kSHIB',    // HL uses kSHIB (1000 SHIB) as the unit
      okxInstId:         null,
      krakenTicker:      null,
      coinbaseProductId: null,
      notionalUsd:       10_000,
    },
  },

  fees: {
    kalshi:      { taker: 0.0012, maker: 0.0005 },
    kraken:      { taker: 0.0005, maker: 0.0002 },
    hyperliquid: { taker: 0.00035, maker: 0.0001 },
    coinbase:    { taker: 0.0003, maker: 0.0000 },
    okx:         { taker: 0.0005, maker: 0.0002 },
    lighter:     { taker: 0.0001, maker: 0.0000 },  // retail: 0% maker, 0.01% taker
  },

  telegram: {
    botTokenEnv: 'TELEGRAM_BOT_TOKEN',
    chatIdEnv:   'TELEGRAM_CHAT_ID_KALSHI',  // separate channel from HXRO monitor
  },

  // ── CDE MM SIM (Coinbase Derivatives Exchange market-making viability) ──
  // Model: quote CDE bid/ask at refMid ∓ width around the REFERENCE venue mid
  // (default Hyperliquid, fallback Coinbase spot for non-HL assets); assume full
  // CDE size fills at that price (CDE book never fetched); hedge by walking
  // HEDGE venue books (perps + optional futures venue), picking the cheapest
  // fully-filling venue per leg. No CDE API key required.
  //
  // Per-token parameters below are from the CDE market-making table (width bps,
  // size in CDE contracts) + CDE contract MULTIPLIER (underlying units/contract,
  // sourced from Coinbase Derivatives spec sheets). `multiplier` is used to
  // convert size-in-contracts → USD notional for the hedge walk and to report
  // the whole-contract CDE count. `multiplierUncertain` flags sizes I could not
  // confirm from an authoritative CDE source (shown as ⚠ on alerts).
  cde: {
    referenceVenue: 'hyperliquid',            // quote around this venue's mid
    spotFallbackVenue: 'coinbase_spot',       // ref-mid fallback for non-HL underlyings
    hedgeVenues: ['hyperliquid', 'kraken', 'okx', 'lighter'], // perps only for now
    // futuresHedgeVenue: null,               // add a REAL futures CLOB feed here later
    //                                     (no fabricated depth; wire only when a
    //                                      licensed/accessible book exists).

    // CDE maker fee: FLAT $0.02 per CDE contract traded (one side), per Coinbase
    // Derivatives' fee schedule. Not a bps rate — CDE quotes fees in $/contract,
    // so we apply fee = 0.02 × sizeContracts. The single scenario uses this fee.
    feePerContractUsd: 0.02,

    // class: 'Major' or 'Alt' (drives the two separate alert lists).
    // widthBps: TOTAL bid/ask spread (bps) from your CDE table — i.e. the gap
    //   between our posted bid and ask. We post bid = mid − W/2, ask = mid + W/2,
    //   so total = W (matches your table). Native scenarios A/D use total = W;
    //   stress scenarios B/E use total = 2W. sizeContracts: from your table.
    //   multiplier: CDE units per contract (standard BTC/ETH/XRP ⚠ uncertain).
    assets: {
      // Multipliers from Coinbase Derivatives' own contract spec sheet.
      // `multiplierUncertain` = I could NOT confirm the standard-contract size
      // from an authoritative CDE source (only the nano size is published);
      // flagged ⚠ on alerts. Width bps + size-contracts are from your table.
      BTC:        { cdeToken: 'BTI',  class: 'Major', widthBps: 7,  sizeContracts: 2,    multiplier: 1,        notionalHint: 'BTC'  },
      ETH:        { cdeToken: 'ETI', class: 'Major', widthBps: 24, sizeContracts: 2,    multiplier: 10,       notionalHint: 'ETH'  },
      SOL:        { cdeToken: 'SLC',  class: 'Major', widthBps: 30, sizeContracts: 2,    multiplier: 100,      notionalHint: 'SOL'  },
      XRP:        { cdeToken: 'XRL', class: 'Major', widthBps: 25, sizeContracts: 2,    multiplier: 10000,    notionalHint: 'XRP'  },
      // ── nano majors (updated widths/sizes from user table 2026-08-13) ──
      nBTC:       { cdeToken: 'nBTC',  class: 'Major', widthBps: 6,  sizeContracts: 50,   multiplier: 0.01,     notionalHint: 'BTC'  },
      nETH:       { cdeToken: 'nETH',  class: 'Major', widthBps: 15, sizeContracts: 50,   multiplier: 0.1,      notionalHint: 'ETH'  },
      nSOL:       { cdeToken: 'nSOL',  class: 'Major', widthBps: 15, sizeContracts: 30,   multiplier: 5,        notionalHint: 'SOL'  },
      nXRP:       { cdeToken: 'nXRP',  class: 'Major', widthBps: 15, sizeContracts: 20,   multiplier: 500,      notionalHint: 'XRP'  },
      // ── alts (updated widths/sizes from user table 2026-08-13) ──
      // multipliers from CDE contract spec sheet (Coinbase Derivatives contract-size table)
      ADA:        { cdeToken: 'ADA',  class: 'Alt',   widthBps: 30, sizeContracts: 20,   multiplier: 1000,     notionalHint: 'ADA'  },
      LTC:        { cdeToken: 'LTC',  class: 'Alt',   widthBps: 10, sizeContracts: 20,   multiplier: 5,        notionalHint: 'LTC'  },
      DOGE:       { cdeToken: 'DOGE', class: 'Alt',   widthBps: 10, sizeContracts: 20,   multiplier: 5000,     notionalHint: 'DOGE' },
      AVAX:       { cdeToken: 'AVA',  class: 'Alt',   widthBps: 30, sizeContracts: 40,   multiplier: 10,       notionalHint: 'AVAX' },
      LINK:       { cdeToken: 'LINK', class: 'Alt',   widthBps: 10, sizeContracts: 16,   multiplier: 50,       notionalHint: 'LINK' },
      SUI:        { cdeToken: 'SUI',  class: 'Alt',   widthBps: 10, sizeContracts: 16,   multiplier: 500,      notionalHint: 'SUI'  },
      BNB:        { cdeToken: 'BNB',  class: 'Alt',   widthBps: 10, sizeContracts: 20,   multiplier: 1,        notionalHint: 'BNB'  },
      HYPE:       { cdeToken: 'HYPE', class: 'Alt',   widthBps: 10, sizeContracts: 20,   multiplier: 10,       notionalHint: 'HYPE' },
      DOT:        { cdeToken: 'DOT',  class: 'Alt',   widthBps: 30, sizeContracts: 16,   multiplier: 100,      notionalHint: 'DOT'  },
      XLM:        { cdeToken: 'XLM',  class: 'Alt',   widthBps: 10, sizeContracts: 20,   multiplier: 5000,     notionalHint: 'XLM'  },
      kSHIB:      { cdeToken: '1kSHIB', class: 'Alt', widthBps: 30, sizeContracts: 50,  multiplier: 10000,    notionalHint: 'kSHIB' },
      HBAR:       { cdeToken: 'HBAR', class: 'Alt',   widthBps: 10, sizeContracts: 16,   multiplier: 5000,     notionalHint: 'HBAR' },
      BCH:        { cdeToken: 'BCH',  class: 'Alt',   widthBps: 10, sizeContracts: 20,   multiplier: 1,        notionalHint: 'BCH'  },
      // ── new alts added 2026-08-13 (multipliers from CDE contract spec) ──
      // cdeToken codes are best-effort (CDE futures tickers); notionalHint drives pricing.
      COIN50:     { cdeToken: 'C50',  class: 'Alt',   widthBps: 10, sizeContracts: 30,   multiplier: 1,        notionalHint: 'COIN50', note: 'no HL/spot ref feed yet — sim shows no data' },
      PAXG:       { cdeToken: 'PAU',  class: 'Alt',   widthBps: 10, sizeContracts: 4,    multiplier: 1,        notionalHint: 'PAXG' },
      ZEC:        { cdeToken: 'ZEC',  class: 'Alt',   widthBps: 10, sizeContracts: 20,   multiplier: 1,        notionalHint: 'ZEC'  },
      '1kPEPE':   { cdeToken: 'PEP',  class: 'Alt',   widthBps: 10, sizeContracts: 20,   multiplier: 100_000_000, notionalHint: 'PEPE', refSpotFallback: true, hedgeCoin: 'kPEPE', hedgeNote: 'HL kPEPE=1000 PEPE/coin; hedge=100k kPEPE per CDE ctr. USD-notional walk handles the ratio — no extra multiplier.' },
      AAVE:       { cdeToken: 'AAV',  class: 'Alt',   widthBps: 10, sizeContracts: 10,   multiplier: 5,        notionalHint: 'AAVE' },
      ONDO:       { cdeToken: 'OND',  class: 'Alt',   widthBps: 10, sizeContracts: 20,   multiplier: 1000,     notionalHint: 'ONDO' },
      ENA:        { cdeToken: 'ENA',  class: 'Alt',   widthBps: 10, sizeContracts: 10,   multiplier: 5000,     notionalHint: 'ENA'  },
      NEAR:       { cdeToken: 'NAR',  class: 'Alt',   widthBps: 10, sizeContracts: 10,   multiplier: 500,      notionalHint: 'NEAR' },
    },
  },

  // ── CDE FUTURES MM SIM (separate task, Deribit-fed) ──────────────
  // Same engine (simulateCDE) + same KPIs ($0.02/ctr, half-spread − hedge − fee),
  // but the REFERENCE + HEDGE venue is Deribit, fed by live L2 book WS.
  // Scope: MAJORS only (BTC/ETH/SOL/XRP family) — Deribit lists these with real
  // depth. Alts (incl. 1kPEPE→HL) are NOT in this sim.
  //   - perp future (BTC-PERPETUAL etc.) = the HEDGE leg (basis ≈ spot).
  //   - dated futures (BTC-29AUG25…) are pulled as a BASIS READOUT (reference
  //     overlay), NOT a hedge — crossing a perp-style CDE leg with a dated future
  //     carries term-structure risk the sim doesn't model yet.
  cdeFutures: {
    referenceVenue: 'deribit',
    hedgeVenue: 'deribit',
    feePerContractUsd: 0.02,         // same CDE flat fee
    // Deribit instrument per underlying (perp = hedge). Dated list is for basis.
    // NOTE: Deribit lists PERPETUAL futures ONLY for BTC and ETH. SOL/XRP (and
    // their nanos) have NO Deribit futures at all — excluded from this sim.
    instruments: {
      BTC:  { perp: 'BTC-PERPETUAL',  dated: ['BTC-28AUG26', 'BTC-30OCT26'] },
      ETH:  { perp: 'ETH-PERPETUAL',  dated: ['ETH-28AUG26', 'ETH-30OCT26'] },
      nBTC: { perp: 'BTC-PERPETUAL',  dated: ['BTC-28AUG26', 'BTC-30OCT26'] },
      nETH: { perp: 'ETH-PERPETUAL',  dated: ['ETH-28AUG26', 'ETH-30OCT26'] },
    },
    // widths/sizes reused from the perp-style CDE table (same token, same CDE
    // contract economics). class forced to 'Major' for a single alert list.
    // Only BTC/ETH family — the only majors Deribit lists as perpetual futures.
    assets: {
      BTC:  { cdeToken: 'BTI', class: 'Major', widthBps: 7,  sizeContracts: 2,  multiplier: 1,     notionalHint: 'BTC'  },
      ETH:  { cdeToken: 'ETI', class: 'Major', widthBps: 24, sizeContracts: 2,  multiplier: 10,    notionalHint: 'ETH'  },
      nBTC: { cdeToken: 'nBTC', class: 'Major', widthBps: 6,  sizeContracts: 50, multiplier: 0.01,  notionalHint: 'BTC'  },
      nETH: { cdeToken: 'nETH', class: 'Major', widthBps: 15, sizeContracts: 50, multiplier: 0.1,   notionalHint: 'ETH'  },
    },
  },

  // ── CAPITAL / MARGIN MODEL (capital requirements for CDE MM) ─────
  // Per your instruction: US trader → Coinbase perp cap = 10x (10% initial
  // margin) across all contracts. We APPLY 10x/10% to the CDE leg as an
  // ASSUMPTION (Coinbase Derivatives clearing margin is distinct from the
  // retail perp table; flag below marks it assumed until you confirm).
  // Hedge-venue leverage is pulled LIVE where possible (HL/OKX) and marked
  // "documented" for Deribit/Kraken and "unknown" for Lighter.
  margin: {
    cde: {
      initialMarginRate: 0.10,   // 10x leverage (US cap). FLAGGED ASSUMED.
      conservativeRate: 0.20,    // 5x leverage (20% IM) — conservative column
      futuresRate: 0.25,        // 4x leverage (25% IM) for CDE DATED FUTURES (your instruction)
      assumed: true,             // set false once you confirm the real CDE clearing IM
      // Tokens that actually have a CDE DATED FUTURE product (from the CDE product
      // catalog). Perps exist for more tokens, but Futures-only must list ONLY these.
      futuresTokens: ['BTC','ETH','SOL','XRP','nBTC','nETH','nSOL','nXRP',
        'BCH','LTC','DOGE','AVAX','LINK','SUI','BNB','HYPE','DOT','XLM','kSHIB','HBAR','ADA'],
    },
    // Hedge-venue max leverage by asset. Source tags: live=API-confirmed,
    // doc=published rate, unk=unknown (flagged in output).
    venues: {
      hyperliquid: { source: 'live', byAsset: {
        BTC:40, ETH:25, SOL:20, XRP:20, AVAX:10, BNB:10, LTC:10, DOGE:10, SUI:10,
        LINK:10, BCH:10, AAVE:10, kSHIB:10, DOT:10, ADA:10, NEAR:10, ONDO:10,
        ENA:10, HBAR:5, XLM:5, HYPE:10, PAXG:10, ZEC:10, PEPE:10,
      }},
      okx:         { source: 'live', byAsset: { BTC:100, ETH:100, SOL:50, XRP:50, PEPE:50 }},
      deribit:     { source: 'doc',  byAsset: { BTC:50, ETH:50 }},   // 2% IM documented
      kraken:      { source: 'doc',  byAsset: { BTC:5, ETH:5, SOL:5, XRP:5, PEPE:5 }}, // ~20% IM retail
      lighter:     { source: 'unk',  byAsset: {} },                  // no public leverage; flagged
      coinbase:    { source: 'doc',  byAsset: { BTC:10, ETH:10, SOL:10, XRP:10, PEPE:10 }}, // your 10x table
    },
  },

  endpoints: {
    kalshi:      { base: 'https://external-api.kalshi.com/trade-api/v2' },
    hyperliquid: { base: 'https://api.hyperliquid.xyz' },
    kraken:      { base: 'https://futures.kraken.com/derivatives/api/v3' },
    coinbase:    { base: 'https://api.coinbase.com' },
    okx:         { base: 'https://www.okx.com' },
    lighter:     { base: 'https://mainnet.zklighter.elliot.ai' },
  },
};
