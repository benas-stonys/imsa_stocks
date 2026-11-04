const { createClient } = require('@supabase/supabase-js');
const { refreshPrices } = require('./lib/refresh-prices');
exports.handler = async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const result = await refreshPrices(db);
  console.info('Scheduled stock refresh', result);
  return { statusCode: 200, body: JSON.stringify(result) };
};
