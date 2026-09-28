const { test } = require('node:test');
const assert = require('node:assert/strict');
const { history, normalize, validateRange } = require('../netlify/functions/lib/history');
test('history rejects unsupported combinations before calling provider', async () => {
  assert.throws(() => validateRange('5y', '1m'));
  await assert.rejects(history('AAPL','bad','1d', () => { throw new Error('must not fetch'); }), /Unsupported/);
});
test('missing candles never become fabricated zero-price candles', () => {
  assert.throws(() => normalize({timestamp:[1,2], indicators:{quote:[{open:[null,1],high:[null,2],low:[null,1],close:[null,2]}]}}), /unavailable/);
});
test('history preserves actual OHLC and requests chosen interval', async () => {
  const candles = await history('BRK.B','7d','1m', async url => {
    assert.equal(url.pathname, '/v8/finance/chart/BRK-B');
    assert.equal(url.searchParams.get('range'),'7d');
    assert.equal(url.searchParams.get('interval'),'1m');
    return { ok:true, json:async()=>({chart:{result:[{timestamp:[1,2],meta:{exchangeTimezoneName:'America/New_York'},indicators:{quote:[{open:[10,11],high:[12,13],low:[9,10],close:[11,12],volume:[100,200]}]}}]}}) };
  });
  assert.deepEqual(candles.c,[11,12]);
  assert.equal(candles.source,'Yahoo Finance');
});
test('rate limits fail explicitly rather than returning a quote fallback', async () => {
  await assert.rejects(history('AAPL','1mo','1d',async()=>({ok:false,status:429})),/unavailable/);
});
