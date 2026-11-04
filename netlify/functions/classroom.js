const { createClient } = require('@supabase/supabase-js');
const { SYMBOL, resolveStock } = require('./lib/stock-catalog');
const { fetchMarketQuote } = require('./lib/market-trade');

function createClassroomHandler({ getClient, resolve = resolveStock, quote = fetchMarketQuote }) {
  return async event => {
    const reply = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' });
    const auth = event.headers?.authorization || event.headers?.Authorization || '';
    if (!/^Bearer \S+$/i.test(auth)) return reply(401, { error: 'Please sign in.' });
    let body;
    try {
      if ((event.body || '').length > 24000) throw new Error();
      body = JSON.parse(event.body || '{}');
      if (!body || Array.isArray(body) || typeof body.action !== 'string') throw new Error();
    } catch { return reply(400, { error: 'Invalid request.' }); }
    try {
      const db = getClient();
      const { data, error } = await db.auth.getUser(auth.slice(7));
      if (error || !data?.user) return reply(401, { error: 'Please sign in again.' });
      if (['watch.add', 'alert.add'].includes(body.action)) {
        const profile = await db.from('profiles').select('role').eq('id', data.user.id).single();
        if (profile.error || profile.data?.role !== 'student') return reply(403, { error: 'Student access required.' });
        const ticker = String(body.ticker || '').trim().toUpperCase();
        if (!SYMBOL.test(ticker)) return reply(400, { error: 'Enter a valid stock symbol.' });
        body.ticker = ticker;
        const saved = await db.from('stocks').select('*').eq('ticker', ticker).maybeSingle();
        if (saved.error) throw new Error();
        if (!saved.data) {
          let stock, market;
          try { stock = await resolve(ticker); market = await quote(stock); }
          catch { return reply(400, { error: 'Stock could not be verified. Check the symbol or retry shortly.' }); }
          const savedStock = await db.from('stocks').upsert({ ticker, name: stock.name, current_price: market.price, prev_close: market.prevClose || market.price, last_updated: market.asOf, is_overridden: false }, { onConflict: 'ticker', ignoreDuplicates: true });
          if (savedStock.error) throw new Error();
        }
      }
      const result = await db.rpc('classroom_action', { p_actor: data.user.id, p_action: body.action, p_body: body });
      if (result.error) {
        if (result.error.code === 'P0001') return reply(400, { error: result.error.message });
        if (result.error.code === '23505') return reply(409, { error: 'There is already an active scenario for this stock. Cancel it first.' });
        if (/^(22|23)/.test(result.error.code || '')) return reply(400, { error: 'Check the required fields, dates, prices, and text lengths.' });
        throw new Error();
      }
      return reply(200, result.data);
    } catch { return reply(503, { error: 'Classroom tools are unavailable. Please retry. If this persists, ask your teacher to check that the database update is installed.' }); }
  };
}
exports.createClassroomHandler = createClassroomHandler;
exports.handler = createClassroomHandler({ getClient: () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) });
