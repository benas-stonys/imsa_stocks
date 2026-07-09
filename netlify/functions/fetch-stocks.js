const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
const FINNHUB_KEY = process.env.FINNHUB_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

if (!ALPHA_VANTAGE_KEY && !FINNHUB_KEY) {
  throw new Error('Missing ALPHA_VANTAGE_KEY or FINNHUB_KEY environment variable.');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

exports.handler = async function () {
  const { data: stocks, error } = await supabase.from('stocks').select('*');
  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  const results = [];
  for (const stock of stocks) {
    if (stock.is_overridden) {
      results.push({ ticker: stock.ticker, skipped: true });
      continue;
    }

    try {
      const quote = await fetchQuote(stock.ticker);
      if (!quote) {
        results.push({ ticker: stock.ticker, error: 'No quote returned' });
        continue;
      }

      const { price, prevClose } = quote;
      await supabase.from('stocks').update({ current_price: price, prev_close: prevClose, last_updated: new Date().toISOString() }).eq('ticker', stock.ticker);
      results.push({ ticker: stock.ticker, price, prevClose });
    } catch (error) {
      results.push({ ticker: stock.ticker, error: error.message });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ results }) };
};

async function fetchQuote(ticker) {
  if (FINNHUB_KEY) {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.c || !data.pc) return null;
    return { price: Number(data.c), prevClose: Number(data.pc) };
  }

  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${ALPHA_VANTAGE_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  const quote = data['Global Quote'];
  if (!quote) return null;
  return {
    price: Number(quote['05. price']),
    prevClose: Number(quote['08. previous close']),
  };
}
