const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalog, searchCatalog } = require('../netlify/functions/lib/stock-catalog');
const { createDiscoveryHandler } = require('../netlify/functions/lib/stock-discovery');

test('catalog supports company/ticker search, currency validation, punctuation, and bounded results', async () => {
  const rows = await loadCatalog({ env: { FINNHUB_API_KEY: 'test' }, fetchImpl: async () => ({ ok: true, json: async () => [
    { symbol: 'NVDA', description: 'NVIDIA CORP', currency: 'USD' },
    { symbol: 'BRK.B', description: 'BERKSHIRE HATHAWAY', currency: 'USD' },
    { symbol: 'FOREIGN', description: 'Foreign', currency: 'EUR' },
    { symbol: '<invalid>', currency: 'USD' },
  ] }) });
  assert.equal(rows.length, 2);
  assert.equal(searchCatalog(rows, 'nvidia')[0].ticker, 'NVDA');
  assert.equal(searchCatalog(rows, 'brk.b')[0].ticker, 'BRK.B');
  assert.equal(searchCatalog(rows, 'missing').length, 0);
  const many = Array.from({ length: 40 }, (_, i) => ({ ticker: 'A' + i, name: 'Company' }));
  assert.equal(searchCatalog(many, 'a').length, 25);
  assert.equal(searchCatalog(many, 'A1')[0].ticker, 'A1');
  await assert.rejects(loadCatalog({ env: { FINNHUB_KEY: 'test' }, fetchImpl: async () => ({ ok: false, status: 429 }) }), /busy/);
});

test('discovery authenticates before API calls and quotes unregistered stocks without database writes', async () => {
  let searches = 0;
  let quotes = 0;
  const db = { auth: { getUser: async () => ({ data: { user: { id: 'student' } } }) },
    from() { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null }) }; return q; } };
  const options = { getClient: () => db,
    catalog: async () => { searches++; return [{ ticker: 'NVDA', name: 'NVIDIA' }]; },
    resolve: async ticker => ({ ticker, name: 'NVIDIA' }),
    quote: async () => { quotes++; return { price: 150, asOf: new Date().toISOString(), source: 'market' }; } };
  const search = createDiscoveryHandler({ ...options, mode: 'search' });
  const quote = createDiscoveryHandler({ ...options, mode: 'quote' });
  const event = { httpMethod: 'GET', headers: { authorization: 'Bearer test' }, queryStringParameters: { q: 'nvidia', ticker: 'nvda' } };
  assert.equal((await search({ ...event, headers: {} })).statusCode, 401);
  assert.equal(searches, 0);
  assert.equal(JSON.parse((await search(event)).body).stocks[0].ticker, 'NVDA');
  const result = JSON.parse((await quote(event)).body).stock;
  assert.equal(result.ticker, 'NVDA');
  assert.equal(result.current_price, 150);
  assert.equal(quotes, 1);
  assert.equal((await quote({ ...event, queryStringParameters: { ticker: 'bad&token=foo' } })).statusCode, 400);
});
