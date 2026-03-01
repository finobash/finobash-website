// ═══════════════════════════════════════════════════════════════════
// FINOBASH MARKET DATA PROXY SERVER
// Node.js + Express — fetches from NSE, BSE, Yahoo Finance
// Deploy on: Railway / Render / Fly.io (free tier)
// Run: node server.js  |  PORT defaults to 3001
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const https   = require('https');
const http    = require('http');
const app     = express();
const PORT    = process.env.PORT || 3001;

// ── CORS: allow your Netlify frontend ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'public, max-age=60'); // cache 60s
  next();
});

// ── Generic fetch helper ──
function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── NSE session cookie cache ──
let nseSession = { cookie: '', expiry: 0 };

async function getNseCookie() {
  if (Date.now() < nseSession.expiry) return nseSession.cookie;
  try {
    const body = await new Promise((resolve, reject) => {
      const req = https.get('https://www.nseindia.com/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      }, (res) => {
        const cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        nseSession.cookie  = cookie;
        nseSession.expiry  = Date.now() + 5 * 60 * 1000; // 5 min
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => resolve(cookie));
      });
      req.on('error', reject);
      req.setTimeout(6000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
    return nseSession.cookie;
  } catch(e) {
    return '';
  }
}

const NSE_HEADERS = async () => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
  'Cookie': await getNseCookie(),
  'X-Requested-With': 'XMLHttpRequest',
});

// ═══════════════════════════════
// ROUTE: /api/nse/indices
// Source: NSE India official API
// Returns: all NSE indices with LTP, change%
// ═══════════════════════════════
app.get('/api/nse/indices', async (req, res) => {
  try {
    const headers = await NSE_HEADERS();
    const raw = await fetchUrl('https://www.nseindia.com/api/allIndices', headers);
    const data = JSON.parse(raw);
    const indices = (data.data || []).map(idx => ({
      name:   idx.index,
      last:   idx.last,
      chg:    idx.variation,
      pchg:   idx.percentChange,
      open:   idx.open,
      high:   idx.high,
      low:    idx.low,
      prev:   idx.previousClose,
    }));
    res.json({ source: 'NSE India', time: new Date().toISOString(), data: indices });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ═══════════════════════════════
// ROUTE: /api/nse/gainers-losers
// Source: NSE India official API
// Returns: Nifty 50 top gainers & losers
// ═══════════════════════════════
app.get('/api/nse/gainers-losers', async (req, res) => {
  try {
    const headers = await NSE_HEADERS();
    const raw = await fetchUrl(
      'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050', headers
    );
    const data = JSON.parse(raw);
    const stocks = (data.data || [])
      .filter(s => s.symbol !== 'NIFTY 50')
      .map(s => ({
        symbol: s.symbol,
        ltp:    s.lastPrice,
        chg:    s.change,
        pchg:   s.pChange,
        open:   s.open,
        high:   s.dayHigh,
        low:    s.dayLow,
      }));
    const gainers = [...stocks].filter(s=>s.pchg>0).sort((a,b)=>b.pchg-a.pchg).slice(0,5);
    const losers  = [...stocks].filter(s=>s.pchg<0).sort((a,b)=>a.pchg-b.pchg).slice(0,5);
    const gCount  = stocks.filter(s=>s.pchg>0).length;
    const lCount  = stocks.filter(s=>s.pchg<0).length;
    res.json({ source: 'NSE India', time: new Date().toISOString(), gCount, lCount, gainers, losers });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ═══════════════════════════════
// ROUTE: /api/bse/sensex
// Source: BSE India official API
// Returns: Sensex + sectoral indices
// ═══════════════════════════════
app.get('/api/bse/sensex', async (req, res) => {
  try {
    // BSE market summary endpoint
    const raw = await fetchUrl(
      'https://api.bseindia.com/BseIndiaAPI/api/GetIndices/w?Grpcode=BI',
      {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.bseindia.com/',
        'Accept': 'application/json',
      }
    );
    const data = JSON.parse(raw);
    const indices = (data.Table || []).map(idx => ({
      name:  idx.INDX_NM,
      last:  parseFloat(idx.CurrVal),
      chg:   parseFloat(idx.PtsChng),
      pchg:  parseFloat(idx.PercChng),
      open:  parseFloat(idx.Open),
      high:  parseFloat(idx.High),
      low:   parseFloat(idx.Low),
      prev:  parseFloat(idx.PrevClose),
    }));
    res.json({ source: 'BSE India', time: new Date().toISOString(), data: indices });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ═══════════════════════════════
// ROUTE: /api/yahoo/:symbol
// Source: Yahoo Finance (global markets)
// Used for: Global indices, Commodities, Forex
// ═══════════════════════════════
app.get('/api/yahoo/:symbol', async (req, res) => {
  try {
    const sym = encodeURIComponent(req.params.symbol);
    const raw = await fetchUrl(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
      {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      }
    );
    const data = JSON.parse(raw);
    if (!data?.chart?.result?.[0]) return res.status(404).json({ error: 'No data' });
    const m = data.chart.result[0].meta;
    res.json({
      symbol: req.params.symbol,
      price:  m.regularMarketPrice,
      chg:    m.regularMarketChangePercent,
      prev:   m.chartPreviousClose,
      source: 'Yahoo Finance',
      time:   new Date().toISOString(),
    });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ═══════════════════════════════
// ROUTE: /api/all (mega endpoint)
// Returns everything in one call
// ═══════════════════════════════
const GLOBAL_SYMS = {
  // Global Indices
  'SP500':   '^GSPC',
  'NASDAQ':  '^IXIC',
  'DOW':     '^DJI',
  'FTSE':    '^FTSE',
  'NIKKEI':  '^N225',
  'HANGSENG':'^HSI',
  'DAX':     '^GDAXI',
  'CAC40':   '^FCHI',
  // MCX Commodities (same data Yahoo gets from CME/COMEX)
  'GOLD':    'GC=F',
  'SILVER':  'SI=F',
  'CRUDE':   'CL=F',
  'NATGAS':  'NG=F',
  'COPPER':  'HG=F',
  'PLATINUM':'PL=F',
  // Forex
  'USDINR':  'USDINR=X',
  'EURINR':  'EURINR=X',
  'GBPINR':  'GBPINR=X',
};

async function yahooFetch(symbol) {
  try {
    const raw = await fetchUrl(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    );
    const d = JSON.parse(raw);
    const m = d?.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice) return null;
    return { price: m.regularMarketPrice, chg: m.regularMarketChangePercent ?? 0 };
  } catch { return null; }
}

app.get('/api/all', async (req, res) => {
  const result = {};
  // Fetch all global symbols in parallel
  const entries = Object.entries(GLOBAL_SYMS);
  const fetches = await Promise.allSettled(entries.map(([key, sym]) =>
    yahooFetch(sym).then(d => [key, d])
  ));
  fetches.forEach(f => {
    if (f.status === 'fulfilled' && f.value[1]) {
      result[f.value[0]] = f.value[1];
    }
  });
  res.json({ source: 'Yahoo Finance (CME/COMEX/NYSE)', time: new Date().toISOString(), global: result });
});

app.get('/', (req, res) => res.json({
  service: 'Finobash Market Data Proxy',
  version: '1.0',
  endpoints: {
    nse_indices:      '/api/nse/indices',
    nse_nifty50:      '/api/nse/gainers-losers',
    bse_sensex:       '/api/bse/sensex',
    yahoo_symbol:     '/api/yahoo/:symbol  (e.g. /api/yahoo/^GSPC)',
    all_global:       '/api/all',
  },
  data_sources: {
    indian_indices:   'NSE India official API (nseindia.com)',
    sensex:           'BSE India official API (bseindia.com)',
    global_indices:   'Yahoo Finance (NYSE/NASDAQ official exchange data)',
    commodities:      'Yahoo Finance (CME/COMEX — same data as MCX reference)',
    forex:            'Yahoo Finance (RBI reference rates)',
  }
}));

app.listen(PORT, () => console.log(`Finobash server running on port ${PORT}`));
