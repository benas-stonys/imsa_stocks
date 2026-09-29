import { SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE } from './config.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById('app');

let dashboardState = { profile: null, stocks: [], leaderboard: [], portfolio: null };
let activeStudentTab = 'trade';
let tradeBusy = false;
let tradeNotice = null;
let pendingOrder = null;
let selectedTicker = '';
let searchGeneration = 0;
let quoteBusy = false;
let researchRequest = 0;

const resourceLinks = [
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com' },
  { name: 'MarketWatch', url: 'https://www.marketwatch.com' },
  // add your own favorites here
];

window.addEventListener('DOMContentLoaded', start);

async function start() {
  renderLoading('Checking session...');
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;

  if (!session) {
    return renderAuth();
  }

  const profile = await loadProfile(session.user.id);
  if (!profile) {
    return renderAuth('No profile found. Please ask an admin to create your account.');
  }

  renderDashboard(profile, session.user);
}

function renderLoading(message) {
  app.innerHTML = `<div class="card"><p>${message}</p></div>`;
}

async function renderAuth(message = '') {
  const { data: adminCount } = await supabase.from('profiles').select('id', { count: 'exact' }).eq('role', 'admin');
  const needAdmin = adminCount?.count === 0;

  app.innerHTML = `
    <div class="card">
      <h1>Classroom Trading Simulator</h1>
      <p>Sign in with your classroom account.</p>
      ${message ? `<div class="message error">${message}</div>` : ''}
      <form id="login-form">
        <label>Email</label>
        <input name="email" type="email" required />
        <label>Password</label>
        <input name="password" type="password" required />
        <button type="submit">Sign in</button>
      </form>
    </div>
    ${needAdmin ? adminSetupCard() : ''}
  `;

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const email = form.get('email');
    const password = form.get('password');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return renderAuth(error.message);
    }
    start();
  });

  if (needAdmin) {
    document.getElementById('admin-setup-form').addEventListener('submit', handleAdminSetup);
  }
}

function adminSetupCard() {
  return `
    <div class="card">
      <h2>First-Run Admin Setup</h2>
      <p>Create the teacher account for the first time.</p>
      <form id="admin-setup-form">
        <label>Display name</label>
        <input name="username" type="text" required />
        <label>Email</label>
        <input name="email" type="email" required />
        <label>Password</label>
        <input name="password" type="password" required />
        <button type="submit">Create admin account</button>
      </form>
    </div>
  `;
}

async function handleAdminSetup(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = {
    action: 'createAdmin',
    username: form.get('username'),
    email: form.get('email'),
    password: form.get('password'),
  };

  const result = await callManageUserApi(payload);
  if (result.error) {
    return renderAuth(result.error);
  }

  renderAuth('Admin account created. Please sign in.');
}

async function loadProfile(userId) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
  return data;
}

async function renderDashboard(profile, user) {
  const stocks = await loadStocks();
  const leaderboard = await loadLeaderboard(stocks);
  const studentPortfolio = profile.role === 'student' ? await loadStudentPortfolio(profile.id) : null;

  const history = profile.role === 'student' ? await loadTradeHistory(profile.id) : { rows: [] };
  dashboardState = { profile, stocks, leaderboard, portfolio: studentPortfolio, history };
  if (profile.role === 'student') {
    try { pendingOrder = JSON.parse(sessionStorage.getItem(`trade-ticket:${profile.id}`) || 'null'); }
    catch { pendingOrder = null; }
  }

  app.innerHTML = `
    <div class="card profile-banner">
      <div class="grid grid-2">
        <div>
          <div class="profile-identity"><span class="avatar">${escapeHtml(profile.username.slice(0,2).toUpperCase())}</span><div><p class="banner-kicker">IMSA • CLASSROOM INVESTING</p><h1>${escapeHtml(profile.username)}</h1></div></div>
          <span class="role-badge">${profile.role === "admin" ? "Administrator" : "Student investor"}</span>
        </div>
        <div style="text-align:right; align-self:center;">
          <button id="logout-button" class="secondary">Log out</button>
        </div>
      </div>
    </div>
    <div id="dashboard-body"></div>
  `;

  document.getElementById('logout-button').addEventListener('click', async () => {
    if (tradeBusy) return;
    pendingOrder = null;
    tradeNotice = null;
    await supabase.auth.signOut();
    renderAuth();
  });

  if (profile.role === 'admin') {
    document.getElementById('dashboard-body').innerHTML = renderAdminPanel(profile, stocks, leaderboard);
    attachAdminListeners();
    attachAuditLog();
  } else {
    renderStudentTabs();
  }
}

function renderStudentTabs() {
  searchGeneration++;
  quoteBusy = false;
  const body = document.getElementById('dashboard-body');
  const { profile, stocks, leaderboard, portfolio } = dashboardState;

  body.innerHTML = `
    <nav class="tabs" aria-label="Student navigation">
      ${['trade', 'research', 'accounts'].map(name => `<button class="tab-btn ${activeStudentTab === name ? 'active' : ''}" data-tab="${name}" ${activeStudentTab === name ? 'aria-current="page"' : ''}>${name[0].toUpperCase() + name.slice(1)}</button>`).join('')}
    </nav>
    <div id="tab-content"></div>
  `;

  body.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (tradeBusy) return;
      activeStudentTab = btn.dataset.tab;
      renderStudentTabs();
    });
  });

  const content = document.getElementById('tab-content');
  if (activeStudentTab === 'trade') {
    content.innerHTML = renderTradeTab(stocks, portfolio);
    if (selectedTicker && stocks.some(stock => stock.ticker === selectedTicker)) document.getElementById('trade-ticker').value = selectedTicker;
    const form = document.getElementById('trade-form');
    if (pendingOrder) {
      document.getElementById('trade-action').value = pendingOrder.action;
      document.getElementById('trade-ticker').value = pendingOrder.ticker;
      document.getElementById('trade-shares').value = pendingOrder.shares;
      setTicketLocked(true);
    }
    form.addEventListener('input', updateTradeEstimate);
    attachStockSearch();
    loadResearchPanel(selectedTicker || stocks[0]?.ticker);
    updateTradeEstimate();
    document.getElementById('trade-form').addEventListener('submit', async event => {
      event.preventDefault();
      await handleTrade();
    });
  } else if (activeStudentTab === 'accounts') {
    content.innerHTML = renderPositionsTab(profile, portfolio, stocks, leaderboard);
  } else {
    content.innerHTML = `<section class="card"><h2>Find a stock</h2>${renderStockSearch()}</section><section id="research-panel"></section>` + renderMarketTable(stocks) + renderResourcesTab();
    attachStockSearch();
    loadResearchPanel(selectedTicker || stocks[0]?.ticker);
    attachTickerClicks();
  }
}

function renderTradeTab(stocks, portfolio) {
  return `
    <div class="grid grid-2 trade-layout">
    <section class="card">
      <p class="eyebrow">CLASSROOM TRADING</p>
      <h2>Trade ticket</h2>
      <p class="small-text">Buy or sell whole shares with your classroom cash.</p>
      <div id="trade-message" role="status" aria-live="polite">${tradeNotice ? `<div class="message ${tradeNotice.error ? 'error' : 'success'}">${escapeHtml(tradeNotice.text)}</div>` : ''}</div>
      ${portfolio.missing ? '<div class="message error">No portfolio found. Contact your teacher.</div>' : ''}
      ${renderStockSearch()}
      <form id="trade-form">
        <label for="trade-action">Action</label>
        <select id="trade-action" required>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <label>Stock</label>
        <div id="selected-stock" class="selected-stock"><strong>${escapeHtml(selectedTicker || stocks[0]?.ticker || '')}</strong><span>Use Find a stock above to change it.</span></div>
        <input id="trade-ticker" type="hidden" value="${escapeHtml(selectedTicker || stocks[0]?.ticker || '')}" />
        <label for="trade-shares">Number of shares</label>
        <input id="trade-shares" type="number" min="1" max="2147483647" step="1" value="1" required />
        <p class="small-text">Order type: <strong>Market</strong></p>
        <p class="small-text">A new quote is requested when you submit. Your final price may differ from this estimate. Outside market hours, orders use the latest available market quote. Teacher price overrides take precedence.</p>
        <button id="trade-submit" type="submit">Place market order</button>
      </form>
    </section>
    <div class="trade-side">
      <aside class="card order-summary">
        <h2>Order preview</h2>
        <p class="small-text">Available cash</p>
        <p class="cash-amount">${formatCurrency(portfolio.cash)}</p>
        <div id="trade-estimate" aria-live="polite"></div>
      </aside>
      <div id="research-panel"></div>
    </div>
    </div>
  `;
}

function renderMarketTable(stocks) {
  return `<div class="card"><h2>Followed stocks</h2><p class="small-text">Stocks already used in the app. Search above to find more. Select a symbol to view its saved price history.</p>
      <div class="table-scroll">
      <table class="table">
        <thead><tr><th>Symbol</th><th>Name</th><th>Latest saved price</th></tr></thead>
        <tbody>
          ${stocks.map(s => `<tr><td><button class="ticker-link clickable-ticker" data-ticker="${escapeHtml(s.ticker)}">${escapeHtml(s.ticker)}</button></td><td>${escapeHtml(s.name)}</td><td>${formatCurrency(s.current_price)}${s.is_overridden ? ' <span class="small-text">Classroom price</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="3">No stocks available yet.</td></tr>'}
        </tbody>
      </table>
      </div></div>
  `;
}

function renderPositionsTab(profile, portfolio, stocks, leaderboard) {
  const totalValue = calculatePortfolioValue(portfolio, stocks);
  return `
    <div class="card">
      <h2>Accounts</h2>
      ${portfolio.missing ? '<div class="message error">No portfolio found for your account. Contact your admin.</div>' : ''}
      <p>Cash: <strong>${formatCurrency(portfolio.cash)}</strong></p>
      <p>Total value: <strong>${formatCurrency(totalValue)}</strong></p>
      <p class="small-text">Starting cash: ${formatCurrency(profile.starting_cash)}</p>
      ${renderHoldingsTable(portfolio.holdings, stocks)}
    </div>
    <div class="card">
      <h2>Trade history</h2>
      ${renderTradeHistory(dashboardState.history)}
    </div>
    <div class="card">
      <h2>Leaderboard</h2>
      ${renderLeaderboard(leaderboard)}
    </div>
  `;
}

function renderResourcesTab() {
  return `
    <div class="card">
      <h2>Stock resources</h2>
      <ul>
        ${resourceLinks.map(link => `<li><a href="${link.url}" target="_blank" rel="noopener">${link.name}</a></li>`).join('')}
      </ul>
    </div>
  `;
}

function attachTickerClicks() {
  document.querySelectorAll('.clickable-ticker').forEach(el => {
    el.addEventListener('click', () => openStockModal(el.dataset.ticker));
  });
}

function attachAdminListeners() {
  document.getElementById('student-form').addEventListener('submit', async event => {
    event.preventDefault();
    await handleCreateStudent();
  });
  document.getElementById('ticker-form').addEventListener('submit', async event => {
    event.preventDefault();
    await handleAddTicker();
  });
  document.getElementById('price-override-form').addEventListener('submit', async event => {
    event.preventDefault();
    await handleOverridePrice();
  });
  document.getElementById('refresh-prices').addEventListener('click', async () => {
    await handleRefreshPrices();
  });
  document.querySelectorAll('.reset-portfolio').forEach(button => {
    button.addEventListener('click', async event => {
      await handleResetPortfolio(event.target.dataset.studentId);
    });
  });
}

function renderAdminPanel(profile, stocks, leaderboard) {
  return `
    <nav class="tabs admin-nav" aria-label="Administration"><a href="#audit-log">Audit logs</a><a href="#student-form">Add student</a><a href="#price-override-form">Manage stocks</a></nav>
    <section id="audit-log" class="card"><p class="eyebrow">CLASSROOM ACTIVITY</p><h2>Student audit logs</h2><p class="small-text">Completed buys and sells are recorded automatically for every student. New students appear in the filter as soon as their account is created.</p><div class="audit-controls"><label for="audit-student">Student</label><select id="audit-student"><option value="">All students</option></select><button type="button" id="audit-refresh" class="secondary">Refresh</button></div><div id="audit-results" aria-live="polite">Loading transactions…</div><div class="audit-pagination"><button id="audit-prev" class="secondary" disabled>Previous</button><span id="audit-page"></span><button id="audit-next" class="secondary" disabled>Next</button></div></section>
    <div class="grid grid-2">
      <div class="card">
        <h2>Admin dashboard</h2>
        <p>Manage students, tickers, and price overrides.</p>
        <button id="refresh-prices" class="secondary">Refresh live prices</button>
      </div>
      <div class="card">
        <h2>Leaderboard</h2>
        ${renderLeaderboard(leaderboard)}
      </div>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h3>Add a new student</h3>
        <form id="student-form">
          <label>Display name</label>
          <input name="username" type="text" required />
          <label>Email</label>
          <input name="email" type="email" required />
          <label>Password</label>
          <input name="password" type="password" required />
          <label>Starting cash</label>
          <input name="starting_cash" type="number" value="10000" min="1000" required />
          <button type="submit">Create student</button>
        </form>
      </div>
      <div class="card">
        <h3>Add a new ticker</h3>
        <form id="ticker-form">
          <label>Ticker symbol</label>
          <input name="ticker" type="text" required />
          <label>Name</label>
          <input name="name" type="text" required />
          <label>Starting price</label>
          <input name="price" type="number" step="0.01" min="0.01" required />
          <button type="submit">Add ticker</button>
        </form>
      </div>
    </div>
    <div class="card">
      <h3>Override stock price</h3>
      <form id="price-override-form">
        <label>Symbol</label>
        <input name="ticker" type="text" placeholder="e.g. NVDA" maxlength="20" list="override-symbols" required /><datalist id="override-symbols">${stocks.map(stock => `<option value="${escapeHtml(stock.ticker)}">${escapeHtml(stock.name)}</option>`).join('')}</datalist><p class="small-text">Enter any supported U.S. stock ticker, including stocks not yet used in class. The override stays fixed until you change it.</p>
        <label>Override price</label>
        <input name="price" type="number" step="0.01" min="0.01" required />
        <button type="submit">Set override</button>
      </form>
    </div>
    <div class="card">
      <h3>Students and portfolios</h3>
      ${renderStudentList(leaderboard)}
    </div>
  `;
}

function renderHoldingsTable(holdings = {}, stocks) {
  const rows = Object.keys(holdings).map(ticker => {
    const stock = stocks.find(item => item.ticker === ticker);
    const shares = holdings[ticker];
    const price = stock?.current_price || 0;
    return `
      <tr>
        <td>${ticker}</td>
        <td>${shares}</td>
        <td>${formatCurrency(price)}</td>
        <td>${formatCurrency(price * shares)}</td>
      </tr>
    `;
  });

  return rows.length
    ? `<table class="table"><thead><tr><th>Symbol</th><th>Shares</th><th>Price</th><th>Value</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<p>No holdings yet.</p>';
}

function renderLeaderboard(rows) {
  return `
    <table class="table">
      <thead><tr><th>Student</th><th>Value</th><th>Gain</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${row.username}</td><td>${formatCurrency(row.value)}</td><td>${row.gainLabel}</td></tr>`).join('')}</tbody>
    </table>
  `;
}

function renderStudentList(rows) {
  return `
    <table class="table">
      <thead><tr><th>Student</th><th>Value</th><th>Starting cash</th><th>Reset</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${row.username}</td><td>${formatCurrency(row.value)}</td><td>${formatCurrency(row.starting_cash)}</td><td><button data-student-id="${row.id}" class="secondary reset-portfolio">Reset</button></td></tr>`).join('')}</tbody>
    </table>
  `;
}

async function loadStocks() {
  const { data } = await supabase.from('stocks').select('*').order('ticker');
  return data || [];
}

async function loadStudentPortfolio(studentId) {
  const { data } = await supabase.from('portfolios').select('*').eq('student_id', studentId).single();
  if (!data) {
    return { cash: 0, holdings: {}, missing: true };
  }
  return { cash: Number(data.cash), holdings: data.holdings || {} };
}

function calculatePortfolioValue(portfolio, stocks) {
  const holdingsValue = Object.entries(portfolio.holdings || {}).reduce((total, [ticker, shares]) => {
    const stock = stocks.find(item => item.ticker === ticker);
    return total + (stock?.current_price || 0) * shares;
  }, 0);
  return portfolio.cash + holdingsValue;
}

async function loadLeaderboard(stocks) {
  const { data: portfolios } = await supabase.from('profiles').select('id, username, starting_cash').eq('role', 'student');
  if (!portfolios) return [];

  const leaderRows = await Promise.all(portfolios.map(async profile => {
    const portfolio = await loadStudentPortfolio(profile.id);
    const value = calculatePortfolioValue(portfolio, stocks);
    const gain = value - Number(profile.starting_cash);
    return {
      id: profile.id,
      username: profile.username,
      starting_cash: Number(profile.starting_cash),
      value,
      gain,
      gainLabel: `${gain >= 0 ? '+' : ''}${((gain / profile.starting_cash) * 100).toFixed(1)}%`,
    };
  }));

  return leaderRows.sort((a, b) => b.value - a.value);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable';
}

async function loadTradeHistory(studentId) {
  const { data, error } = await supabase.from('transactions').select('*').eq('student_id', studentId)
    .order('timestamp', { ascending: false }).limit(50);
  return { rows: data || [], error: Boolean(error) };
}

function renderTradeHistory(history) {
  if (history.error) return '<p class="message error">Trade history could not be loaded. Refresh to try again.</p>';
  if (!history.rows.length) return '<p>No trades yet. Your completed orders will appear here.</p>';
  return `<p class="small-text">Your 50 most recent trades</p><div class="table-scroll"><table class="table">
    <thead><tr><th>Date</th><th>Action</th><th>Stock</th><th>Shares</th><th>Fill price</th><th>Total</th></tr></thead>
    <tbody>${history.rows.map(row => `<tr><td>${formatDate(row.timestamp)}</td><td>${row.action === 'buy' ? 'Buy' : 'Sell'}</td>
    <td>${escapeHtml(row.ticker)}</td><td>${Number(row.shares)}</td><td>${formatPrice(row.price)}</td><td>${formatCurrency(row.total_amount ?? row.price * row.shares)}</td></tr>`).join('')}</tbody></table></div>`;
}

function formatPrice(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
}

function setTicketLocked(locked) {
  ['trade-action', 'trade-ticker', 'trade-shares'].forEach(id => { document.getElementById(id).disabled = locked; });
  document.querySelectorAll('#stock-search-form input, #stock-search-form button, #stock-search-results button').forEach(el => { el.disabled = locked; });
}

function renderResearchPanel() {
  return `<div class="card research-panel"><div class="research-heading"><div><p class="eyebrow">MARKET RESEARCH</p><h2 id="research-title">Research</h2></div><span id="research-status" class="small-text">Loading…</span></div>
    <div class="chart-tabs"><button type="button" class="chart-tab active" data-chart="candles">Candles</button><button type="button" class="chart-tab" data-chart="mountain">Mountain</button></div>
    <div class="chart-ranges" role="group" aria-label="Chart time range"><button type="button" data-range="1d" class="chart-tab">1 day</button><button type="button" data-range="7d" class="chart-tab">7 days</button><button type="button" data-range="1mo" class="chart-tab active">1 month</button><button type="button" data-range="6mo" class="chart-tab">6 months</button><button type="button" data-range="1y" class="chart-tab">1 year</button><button type="button" data-range="5y" class="chart-tab">5 years</button></div><details class="chart-options"><summary>Chart options</summary><label for="candle-interval">Candle interval</label><select id="candle-interval"></select><p class="small-text">Minute candles are available for recent ranges. Longer ranges use daily, weekly or monthly candles.</p></details><p id="chart-message" class="small-text" role="status"></p><div class="chart-wrap"><canvas id="research-chart" height="260"></canvas></div><div id="research-stats" class="stats-grid"></div></div>`;
}

async function loadResearchPanel(ticker) {
  const target = document.getElementById('research-panel');
  if (!target || !ticker) return;
  target.innerHTML = renderResearchPanel();
  const generation = ++researchRequest;
  let mode = 'candles', range = '1mo', request = 0, chartData;
  const intervals = { '1d': ['1m','5m','15m','30m','60m'], '7d': ['1m','5m','15m','30m','60m','1d'], '1mo': ['5m','15m','30m','60m','1d'], '6mo': ['1d','1wk'], '1y': ['1d','1wk'], '5y': ['1d','1wk','1mo'] };
  const defaults = { '1d': '5m', '7d': '30m', '1mo': '1d', '6mo': '1d', '1y': '1d', '5y': '1wk' };
  const select = target.querySelector('#candle-interval');
  const valid = () => generation === researchRequest && target.isConnected && target.querySelector('#candle-interval') === select;
  const draw = () => { if (chartData && valid()) drawResearchChart(chartData, mode); };
  const setIntervals = () => {
    select.innerHTML = intervals[range].map(value => '<option value="' + value + '">' + ({'1d':'1 day','1wk':'1 week','1mo':'1 month'}[value] || value.replace('m',' minutes')) + '</option>').join('');
    select.value = defaults[range];
  };
  const loadHistory = async () => {
    const current = ++request;
    chartData = null;
    const canvas = target.querySelector('#research-chart');
    canvas.hidden = true;
    target.querySelector('#chart-message').textContent = 'Loading historical prices…';
    try {
      const result = await stockDataRequest('stock-history?ticker=' + encodeURIComponent(ticker) + '&range=' + range + '&interval=' + select.value);
      if (!valid() || current !== request) return;
      chartData = result;
      canvas.hidden = false;
      target.querySelector('#chart-message').textContent = result.candles.source + ' · ' + result.candles.t.length + ' candles · Regular trading hours · Prices may be delayed';
      draw();
    } catch (error) {
      if (valid() && current === request) target.querySelector('#chart-message').textContent = error.message;
    }
  };
  target.querySelectorAll('[data-chart]').forEach(button => button.addEventListener('click', () => {
    mode = button.dataset.chart;
    target.querySelectorAll('[data-chart]').forEach(item => item.classList.toggle('active', item === button)); draw();
  }));
  target.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => {
    range = button.dataset.range;
    target.querySelectorAll('[data-range]').forEach(item => item.classList.toggle('active', item === button));
    setIntervals(); loadHistory();
  }));
  select.addEventListener('change', loadHistory);
  setIntervals();
  loadHistory();
  if (window.researchResize) window.researchResize.disconnect();
  if (window.ResizeObserver) { window.researchResize = new ResizeObserver(draw); window.researchResize.observe(target.querySelector('.chart-wrap')); }
  const data = await stockDataRequest('stock-research?ticker=' + encodeURIComponent(ticker)).catch(error => ({ error: error.message }));
  if (!valid()) return;
  target.querySelector('#research-title').textContent = ticker + (data.profile?.name ? ' · ' + data.profile.name : '');
  target.querySelector('#research-status').textContent = data.error ? 'Quote unavailable' : 'Latest quote';
  if (!data.error) renderResearchStats(data);
}

function renderResearchStats(data) {
  const metric = data.metric || {}; const quote = data.quote || {}; const profile = data.profile || {};
  const entries = [['Price', formatPrice(quote.c)], ['Change', `${Number(quote.dp || 0).toFixed(2)}%`], ['Open', formatPrice(quote.o)], ['Day high', formatPrice(quote.h)], ['Day low', formatPrice(quote.l)], ['Volume', formatNumber(quote.v || metric['10DayAverageTradingVolume'])], ['52-week high', formatPrice(metric['52WeekHigh'] || metric['52WeekHighPrice'])], ['52-week low', formatPrice(metric['52WeekLow'] || metric['52WeekLowPrice'])], ['EPS (TTM)', formatPrice(metric.epsTTM)], ['P/E (TTM)', formatNumber(metric.peTTM)], ['Market cap', formatLargeNumber(profile.marketCapitalization || metric.marketCapitalization)], ['Exchange', profile.exchange || '—']];
  document.getElementById('research-stats').innerHTML = entries.map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value || '—'}</strong></div>`).join('');
}

function drawResearchChart(data, mode) {
  const canvas = document.getElementById('research-chart'); if (!canvas) return;
  const context = canvas.getContext('2d'); if (!context) return;
  const c = data.candles || {};
  const points = (c.t || []).map((time, i) => ({ time, open: Number(c.o?.[i]), high: Number(c.h?.[i]), low: Number(c.l?.[i]), close: Number(c.c?.[i]) })).filter(point => Number.isFinite(point.close));
  if (!points.length) { context.clearRect(0, 0, canvas.width, canvas.height); context.font = '14px system-ui'; context.fillStyle = '#64748b'; context.fillText('No historical chart data is available for this symbol.', 20, 40); return; }
  const bounds = canvas.parentElement.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; const width = Math.max(320, Math.floor(bounds.width)); const height = Math.max(240, Math.floor(bounds.height));
  canvas.width = width * ratio; canvas.height = height * ratio; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  const padding = { top: 18, right: 16, bottom: 34, left: 56 }; const plotWidth = width - padding.left - padding.right; const plotHeight = height - padding.top - padding.bottom;
  const values = points.flatMap(point => mode === 'mountain' ? [point.close] : [point.high, point.low, point.open, point.close]).filter(Number.isFinite);
  const min = Math.min(...values); const max = Math.max(...values); const spread = Math.max(max - min, max * 0.01, 0.01); const yMin = min - spread * 0.08; const yMax = max + spread * 0.08;
  const x = index => padding.left + (points.length === 1 ? plotWidth / 2 : index * plotWidth / (points.length - 1)); const y = value => padding.top + (yMax - value) * plotHeight / (yMax - yMin);
  context.strokeStyle = '#dbe3ef'; context.lineWidth = 1; context.fillStyle = '#64748b'; context.font = '11px system-ui';
  for (let tick = 0; tick <= 4; tick += 1) { const value = yMin + (yMax - yMin) * tick / 4; const yy = y(value); context.beginPath(); context.moveTo(padding.left, yy); context.lineTo(width - padding.right, yy); context.stroke(); context.fillText(formatCurrency(value), 4, yy + 4); }
  if (mode === 'mountain') {
    const rising = points.at(-1).close >= points[0].close; const color = rising ? '#16a34a' : '#dc2626'; const gradient = context.createLinearGradient(0, padding.top, 0, height - padding.bottom); gradient.addColorStop(0, rising ? 'rgba(22,163,74,.28)' : 'rgba(220,38,38,.28)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.beginPath(); points.forEach((point, index) => index ? context.lineTo(x(index), y(point.close)) : context.moveTo(x(index), y(point.close))); context.lineTo(x(points.length - 1), height - padding.bottom); context.lineTo(x(0), height - padding.bottom); context.closePath(); context.fillStyle = gradient; context.fill();
    context.beginPath(); points.forEach((point, index) => index ? context.lineTo(x(index), y(point.close)) : context.moveTo(x(index), y(point.close))); context.strokeStyle = color; context.lineWidth = 2; context.stroke();
  } else {
    const candleWidth = Math.max(2, Math.min(12, plotWidth / Math.max(points.length, 1) * 0.65));
    points.forEach((point, index) => { const open = Number.isFinite(point.open) ? point.open : point.close; const high = Number.isFinite(point.high) ? point.high : Math.max(open, point.close); const low = Number.isFinite(point.low) ? point.low : Math.min(open, point.close); const rising = point.close >= open; const color = rising ? '#16a34a' : '#dc2626'; context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 1; context.beginPath(); context.moveTo(x(index), y(high)); context.lineTo(x(index), y(low)); context.stroke(); const top = y(Math.max(open, point.close)); const bottom = y(Math.min(open, point.close)); context.fillRect(x(index) - candleWidth / 2, top, candleWidth, Math.max(1, bottom - top)); });
  }
  context.fillStyle = '#64748b'; context.font = '11px system-ui'; [0, Math.floor(points.length / 2), points.length - 1].filter((index, position, list) => list.indexOf(index) === position).forEach(index => context.fillText(new Date(points[index].time * 1000).toLocaleString('en-US', { timeZone: c.timezone || 'America/New_York', month: 'short', day: 'numeric', ...(c.range === '1d' ? { hour: 'numeric', minute: '2-digit' } : { year: '2-digit' }) }), Math.max(padding.left, x(index) - 28), height - 10));
}

function chartOptions() { return { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: false } } }; }
function formatNumber(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value) : '—'; }
function formatLargeNumber(value) { return Number.isFinite(Number(value)) ? `${formatNumber(Number(value) / 1000)}B` : '—'; }

function renderStockSearch() {
  return `<form id="stock-search-form" class="stock-search">
    <label for="stock-query">Find any supported U.S. stock</label>
    <p class="small-text">Search a company name or ticker, such as Nvidia or NVDA. Prices and availability depend on market-data coverage.</p>
    <div class="search-controls"><input id="stock-query" type="search" placeholder="Company name or ticker" maxlength="80" required ${pendingOrder ? 'disabled' : ''} />
    <button type="submit" ${pendingOrder ? 'disabled' : ''}>Search</button></div>
    </form><div id="stock-search-results" aria-live="polite"></div>`;
}

async function stockDataRequest(path) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Please sign in again to look up stocks.');
  const response = await fetch(`${API_BASE}/${path}`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Stock lookup failed. Please try again.');
  return result;
}

function attachStockSearch() {
  const form = document.getElementById('stock-search-form');
  const results = document.getElementById('stock-search-results');
  const generation = searchGeneration;
  let request = 0;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pendingOrder || tradeBusy || quoteBusy) return;
    const query = document.getElementById('stock-query').value.trim();
    if (!query) return;
    const current = ++request;
    results.textContent = 'Searching stocks…';
    try {
      const data = await stockDataRequest(`stock-search?q=${encodeURIComponent(query)}`);
      if (generation !== searchGeneration || current !== request || tradeBusy || pendingOrder) return;
      results.innerHTML = data.stocks.length ? `<p class="small-text">Select a result to get its latest quote. Showing up to 25 matches.</p><ul class="stock-results">${data.stocks.map(stock => `<li><button type="button" class="secondary" data-symbol="${escapeHtml(stock.ticker)}"><strong>${escapeHtml(stock.ticker)}</strong><span>${escapeHtml(stock.name)}</span></button></li>`).join('')}</ul>` : '<p class="message">No matching stocks. Try a different company name or exact ticker.</p>';
      results.querySelectorAll('[data-symbol]').forEach(button => button.addEventListener('click', async () => {
        if (pendingOrder || tradeBusy || quoteBusy) return;
        const ticker = button.dataset.symbol;
        quoteBusy = true;
        results.textContent = `Loading quote for ${ticker}…`;
        if (document.getElementById('trade-form')) updateTradeEstimate();
        try {
          const { stock } = await stockDataRequest(`stock-quote?ticker=${encodeURIComponent(ticker)}`);
          if (generation !== searchGeneration) return;
          dashboardState.stocks = [...dashboardState.stocks.filter(item => item.ticker !== stock.ticker), stock].sort((a, b) => a.ticker.localeCompare(b.ticker));
          selectedTicker = stock.ticker;
          activeStudentTab = 'trade';
          tradeNotice = null;
          renderStudentTabs();
        } catch (error) {
          if (generation === searchGeneration) results.textContent = error.message;
        } finally {
          if (generation === searchGeneration) {
            quoteBusy = false;
            if (document.getElementById('trade-form')) updateTradeEstimate();
          }
        }
      }));
    } catch (error) {
      if (generation === searchGeneration && current === request) results.textContent = error.message;
    }
  });
}

function updateTradeEstimate() {
  const { stocks, portfolio } = dashboardState;
  const ticker = document.getElementById('trade-ticker').value;
  const shares = Number(document.getElementById('trade-shares').value);
  const action = document.getElementById('trade-action').value;
  const stock = stocks.find(row => row.ticker === ticker);
  const validShares = Number.isSafeInteger(shares) && shares > 0 && shares <= 2147483647;
  const price = Number(stock?.current_price);
  const total = validShares && price > 0 ? Math.round(shares * price * 100) / 100 : null;
  const owned = Number(portfolio.holdings[ticker] || 0);
  let warning = '';
  if (!validShares) warning = 'Enter a positive whole number of shares.';
  else if (action === 'sell' && shares > owned) warning = 'You do not own enough shares to sell this quantity.';
  else if (action === 'buy' && total > portfolio.cash) warning = 'This estimate exceeds your available cash. The final balance check uses the execution quote.';
  document.getElementById('trade-estimate').innerHTML = `<dl class="ticket-details">
    <div><dt>Stock</dt><dd>${escapeHtml(ticker || '—')}</dd></div>
    <div><dt>Shares owned</dt><dd>${owned}</dd></div>
    <div><dt>${stock?.is_overridden ? 'Classroom price' : 'Latest saved price'}</dt><dd>${price > 0 ? formatPrice(price) : 'Unavailable'}</dd></div>
    <div><dt>Price as of</dt><dd>${formatDate(stock?.last_updated)}</dd></div>
    <div><dt>Estimated ${action === 'buy' ? 'cost' : 'proceeds'}</dt><dd>${total !== null ? formatCurrency(total) : '—'}</dd></div>
    <div><dt>Estimated cash after</dt><dd>${total !== null ? formatCurrency(portfolio.cash + (action === 'buy' ? -total : total)) : '—'}</dd></div>
    </dl>${warning ? `<p class="message error">${warning}</p>` : ''}
    ${pendingOrder ? '<p class="message">This ticket has an unconfirmed result. Retry it to retrieve the receipt or complete the order. The same ticket will never be filled twice.</p>' : ''}`;
  const submit = document.getElementById('trade-submit');
  submit.disabled = tradeBusy || quoteBusy || (!pendingOrder && (!stock || portfolio.missing || !validShares || (action === 'sell' && shares > owned)));
  submit.textContent = tradeBusy ? 'Placing order…' : pendingOrder ? 'Retry this ticket' : `Place market ${action} order`;
}

async function handleTrade() {
  if (tradeBusy || quoteBusy) return;
  const studentId = dashboardState.profile.id;
  const storageKey = `trade-ticket:${studentId}`;
  const order = pendingOrder || {
    action: document.getElementById('trade-action').value,
    ticker: document.getElementById('trade-ticker').value,
    shares: Number(document.getElementById('trade-shares').value),
    request_id: crypto.randomUUID(),
  };
  if (!Number.isSafeInteger(order.shares) || order.shares < 1 || order.shares > 2147483647 || !order.ticker) return;
  tradeBusy = true;
  tradeNotice = null;
  document.getElementById('trade-message').textContent = '';
  setTicketLocked(true);
  updateTradeEstimate();
  let completed = false;
  try {
    // Save before sending so refreshes and lost responses can reuse the same ticket.
    sessionStorage.setItem(storageKey, JSON.stringify(order));
    pendingOrder = order;
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error('Sign in again, then retry this ticket.');
    const response = await fetch(`${API_BASE}/trade`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(order), signal: AbortSignal.timeout(35000),
    });
    const result = await response.json();
    if (!response.ok || !result.trade) {
      if (result.uncertain === false || (result.uncertain !== true && response.status < 500)) {
        sessionStorage.removeItem(storageKey);
        pendingOrder = null;
      }
      throw new Error(result.error || 'The order result could not be confirmed. Retry this ticket.');
    }
    const trade = result.trade;
    completed = true;
    sessionStorage.removeItem(storageKey);
    pendingOrder = null;
    tradeNotice = { text: `${trade.action === 'buy' ? 'Bought' : 'Sold'} ${trade.shares} ${trade.ticker} at ${formatPrice(trade.price)} per share. Total: ${formatCurrency(trade.total)}. Cash after trade: ${formatCurrency(trade.cash)}. Receipt: ${trade.id}.` };
    // Update the known cash immediately; reload holdings, research prices, and history together.
    dashboardState.portfolio.cash = Number(trade.cash);
    const stocks = await loadStocks();
    const [portfolio, history, leaderboard] = await Promise.all([
      loadStudentPortfolio(studentId), loadTradeHistory(studentId), loadLeaderboard(stocks),
    ]);
    dashboardState = { ...dashboardState, stocks, portfolio, history, leaderboard };
  } catch (error) {
    if (completed) tradeNotice.text += ' Refresh Accounts to load the latest balances.';
    else tradeNotice = { error: true, text: error.name === 'TimeoutError' ? 'The order result was not confirmed. Retry this same ticket to avoid a duplicate trade.' : error.message };
  } finally {
    tradeBusy = false;
    renderStudentTabs();
  }
}

async function handleCreateStudent() {
  const form = document.getElementById('student-form');
  const data = new FormData(form);
  const payload = {
    action: 'createStudent',
    username: data.get('username'),
    email: data.get('email'),
    password: data.get('password'),
    starting_cash: Number(data.get('starting_cash')),
  };

  const result = await callManageUserApi(payload);
  if (result.error) {
    return alert(result.error);
  }
  alert('Student account created.');
  start();
}

async function handleAddTicker() {
  const form = document.getElementById('ticker-form');
  const data = new FormData(form);

  const ticker = data.get('ticker').trim().toUpperCase();
  const name = data.get('name').trim();
  const price = Number(data.get('price'));

  if (!ticker || !name || price <= 0) {
    return alert('Fill all ticker fields.');
  }

  await supabase.from('stocks').insert([{ ticker, name, current_price: price, prev_close: price, last_updated: new Date().toISOString(), is_overridden: false }]);
  alert('Ticker added.');
  start();
}

async function handleOverridePrice() {
  const form = document.getElementById('price-override-form');
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const session = await supabase.auth.getSession();
    const token = session.data?.session?.access_token;
    if (!token) throw new Error('Please sign in again.');
    const response = await fetch(API_BASE + '/override-stock', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ ticker: String(data.get('ticker')).trim().toUpperCase(), price: Number(data.get('price')) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Override failed.');
    alert(result.ticker + ' classroom price set to ' + formatPrice(result.price));
    start();
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; }
}

async function handleRefreshPrices() {
  const response = await fetch(`${API_BASE}/fetch-stocks`, { method: 'GET' });
  const data = await response.json();
  if (response.ok) {
    alert('Latest prices refreshed.');
    start();
  } else {
    alert(`Price refresh failed: ${data.error || response.statusText}`);
  }
}

async function handleResetPortfolio(studentId) {
  const confirmation = confirm('Reset this student portfolio to starting cash?');
  if (!confirmation) return;

  const payload = { action: 'resetPortfolio', student_id: studentId };
  const result = await callManageUserApi(payload);
  if (result.error) {
    return alert(result.error);
  }
  alert('Portfolio reset.');
  start();
}

async function callManageUserApi(payload) {
  const session = await supabase.auth.getSession();
  const token = session.data?.session?.access_token;

  const response = await fetch(`${API_BASE}/manage-user`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  return response.json();
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
}

let modalChartInstance = null;

async function loadPriceChart(ticker, canvasId = 'priceChart') {
  const { data, error } = await supabase
    .from('price_history')
    .select('price, recorded_at')
    .eq('ticker', ticker)
    .order('recorded_at', { ascending: true });

  if (error) { console.error(error); return; }

  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  if (!data || data.length === 0) {
    canvas.parentElement.insertAdjacentHTML('beforeend', '<p class="small-text">No price history yet for this stock.</p>');
    return;
  }

  const labels = data.map(d => new Date(d.recorded_at).toLocaleString());
  const prices = data.map(d => d.price);
  const trendingUp = prices[prices.length - 1] >= prices[0];

  if (modalChartInstance) modalChartInstance.destroy();

  const ctx = canvas.getContext('2d');
  modalChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: ticker,
        data: prices,
        borderColor: trendingUp ? '#16a34a' : '#dc2626',
        backgroundColor: trendingUp ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.25,
        fill: true
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 6 } },
        y: {}
      }
    }
  });
}

window.openStockModal = function (ticker) {
  document.getElementById('modal-ticker').textContent = ticker;
  document.getElementById('stock-modal').classList.remove('hidden');
  loadPriceChart(ticker, 'modalChart');
};

window.closeStockModal = function () {
  document.getElementById('stock-modal').classList.add('hidden');
};

function attachAuditLog() {
  let page = 0, generation = 0;
  const filter = document.getElementById('audit-student');
  const results = document.getElementById('audit-results');
  const load = async () => {
    const request = ++generation;
    results.textContent = 'Loading transactions…';
    document.getElementById('audit-prev').disabled = true;
    document.getElementById('audit-next').disabled = true;
    try {
      const data = await stockDataRequest('student-audit?student=' + encodeURIComponent(filter.value) + '&page=' + page);
      if (request !== generation || !results.isConnected) return;
      const selected = filter.value;
      filter.innerHTML = '<option value="">All students</option>' + data.students.map(student => '<option value="' + escapeHtml(student.id) + '">' + escapeHtml(student.username) + '</option>').join('');
      filter.value = selected;
      const names = Object.fromEntries(data.students.map(student => [student.id, student.username]));
      results.innerHTML = data.rows.length ? '<div class="table-scroll"><table class="table"><thead><tr><th>Time</th><th>Student</th><th>Action</th><th>Stock</th><th>Shares</th><th>Fill price</th><th>Total</th><th>Cash after</th><th>Price source</th></tr></thead><tbody>' + data.rows.map(row => '<tr><td>' + escapeHtml(formatDate(row.timestamp)) + '</td><td>' + escapeHtml(names[row.student_id] || row.student_id) + '</td><td><span class="trade-badge ' + (row.action === 'buy' ? 'buy' : 'sell') + '">' + (row.action === 'buy' ? 'BUY' : 'SELL') + '</span></td><td>' + escapeHtml(row.ticker) + '</td><td>' + Number(row.shares) + '</td><td>' + formatPrice(row.price) + '</td><td>' + formatCurrency(row.total_amount ?? row.price * row.shares) + '</td><td>' + (row.cash_after == null ? '—' : formatCurrency(row.cash_after)) + '</td><td>' + escapeHtml(row.price_source || 'Legacy') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="audit-empty">No trades yet. Completed buys and sells will appear here.</p>';
      document.getElementById('audit-page').textContent = data.count + ' transactions · Page ' + (page + 1);
      document.getElementById('audit-prev').disabled = page === 0;
      document.getElementById('audit-next').disabled = (page + 1) * 50 >= data.count;
    } catch (error) { if (request === generation && results.isConnected) results.textContent = error.message; }
  };
  filter.addEventListener('change', () => { page = 0; load(); });
  document.getElementById('audit-refresh').addEventListener('click', () => { page = 0; load(); });
  document.getElementById('audit-prev').addEventListener('click', () => { page--; load(); });
  document.getElementById('audit-next').addEventListener('click', () => { page++; load(); });
  load();
}
