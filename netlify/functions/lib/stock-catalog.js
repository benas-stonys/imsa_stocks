const SYMBOL = /^[A-Z0-9.^-]{1,20}$/;
let catalogCache;
let catalogLoading;

async function loadCatalog({ fetchImpl = fetch, env = process.env } = {}) {
  const key = env.FINNHUB_API_KEY || env.FINNHUB_KEY;
  if (!key) throw new Error('Market data is not configured. Contact your teacher.');
  const response = await fetchImpl(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'Market data is busy. Please try again shortly.' : 'Stock search is temporarily unavailable.');
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Stock search is temporarily unavailable.');
  return rows.filter(row => SYMBOL.test(row.symbol) && row.currency === 'USD')
    .map(row => ({ ticker: row.symbol, name: row.description || row.symbol, type: row.type || 'Stock' }));
}

async function getCatalog() {
  if (catalogCache && Date.now() < catalogCache.expires) return catalogCache.rows;
  if (!catalogLoading) {
    catalogLoading = loadCatalog().then(rows => {
      catalogCache = { rows, expires: Date.now() + 60 * 60 * 1000 };
      return rows;
    }).finally(() => { catalogLoading = null; });
  }
  return catalogLoading;
}

function searchCatalog(rows, query) {
  const text = query.trim().toUpperCase();
  const rank = row => row.ticker === text ? 0 : row.ticker.startsWith(text) ? 1 : 2;
  return rows.filter(row => row.ticker.includes(text) || row.name.toUpperCase().includes(text))
    .sort((a, b) => rank(a) - rank(b) || a.ticker.length - b.ticker.length || a.ticker.localeCompare(b.ticker)).slice(0, 25);
}

async function resolveStock(ticker) {
  const stock = (await getCatalog()).find(row => row.ticker === ticker);
  if (!stock) throw new Error('Symbol not found among supported U.S. dollar stocks. Search by company name or ticker.');
  return stock;
}
module.exports = { SYMBOL, loadCatalog, getCatalog, searchCatalog, resolveStock };
