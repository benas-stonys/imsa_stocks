const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

exports.handler = async function () {
  const { data: stocks, error } = await supabase.from('stocks').select('ticker');
  if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

  const apiKey = process.env.FINNHUB_API_KEY;
  let updated = 0;

  for (const s of stocks) {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${s.ticker}&token=${apiKey}`);
    const data = await res.json();
    if (!data || data.c === 0) continue;

    await supabase
      .from('stocks')
      .update({ current_price: data.c, prev_close: data.pc, last_updated: new Date().toISOString() })
      .eq('ticker', s.ticker)
      .eq('is_overridden', false); // don't overwrite an admin's manual override

    updated++;
  }

  return { statusCode: 200, body: JSON.stringify({ updated }) };
};
