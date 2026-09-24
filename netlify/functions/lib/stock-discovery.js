const { SYMBOL, getCatalog, searchCatalog, resolveStock } = require('./stock-catalog');
const { fetchMarketQuote } = require('./market-trade');

function createDiscoveryHandler({ getClient, catalog = getCatalog, resolve = resolveStock, quote = fetchMarketQuote, mode }) {
  return async event => {
    const reply = (statusCode, data) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(data) });
    if (event.httpMethod !== 'GET') return reply(405, { error: 'Method not allowed.' });
    const auth = event.headers?.authorization || event.headers?.Authorization || '';
    if (!/^Bearer \S+$/i.test(auth)) return reply(401, { error: 'Please sign in to look up stocks.' });
    const query = String(event.queryStringParameters?.[mode === 'search' ? 'q' : 'ticker'] || '').trim();
    if (!query || query.length > 80 || (mode === 'quote' && !SYMBOL.test(query.toUpperCase()))) {
      return reply(400, { error: 'Enter a company name or valid ticker.' });
    }
    try {
      const db = getClient();
      const { data, error } = await db.auth.getUser(auth.slice(7));
      if (error || !data?.user) return reply(401, { error: 'Your session expired. Please sign in again.' });
      if (mode === 'search') return reply(200, { stocks: searchCatalog(await catalog(), query) });
      const ticker = query.toUpperCase();
      const { data: saved, error: savedError } = await db.from('stocks').select('*').eq('ticker', ticker).maybeSingle();
      if (savedError) throw new Error('Stock lookup is temporarily unavailable.');
      const stock = saved || await resolve(ticker);
      const market = await quote(stock);
      return reply(200, { stock: { ticker, name: stock.name, current_price: market.price,
        prev_close: market.prevClose || market.price, last_updated: market.asOf,
        is_overridden: market.source === 'classroom' } });
    } catch (error) {
      return reply(503, { error: error.name === 'TimeoutError' ? 'Market data timed out. Please try again.' : error.message });
    }
  };
}
module.exports = { createDiscoveryHandler };
