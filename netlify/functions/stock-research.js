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
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const user = await db.auth.getUser(auth.slice(7));
    if (user.error || !user.data?.user) return reply(401, { error: 'Your session expired. Please sign in again.' });
    const saved = await db.from('stocks').select('*').eq('ticker', ticker).maybeSingle();
    if (saved.error) throw new Error('Stock lookup failed');
    const simulated = Boolean(saved.data?.is_overridden);
    if (!key && !simulated) return reply(503, { error: 'Market data is not configured.' });
    const base = 'https://finnhub.io/api/v1/';
    const urls = {
      quote: `${base}quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`,
      metric: `${base}stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${encodeURIComponent(key)}`,
      profile: `${base}stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`,
    };
    const [quote, metric, profile] = await Promise.all(Object.values(urls).map(async url => {
      if (!key) return {};
      try { const response = await fetch(url, { signal: AbortSignal.timeout(12000) }); return response.ok ? await response.json() : {}; }
      catch { return {}; }
    }));
    const executionQuote = simulated ? { c:Number(saved.data.current_price) } : quote;
    if (!executionQuote || !Number.isFinite(Number(executionQuote.c)) || Number(executionQuote.c) <= 0) return reply(404, { error: 'No quote is available for this symbol.' });
    return reply(200, { ticker, quote:executionQuote, metric: metric.metric || metric, profile: { name:saved.data?.name, ...profile }, simulated });
  } catch (error) {
    return reply(503, { error: error.name === 'TimeoutError' ? 'Research data timed out. Please try again.' : 'Research data is temporarily unavailable.' });
  }
};
