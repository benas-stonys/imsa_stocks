import { SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE } from './config.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById('app');

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

  app.innerHTML = `
    <div class="card">
      <div class="grid grid-2">
        <div>
          <h1>Welcome, ${profile.username}</h1>
          <p class="small-text">Role: ${profile.role}</p>
        </div>
        <div style="text-align:right; align-self:center;">
          <button id="logout-button" class="secondary">Log out</button>
        </div>
      </div>
    </div>
    ${profile.role === 'admin' ? renderAdminPanel(profile, stocks, leaderboard) : renderStudentPanel(profile, studentPortfolio, stocks, leaderboard)}
  `;

  document.getElementById('logout-button').addEventListener('click', async () => {
    await supabase.auth.signOut();
    renderAuth();
  });

  if (profile.role === 'student') {
    document.getElementById('trade-form').addEventListener('submit', async event => {
      event.preventDefault();
      await handleTrade(profile.id, stocks);
    });
  }

  if (profile.role === 'admin') {
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
}

function renderStudentPanel(profile, portfolio, stocks, leaderboard) {
  const totalValue = calculatePortfolioValue(portfolio, stocks);
  return `
    <div class="grid grid-2">
      <div class="card">
        <h2>Your portfolio</h2>
        <p>Cash: <strong>${formatCurrency(portfolio.cash)}</strong></p>
        <p>Total value: <strong>${formatCurrency(totalValue)}</strong></p>
        <p class="small-text">Starting cash: ${formatCurrency(profile.starting_cash)}</p>
        ${renderHoldingsTable(portfolio.holdings, stocks)}
      </div>
      <div class="card">
        <h2>Trade</h2>
        <form id="trade-form">
          <label>Action</label>
          <select id="trade-action" required>
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
          <label>Ticker</label>
          <select id="trade-ticker" required>
            ${stocks.map(stock => `<option value="${stock.ticker}">${stock.ticker} — ${stock.name}</option>`).join('')}
          </select>
          <label>Shares</label>
          <input id="trade-shares" type="number" min="1" step="1" value="1" required />
          <button type="submit">Submit trade</button>
        </form>
      </div>
    </div>
    <div class="card">
      <h2>Leaderboard</h2>
      ${renderLeaderboard(leaderboard)}
    </div>
  `;
}

function renderAdminPanel(profile, stocks, leaderboard) {
  return `
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
        <select name="ticker" required>
          ${stocks.map(stock => `<option value="${stock.ticker}">${stock.ticker}</option>`).join('')}
        </select>
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
    return { cash: 0, holdings: {} };
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

async function handleTrade(studentId, stocks) {
  const action = document.getElementById('trade-action').value;
  const ticker = document.getElementById('trade-ticker').value;
  const shares = Number(document.getElementById('trade-shares').value);

  const stock = stocks.find(item => item.ticker === ticker);
  if (!stock) {
    return alert('Ticker not found.');
  }

  const portfolio = await loadStudentPortfolio(studentId);
  const price = Number(stock.current_price);
  const cost = price * shares;

  if (action === 'buy' && cost > portfolio.cash) {
    return alert('Not enough cash to complete this trade.');
  }

  const tickerShares = portfolio.holdings[ticker] || 0;
  if (action === 'sell' && shares > tickerShares) {
    return alert('Not enough shares to sell.');
  }

  const updatedHoldings = { ...portfolio.holdings };
  if (action === 'buy') {
    updatedHoldings[ticker] = tickerShares + shares;
  } else {
    updatedHoldings[ticker] = tickerShares - shares;
    if (updatedHoldings[ticker] <= 0) {
      delete updatedHoldings[ticker];
    }
  }

  const updatedCash = action === 'buy' ? portfolio.cash - cost : portfolio.cash + cost;

  await Promise.all([
    supabase.from('portfolios').update({ cash: updatedCash, holdings: updatedHoldings, updated_at: new Date().toISOString() }).eq('student_id', studentId),
    supabase.from('transactions').insert([{ student_id: studentId, ticker, action, shares, price, timestamp: new Date().toISOString() }]),
  ]);

  start();
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
  const ticker = data.get('ticker');
  const price = Number(data.get('price'));

  if (price <= 0) {
    return alert('Price must be positive.');
  }

  const { error } = await supabase.from('stocks').update({ current_price: price, is_overridden: true, last_updated: new Date().toISOString() }).eq('ticker', ticker);
  if (error) {
    return alert(error.message);
  }

  alert('Price overridden.');
  start();
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

async function loadPriceChart(ticker) {
  const { data, error } = await supabase
    .from('price_history')
    .select('price, recorded_at')
    .eq('ticker', ticker)
    .order('recorded_at', { ascending: true });

  if (error) { console.error(error); return; }
  if (!data || data.length === 0) return;

  const labels = data.map(d => new Date(d.recorded_at).toLocaleString());
  const prices = data.map(d => d.price);
  const trendingUp = prices[prices.length - 1] >= prices[0];

  const ctx = document.getElementById('priceChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: ticker,
        data: prices,
        borderColor: trendingUp ? '#2FBF71' : '#E5484D',
        backgroundColor: trendingUp ? 'rgba(47,191,113,0.08)' : 'rgba(229,72,77,0.08)',
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
        x: {
          ticks: { color: '#7C879E', maxTicksLimit: 6 },
          grid: { color: '#26314E' }
        },
        y: {
          ticks: { color: '#7C879E' },
          grid: { color: '#26314E' }
        }
      }
    }
  });
}