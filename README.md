# Classroom Trading Simulator

A lightweight classroom stock trading simulator built for Supabase + Netlify.

## What this includes

- Student and admin login with Supabase Auth
- Supabase-backed data model for students, portfolios, transactions, and stocks
- Admin controls for adding students, adding symbols, overriding prices, and resetting portfolios
- Student trading view with holdings, cash balance, total value, and leaderboard
- Serverless support for secure user creation and live stock refresh via Alpha Vantage / Finnhub

## Files created

- `index.html` — single-page app shell
- `styles.css` — responsive UI styles
- `app.js` — client logic for Supabase, auth, trading, and admin flows
- `config.example.js` — place to copy and fill your Supabase and API settings
- `netlify.toml` — site deploy config for Netlify functions
- `netlify/functions/manage-user.js` — secure admin-only user provisioning and portfolio reset
- `netlify/functions/fetch-stocks.js` — server-side stock price refresh from market API
- `supabase-schema.sql` — database schema and seed starter data
- `package.json` — dependency management for functions
- `.gitignore` — ignores secrets and Node modules

## Setup

1. Create a Supabase project.
2. In Supabase SQL editor, run `supabase-schema.sql` to create tables.
3. Copy `config.example.js` to `config.js` and fill in your Supabase values.
4. Set environment variables in Netlify:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ALPHA_VANTAGE_KEY` or `FINNHUB_KEY`
5. Deploy to Netlify or run locally with `netlify dev`.

## How to use

- On first deploy, open the site and create the admin account from the setup screen.
- Use the admin dashboard to add students and tickers.
- Students login with their email/password and start trading.

## Notes

- Live market refresh is handled server-side to keep the API key secure.
- Admin overrides prevent auto-refresh from changing that symbol while the override is active.
- This starter project is intentionally lightweight and can be extended with charts, better validation, and a richer site layout.
