const { createClient } = require('@supabase/supabase-js');
const { SYMBOL } = require('./lib/stock-catalog');

exports.handler = async event => {
  const reply = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  if (event.httpMethod !== 'GET') return reply(405, { error: 'Method not allowed.' });
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (!/^Bearer \S+$/i.test(auth)) return reply(401, { error: 'Please sign in to view research.' });
  const ticker = String(event.queryStringParameters?.ticker || '').trim().toUpperCase();
  if (!SYMBOL.test(ticker)) return reply(400, { error: 'Enter a valid ticker.' });
  const key = process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY;
  if (!key) return reply(503, { error: 'Market data is not configured.' });
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const user = await db.auth.getUser(auth.slice(7));
    if (user.error || !user.data?.user) return reply(401, { error: 'Your session expired. Please sign in again.' });
    const to = Math.floor(Date.now() / 1000);
    const from = to - 365 * 24 * 60 * 60;
    const base = 'https://finnhub.io/api/v1/';
    const urls = {
      quote: `${base}quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`,
      candles: `${base}stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(key)}`,
      metric: `${base}stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${encodeURIComponent(key)}`,
      profile: `${base}stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`,
    };
    const responses = await Promise.all(Object.values(urls).map(url => fetch(url, { signal: AbortSignal.timeout(12000) })));
    const [quote, candles, metric, profile] = await Promise.all(responses.map(response => response.ok ? response.json() : {}));
    if (!quote || !Number.isFinite(Number(quote.c)) || Number(quote.c) <= 0) return reply(404, { error: 'No quote is available for this symbol.' });
    const hasCandles = candles.s === 'ok' && Array.isArray(candles.t) && candles.t.length > 0;
    const fallbackTime = Number.isFinite(Number(quote.t)) ? Number(quote.t) : to;
    const chartCandles = hasCandles ? candles : { s: 'ok', fallback: true, t: [fallbackTime], o: [Number(quote.o) || Number(quote.c)], h: [Number(quote.h) || Number(quote.c)], l: [Number(quote.l) || Number(quote.c)], c: [Number(quote.c)], v: [Number(quote.v) || 0] };
    return reply(200, { ticker, quote, candles: chartCandles, metric: metric.metric || metric, profile });
  } catch (error) {
    return reply(503, { error: error.name === 'TimeoutError' ? 'Research data timed out. Please try again.' : 'Research data is temporarily unavailable.' });
  }
};
