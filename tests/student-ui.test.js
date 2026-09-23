const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');

const source = readFileSync('app.js', 'utf8').replace(/^import .*;\r?\n/gm, '')
  .replace("const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);", 'const supabase = window.testDatabase; const API_BASE = "/.netlify/functions";')
  .replace("window.addEventListener('DOMContentLoaded', start);", '');

function setup() {
  const dom = new JSDOM('<div id="app"><div id="dashboard-body"></div></div>', { url: 'https://test.invalid', runScripts: 'outside-only' });
  const win = dom.window;
  win.testDatabase = { auth: { getSession: async () => ({ data: { session: { access_token: 'test' } } }) } };
  win.eval(source + `
    dashboardState = {
      profile: { id: 'student', role: 'student', starting_cash: 1000 },
      stocks: [{ ticker: 'AAPL', name: 'Apple', current_price: 100, last_updated: '2026-09-23T15:00:00Z' }],
      portfolio: { cash: 1000, holdings: { AAPL: 3 } }, leaderboard: [], history: { rows: [] }
    };
    window.runTrade = handleTrade;
    window.renderTabs = renderStudentTabs;
    window.markMissing = () => { dashboardState.portfolio.missing = true; renderStudentTabs(); };
    window.prepareSuccess = () => {
      loadStocks = async () => dashboardState.stocks;
      loadStudentPortfolio = async () => ({ cash: 900, holdings: { AAPL: 4 } });
      loadTradeHistory = async () => ({ rows: [{ ticker: 'AAPL', shares: 1, action: 'buy', price: 100, total_amount: 100, timestamp: '2026-09-23T15:00:00Z' }] });
      loadLeaderboard = async () => [];
    };
    renderStudentTabs();
  `);
  return { dom, win, doc: win.document };
}

test('student navigation separates ticket, research and accounts, with accurate order estimates', () => {
  const { dom, win, doc } = setup();
  assert.match(doc.body.textContent, /Trade ticket/);
  doc.getElementById('trade-shares').value = '2';
  doc.getElementById('trade-shares').dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.match(doc.getElementById('trade-estimate').textContent, /\$200\.00/);
  assert.match(doc.getElementById('trade-estimate').textContent, /\$800\.00/);
  doc.getElementById('trade-action').value = 'sell';
  doc.getElementById('trade-shares').value = '4';
  doc.getElementById('trade-shares').dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(doc.getElementById('trade-submit').disabled, true);
  doc.querySelector('[data-tab="research"]').click();
  assert.match(doc.body.textContent, /Research/);
  assert.ok(doc.querySelector('button[data-ticker="AAPL"]'));
  doc.querySelector('[data-tab="accounts"]').click();
  assert.match(doc.body.textContent, /Trade history/);
  assert.match(doc.body.textContent, /\$1,300\.00/);
  dom.window.close();
});

test('missing portfolio and invalid shares prevent submission', () => {
  const { dom, win, doc } = setup();
  doc.getElementById('trade-shares').value = '1.5';
  doc.getElementById('trade-shares').dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(doc.getElementById('trade-submit').disabled, true);
  win.markMissing();
  assert.equal(doc.getElementById('trade-submit').disabled, true);
  assert.match(doc.body.textContent, /No portfolio found/);
  dom.window.close();
});

test('lost responses retain the same ticket and block duplicate simultaneous submissions', async () => {
  const { dom, win, doc } = setup();
  const sent = [];
  let release;
  win.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    await new Promise(resolve => { release = resolve; });
    throw new Error('Connection lost');
  };
  const first = win.runTrade();
  await new Promise(resolve => setImmediate(resolve));
  await win.runTrade();
  assert.equal(sent.length, 1);
  assert.equal(doc.getElementById('trade-submit').disabled, true);
  release();
  await first;
  assert.equal(doc.getElementById('trade-submit').textContent, 'Retry this ticket');
  assert.equal(doc.getElementById('trade-shares').disabled, true);
  win.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: false, status: 400, json: async () => ({ error: 'Not enough cash' }) };
  };
  await win.runTrade();
  assert.equal(sent[0].request_id, sent[1].request_id);
  assert.equal(win.sessionStorage.getItem('trade-ticket:student'), null);
  assert.equal(doc.getElementById('trade-shares').disabled, false);
  assert.match(doc.body.textContent, /Not enough cash/);
  dom.window.close();
});

test('successful orders show a receipt and refresh Accounts holdings and history', async () => {
  const { dom, win, doc } = setup();
  win.prepareSuccess();
  win.fetch = async () => ({ ok: true, json: async () => ({ trade: {
    id: 'test-receipt', ticker: 'AAPL', action: 'buy', shares: 1, price: 100, total: 100, cash: 900,
  } }) });
  await win.runTrade();
  assert.match(doc.getElementById('trade-message').textContent, /Bought 1 AAPL/);
  assert.match(doc.getElementById('trade-message').textContent, /\$900\.00/);
  assert.equal(win.sessionStorage.getItem('trade-ticket:student'), null);
  doc.querySelector('[data-tab="accounts"]').click();
  assert.match(doc.body.textContent, /Trade history/);
  assert.match(doc.body.textContent, /\$900\.00/);
  assert.match(doc.body.textContent, /\$400\.00/);
  assert.match(doc.body.textContent, /Buy/);
  dom.window.close();
});
