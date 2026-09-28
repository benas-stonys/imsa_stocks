const RANGES = { '1d': ['1m','5m','15m','30m','60m'], '7d': ['1m','5m','15m','30m','60m','1d'], '1mo': ['5m','15m','30m','60m','1d'], '6mo': ['1d','1wk'], '1y': ['1d','1wk'], '5y': ['1d','1wk','1mo'] };
const DEFAULTS = { '1d': '5m', '7d': '30m', '1mo': '1d', '6mo': '1d', '1y': '1d', '5y': '1wk' };
function validateRange(range, interval) {
  if (!Object.hasOwn(RANGES, range) || !RANGES[range].includes(interval)) throw new Error('Unsupported range and candle interval.');
}
function normalize(result) {
  const q = result?.indicators?.quote?.[0];
  const rows = (result?.timestamp || []).map((t, i) => [t, q?.open?.[i], q?.high?.[i], q?.low?.[i], q?.close?.[i], q?.volume?.[i]])
    .filter(row => row.slice(0,5).every(value => typeof value === 'number' && Number.isFinite(value)) && row[4] > 0);
  if (rows.length < 2) throw new Error('Historical prices are unavailable for this symbol and interval.');
  return Object.fromEntries(['t','o','h','l','c','v'].map((key,i) => [key, rows.map(row => row[i]) ]));
}
async function history(ticker, range, interval, fetchImpl = fetch) {
  validateRange(range, interval);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker.replace('.', '-'))}`);
  url.searchParams.set('range', range);
  url.searchParams.set('interval', interval);
  url.searchParams.set('includePrePost', 'false');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Historical price service is unavailable. Please retry shortly.');
  const json = await response.json();
  const result = json.chart?.result?.[0];
  return { ...normalize(result), s: 'ok', source: 'Yahoo Finance', range, interval, timezone: result.meta?.exchangeTimezoneName || 'America/New_York' };
}
module.exports = { history, normalize, validateRange, DEFAULTS };
