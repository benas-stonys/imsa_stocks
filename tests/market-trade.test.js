const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { validateOrder, fetchMarketQuote, createHandler } = require('../netlify/functions/lib/market-trade');

const student = '00000000-0000-4000-8000-000000000001';
const order = () => ({ ticker: 'AAPL', action: 'buy', shares: 2, request_id: randomUUID() });

test('order validation rejects fractional, negative, oversized, and malformed orders', () => {
  for (const shares of [0, -1, 1.5, Infinity, '2', 2147483648]) assert.throws(() => validateOrder({ ...order(), shares }));
  assert.throws(() => validateOrder({ ...order(), action: 'short' }));
  assert.throws(() => validateOrder({ ...order(), request_id: 'invalid' }));
  assert.throws(() => validateOrder({ ...order(), ticker: '<script>' }));
  assert.equal(validateOrder(order()).shares, 2);
});

test('quotes require a successful fresh response and respect explicit classroom overrides', async () => {
  const now = Date.now();
  const quote = data => fetchMarketQuote({ ticker: 'AAPL' }, {
    now, env: { FINNHUB_API_KEY: 'test' }, fetchImpl: async () => ({ ok: true, json: async () => data }),
  });
  assert.equal((await quote({ c: 175.25, t: Math.floor(now / 1000) })).price, 175.25);
  for (const data of [{ c: 0, t: now / 1000 }, { c: 123 }, { c: '123', t: now / 1000 }, { c: 123, t: 1 }]) {
    await assert.rejects(quote(data));
  }
  await assert.rejects(fetchMarketQuote({ ticker: 'AAPL' }, { env: {} }));
  await assert.rejects(fetchMarketQuote({ ticker: 'AAPL' }, {
    env: { FINNHUB_KEY: 'test' }, fetchImpl: async () => ({ ok: false }),
  }));
  const overridden = await fetchMarketQuote({ ticker: 'AAPL', is_overridden: true, current_price: 50, last_updated: new Date().toISOString() }, {
    fetchImpl: () => { throw new Error('Must not fetch'); },
  });
  assert.equal(overridden.price, 50);
  assert.equal(overridden.source, 'classroom');
});

function apiFixture({ role = 'student', existing = null, rpcError = null, user = { id: student }, saved = { ticker: 'AAPL' }, resolveError = false, quoteError = false } = {}) {
  const calls = [];
  const registrations = [];
  const db = {
    auth: { getUser: async () => ({ data: { user } }) },
    from(table) {
      const query = { select: () => query, eq: () => query,
        single: async () => ({ data: table === 'profiles' ? { role } : { ticker: 'AAPL' } }),
        maybeSingle: async () => ({ data: table === 'transactions' ? existing : saved }),
        upsert: async (rows, options) => { registrations.push({ rows, options }); return {}; } };
      return query;
    },
    rpc: async (name, args) => { calls.push(args); return { data: { id: 'receipt', cash: 800 }, error: rpcError }; },
  };
  return { calls, registrations, handler: createHandler({ getClient: () => db,
    resolve: async ticker => { if (resolveError) throw new Error('Symbol not found'); return { ticker, name: 'NVIDIA CORP' }; },
    quote: async () => { if (quoteError) throw new Error('No usable quote'); return { price: 100, asOf: new Date().toISOString(), source: 'market' }; } }) };
}
const event = body => ({ httpMethod: 'POST', headers: { authorization: 'Bearer student-session' }, body: JSON.stringify(body) });

test('endpoint derives student and price from trusted sources, ignoring forged client values', async () => {
  const { handler, calls } = apiFixture();
  const response = await handler(event({ ...order(), student_id: 'somebody-else', price: 0.01 }));
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].p_student_id, student);
  assert.equal(calls[0].p_price, 100);
});

test('endpoint rejects anonymous/admin requests and returns useful balance failures', async () => {
  assert.equal((await apiFixture().handler({ ...event(order()), httpMethod: 'GET' })).statusCode, 405);
  assert.equal((await apiFixture().handler({ ...event(order()), headers: {} })).statusCode, 401);
  assert.equal((await apiFixture({ user: null }).handler(event(order()))).statusCode, 401);
  assert.equal((await apiFixture({ role: 'admin' }).handler(event(order()))).statusCode, 403);
  const response = await apiFixture({ rpcError: { code: 'P0001', message: 'Not enough cash' } }).handler(event(order()));
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /Not enough cash/);
});

test('endpoint replays completed tickets without another quote and marks ambiguous failures', async () => {
  const ticket = order();
  const { handler, calls } = apiFixture({ existing: { ...ticket, id: randomUUID(), price: 100, cash_after: 800 } });
  assert.equal((await handler(event(ticket))).statusCode, 200);
  assert.equal(calls.length, 0);
  assert.equal((await handler(event({ ...ticket, shares: 3 }))).statusCode, 409);
  const ambiguous = await apiFixture({ rpcError: { code: 'NETWORK' } }).handler(event(order()));
  assert.equal(JSON.parse(ambiguous.body).uncertain, true);
});

test('a provider-supported stock outside the starter list is registered and traded at the server quote', async () => {
  const { handler, calls, registrations } = apiFixture({ saved: null });
  const result = await handler(event({ ...order(), ticker: 'NVDA', price: 1, name: 'Forged name' }));
  assert.equal(result.statusCode, 200);
  assert.equal(registrations[0].rows[0].name, 'NVIDIA CORP');
  assert.equal(registrations[0].rows[0].ticker, 'NVDA');
  assert.equal(registrations[0].options.ignoreDuplicates, true);
  assert.equal(calls[0].p_ticker, 'NVDA');
  assert.equal(calls[0].p_price, 100);
});

test('unknown symbols and unavailable quotes never register a stock or execute an order', async () => {
  for (const options of [{ resolveError: true }, { quoteError: true }]) {
    const fixture = apiFixture({ saved: null, ...options });
    const result = await fixture.handler(event({ ...order(), ticker: 'UNKNOWN' }));
    assert.equal(result.statusCode, 503);
    assert.equal(JSON.parse(result.body).uncertain, false);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.registrations.length, 0);
  }
});

test('Postgres migration executes trades atomically with validation, replay, and access controls', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public to anon, authenticated, service_role;`);
  await db.exec(readFileSync('supabase-schema.sql', 'utf8'));
  await db.exec(`grant all on all tables in schema public to anon, authenticated, service_role;`);
  await db.exec(readFileSync('supabase/migrations/202609230001_market_trades.sql', 'utf8'));
  // Verify additive migration can be applied again without losing data.
  await db.exec(readFileSync('supabase/migrations/202609230001_market_trades.sql', 'utf8'));
  await db.query('insert into auth.users values ($1)', [student]);
  await db.query("insert into profiles(id,username,role) values ($1,'test-student','student')", [student]);
  await db.query("insert into portfolios(student_id,cash) values ($1,1000)", [student]);
  const trade = async ({ request = randomUUID(), action = 'buy', shares = 2, price = 100, ticker = 'AAPL' } = {}) => {
    const result = await db.query(`select public.execute_market_trade($1,$2,$3,$4,$5,$6,now(),'market') as receipt`,
      [student, request, ticker, action, shares, price]);
    return result.rows[0].receipt;
  };
  const balance = async () => (await db.query('select cash,holdings from portfolios where student_id=$1', [student])).rows[0];
  const request = randomUUID();
  const first = await trade({ request });
  assert.equal(Number(first.cash), 800);
  assert.deepEqual((await balance()).holdings, { AAPL: 2 });
  assert.deepEqual(await trade({ request, price: 200 }), first);
  await assert.rejects(trade({ request, shares: 3 }), /different order/);
  for (const args of [{ shares: 20 }, { shares: -1 }, { shares: 0 }, { action: 'sell', shares: 3 }, { price: 0 }, { price: 'NaN' }, { ticker: 'UNKNOWN' }]) {
    await assert.rejects(trade(args));
    assert.equal(Number((await balance()).cash), 800);
  }
  const sold = await trade({ action: 'sell', price: 125 });
  assert.equal(Number(sold.cash), 1050);
  assert.deepEqual((await balance()).holdings, {});
  // Force history insertion to fail after the UPDATE; the entire transaction must roll back.
  await db.exec(`create function public.fail_test_insert() returns trigger language plpgsql as $$ begin raise exception 'test history failure'; end $$;
    create trigger fail_test before insert on transactions for each row execute function public.fail_test_insert();`);
  await assert.rejects(trade(), /test history failure/);
  assert.equal(Number((await balance()).cash), 1050);
  assert.deepEqual((await balance()).holdings, {});
  await db.exec('drop trigger fail_test on transactions');
  await db.exec('set role authenticated');
  await assert.rejects(trade(), /permission denied/);
  await assert.rejects(db.exec('update portfolios set cash=999999'), /permission denied/);
  await assert.rejects(db.exec("insert into transactions(student_id,ticker,action,shares,price) values ('00000000-0000-4000-8000-000000000001','AAPL','buy',1,1)"), /permission denied/);
  await db.exec('reset role; set role service_role');
  assert.equal(Number((await trade({ price: 10 })).cash), 1030);
  await db.exec('reset role');
  assert.equal(Number((await db.query('select count(*) as count from transactions')).rows[0].count), 3);
});
