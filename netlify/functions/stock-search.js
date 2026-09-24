const { createClient } = require('@supabase/supabase-js');
const { createDiscoveryHandler } = require('./lib/stock-discovery');
exports.handler = createDiscoveryHandler({ mode: 'search', getClient: () => createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }
) });
