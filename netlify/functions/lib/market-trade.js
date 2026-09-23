const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateOrder(body) {
  if (!body || !['buy', 'sell'].includes(body.action) ||
      typeof body.ticker !== 'string' || !/^[A-Z0-9.^-]{1,20}$/.test(body.ticker) ||
      !Number.isSafeInteger(body.shares) || body.shares < 1 || body.shares > 2147483647 ||
      !UUID.test(body.request_id || '')) {
    throw new Error('Choose a stock, buy or sell, and a positive whole number of shares.');
  }
  return { ticker: body.ticker, action: body.action, shares: body.shares, request_id: body.request_id };
}

async function fetchMarketQuote(stock, { fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  // Teacher overrides remain intentional classroom prices.
  if (stock.is_overridden) {
    if (!Number.isFinite(Number(stock.current_price)) || Number(stock.current_price) <= 0) {
      throw new Error('The classroom price is unavailable. Ask your teacher to update it.');
    }
    return { price: Number(stock.current_price), asOf: stock.last_updated, source: 'classroom' };
  }
  const key = env.FINNHUB_API_KEY || env.FINNHUB_KEY;
  if (!key) throw new Error('Market quotes are not configured. Ask your teacher to contact the administrator.');
  const response = await fetchImpl(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(stock.ticker)}&token=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Market quote unavailable. Please try again shortly.');
  const data = await response.json();
  const timestamp = Number(data.t) * 1000;
  // The latest trade can be from the previous session on weekends/holidays.
  if (typeof data.c !== 'number' || !Number.isFinite(data.c) || data.c <= 0 ||
      !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 300000 ||
      now - timestamp > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('No usable market quote is available for this stock. No trade was placed.');
  }
  return { price: data.c, asOf: new Date(timestamp).toISOString(), source: 'market' };
}

function receipt(row) {
  return { id: row.id, ticker: row.ticker, action: row.action, shares: row.shares,
    price: Number(row.price), total: Number(row.total_amount),
    cash: Number(row.cash_after), timestamp: row.timestamp,
    quote_as_of: row.quote_as_of, price_source: row.price_source };
}

function createHandler({ getClient, quote = fetchMarketQuote }) {
  return async event => {
    const reply = (statusCode, body) => ({ statusCode,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' });
    let order;
    try { order = validateOrder(JSON.parse(event.body || '{}')); }
    catch (error) { return reply(400, { error: error.message }); }
    const authorization = event.headers?.authorization || event.headers?.Authorization || '';
    if (!/^Bearer \S+$/i.test(authorization)) return reply(401, { error: 'Please sign in to trade.' });
    try {
      const db = getClient();
      const { data: auth, error: authError } = await db.auth.getUser(authorization.slice(7));
      if (authError || !auth?.user) return reply(401, { error: 'Your session expired. Please sign in again.' });
      const studentId = auth.user.id;
      const { data: profile, error: profileError } = await db.from('profiles').select('role').eq('id', studentId).single();
      if (profileError || profile?.role !== 'student') return reply(403, { error: 'A student account is required to trade.' });
      const { data: existing, error: existingError } = await db.from('transactions').select('*')
        .eq('student_id', studentId).eq('request_id', order.request_id).maybeSingle();
      if (existingError) throw new Error('Trade service is unavailable. Please contact your teacher.');
      if (existing) {
        if (existing.ticker !== order.ticker || existing.action !== order.action || existing.shares !== order.shares) {
          return reply(409, { error: 'This ticket was already used for a different order.' });
        }
        return reply(200, { trade: receipt(existing) });
      }
      const { data: stock, error: stockError } = await db.from('stocks').select('*').eq('ticker', order.ticker).single();
      if (stockError || !stock) return reply(400, { error: 'This stock is not available for classroom trading.' });
      let market;
      try { market = await quote(stock); }
      catch (error) { return reply(503, { error: error.name === 'TimeoutError' ? 'Market quote timed out. Please try again.' : error.message }); }
      const { data, error } = await db.rpc('execute_market_trade', {
        p_student_id: studentId, p_request_id: order.request_id, p_ticker: order.ticker,
        p_action: order.action, p_shares: order.shares, p_price: market.price,
        p_quote_as_of: market.asOf, p_price_source: market.source,
      });
      if (error) {
        if (error.code === 'P0001') return reply(400, { error: error.message });
        // A transport failure can occur after commit. Preserve the ticket for an idempotent retry.
        return reply(503, { error: 'We could not confirm this order. Retry this same ticket to check its result.', uncertain: true });
      }
      return reply(200, { trade: data });
    } catch {
      return reply(503, { error: 'We could not confirm this order. Retry this same ticket to check its result.', uncertain: true });
    }
  };
}

module.exports = { validateOrder, fetchMarketQuote, receipt, createHandler };
