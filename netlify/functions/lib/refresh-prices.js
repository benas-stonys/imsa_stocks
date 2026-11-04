const { fetchMarketQuote } = require('./market-trade');
async function refreshPrices(db, { quote = fetchMarketQuote, now = Date.now, budgetMs = 18000 } = {}) {
  const { data: stocks, error, count } = await db.from('stocks').select('*', { count: 'exact' }).eq('is_overridden', false).order('price_checked_at', { nullsFirst: true }).order('ticker').limit(40);
  if (error) throw new Error('Could not load stocks.');
  const deadline = now() + budgetMs;
  let cursor = 0, updated = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(4, stocks.length) }, async () => {
    while (cursor < stocks.length && now() < deadline) {
      const stock = stocks[cursor++];
      try {
        const market = await quote(stock);
        const result = await db.from('stocks').update({ current_price: market.price, prev_close: market.prevClose, last_updated: market.asOf })
          .eq('ticker', stock.ticker).eq('is_overridden', false).lte('last_updated', market.asOf);
        if (result.error) throw new Error('Price update failed');
        updated++;
      } catch { failed++; }
      // Rotate through a large catalog even when markets are closed or a provider rejects a symbol.
      const checked = await db.from('stocks').update({ price_checked_at: new Date(now()).toISOString() }).eq('ticker', stock.ticker).eq('is_overridden', false);
      if (checked.error) throw new Error('Could not record price refresh progress.');
    }
  }));
  return { updated, failed, deferred: (count ?? stocks.length) - cursor };
}
module.exports = { refreshPrices };
