const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');

test('portfolio repair initializes only untraded missing portfolios and can be rerun safely', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create schema auth; create table auth.users(id uuid primary key);');
  await db.exec(readFileSync('supabase-schema.sql', 'utf8'));
  const ids = ['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003'];
  for (const [index, id] of ids.entries()) {
    await db.query('insert into auth.users values ($1)', [id]);
    await db.query("insert into profiles(id,username,role,starting_cash) values ($1,$2,'student',12000)", [id, `student${index}`]);
  }
  await db.query("insert into portfolios(student_id,cash,holdings) values ($1,500,'{\"AAPL\":2}')", [ids[0]]);
  await db.query("insert into transactions(student_id,ticker,action,shares,price) values ($1,'AAPL','buy',2,100)", [ids[1]]);
  const sql = readFileSync('supabase/migrations/202609230002_initialize_untraded_portfolios.sql','utf8');
  await db.exec(sql);
  await db.exec(sql);
  const { rows } = await db.query('select student_id,cash,holdings from portfolios order by student_id');
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].cash), 500);
  assert.deepEqual(rows[0].holdings, { AAPL: 2 });
  assert.equal(rows[1].student_id, ids[2]);
  assert.equal(Number(rows[1].cash), 12000);
});

test('student provisioning tolerates an Auth-created profile and creates the funded portfolio', async () => {
  const writes = [];
  let created = 0;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'admin' } } }),
      admin: { createUser: async () => { created++; return { data: { user: { id: 'new-student' } } }; } } },
    from(table) {
      const query = {
        select: () => query, eq: () => query,
        then: resolve => Promise.resolve({ data: [{ id: 'admin' }] }).then(resolve),
        single: async () => ({ data: { id: 'admin', role: 'admin' } }),
        upsert: async (rows, options) => { writes.push({ table, rows, options }); return {}; },
        insert: async rows => {
          if (table === 'profiles') return { error: { message: 'duplicate profile' } };
          writes.push({ table, rows }); return {};
        },
      };
      return query;
    },
  };
  const exported = {};
  runInNewContext(readFileSync('netlify/functions/manage-user.js','utf8'), {
    require: () => ({ createClient: () => client }), exports: exported,
    process: { env: { SUPABASE_URL: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test' } },
  });
  const payload = { action: 'createStudent', email: 'student@example.invalid', password: 'synthetic-test-password', username: 'student', starting_cash: 25000 };
  const request = body => ({ httpMethod: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify(body) });
  assert.equal((await exported.handler(request(payload))).statusCode, 200);
  assert.equal(writes[0].options.onConflict, 'id');
  assert.equal(writes[0].rows[0].id, 'new-student');
  assert.equal(writes[1].table, 'portfolios');
  assert.equal(writes[1].rows[0].cash, 25000);
  for (const starting_cash of [-10, 'invalid', 0]) {
    assert.equal((await exported.handler(request({ ...payload, starting_cash }))).statusCode, 400);
  }
  assert.equal(created, 1);
});
