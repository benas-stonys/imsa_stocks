const { createClient } = require('@supabase/supabase-js');
const { SYMBOL } = require('./lib/stock-catalog');
const { history, validateRange, DEFAULTS } = require('./lib/history');
exports.handler = async event => {
  const reply = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  if (event.httpMethod !== 'GET') return reply(405, { error: 'Method not allowed.' });
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  if (!/^Bearer \S+$/i.test(auth)) return reply(401, { error: 'Please sign in.' });
  const { ticker = '', range = '1mo', interval = DEFAULTS[range] } = event.queryStringParameters || {};
  try { if (!SYMBOL.test(ticker)) throw new Error('Invalid ticker.'); validateRange(range, interval); }
  catch (error) { return reply(400, { error: error.message }); }
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const user = await db.auth.getUser(auth.slice(7));
    if (user.error || !user.data?.user) return reply(401, { error: 'Please sign in again.' });
    return reply(200, { ticker, candles: await history(ticker, range, interval) });
  } catch (error) { return reply(503, { error: 'Historical prices could not be loaded. Please retry or choose another interval.' }); }
};
