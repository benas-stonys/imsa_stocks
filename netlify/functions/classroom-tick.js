const { createClient } = require('@supabase/supabase-js');
const { fetchMarketQuote } = require('./lib/market-trade');

// Netlify scheduled function: keeps scenarios, alerts and snapshots running even if a market provider fails.
exports.handler = async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  let benchmark = null;
  try { benchmark = await fetchMarketQuote({ ticker: 'SPY', is_overridden: false }); } catch { /* Leave missing benchmark points as gaps. */ }
  const { error } = await db.rpc('refresh_learning_data', { p_benchmark: benchmark?.price ?? null, p_benchmark_as_of: benchmark?.asOf ?? null });
  if (error) throw new Error('Classroom hourly processing failed. Check the learning-features migration.');
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
