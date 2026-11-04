const DAYS = { '1d': 1, '7d': 7, '1mo': 30, '6mo': 180, '1y': 365, '5y': 1826 };
function classroomCandles(rows, range, interval, now = Date.now()) {
  const seconds = { '1d': 86400, '1wk': 604800, '1mo': 2592000 }[interval] || parseInt(interval, 10) * 60;
  const cutoff = now - DAYS[range] * 86400000;
  const buckets = new Map();
  // Only observed prices become candles; a one-point series remains a point, never fake history.
  for (const row of rows) {
    const time = Date.parse(row.recorded_at), price = Number(row.price);
    if (time < cutoff || time > now || !Number.isFinite(price) || price <= 0) continue;
    const t = Math.floor(time / 1000 / seconds) * seconds;
    const bucket = buckets.get(t);
    if (bucket) { bucket.h = Math.max(bucket.h, price); bucket.l = Math.min(bucket.l, price); bucket.c = price; }
    else buckets.set(t, { t, o: price, h: price, l: price, c: price, v: 0 });
  }
  const values = [...buckets.values()].sort((a,b) => a.t-b.t);
  return { ...Object.fromEntries(['t','o','h','l','c','v'].map(key => [key, values.map(row => row[key])])), range, interval, timezone: 'America/New_York', source: 'Classroom simulation — recorded prices', simulated: true };
}
module.exports = { classroomCandles, DAYS };
