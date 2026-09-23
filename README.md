
## Overview

Lightweight classroom stock trading simulator built for Supabase + Netlify.

## What this includes

Student and admin login with Supabase Auth
Supabase-backed data model for students, portfolios, transactions, and stocks
Admin controls for adding students, adding symbols, overriding prices, and resetting portfolios
Student trading view with holdings, cash balance, total value, and leaderboard
Me goofing off for now with this project

## Student pages

- **Trade:** whole-share market buy/sell tickets, cash and cost previews, execution receipts, and safe retries.
- **Research:** classroom stock list, existing price-history charts, and research links.
- **Accounts:** cash, holdings, portfolio value, the latest 50 trades, and the existing leaderboard.

## Market trade rollout

1. Install dependencies with `npm ci` and run `npm test`.
2. In the existing Supabase project, apply `supabase/migrations/202609230001_market_trades.sql` using the SQL editor or your migration runner. Do not rerun the initial schema against an existing database.
3. Deploy the website and Netlify functions together. Coordinate this with the migration: it removes the old browser's direct write access to portfolios and transactions, so the previous Trade page stops working after the migration.
4. Confirm Netlify has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `FINNHUB_API_KEY` (or `FINNHUB_KEY`) for the deployed context. Never put the service role or market-data key in browser code.
5. Verify with a disposable student account: buy, sell, insufficient funds, and Accounts/history updates. Do not test purchases against a real student's portfolio.

Each order requests the provider's latest quote at submission; saved prices are only estimates. These are immediate simulated fills, not orders routed to a broker. Outside trading hours, the last available quote is used; quotes older than seven days are rejected. Existing teacher price overrides remain authoritative. Limit orders, fractional shares, fees, and exchange-session queuing are not implemented.

The Netlify handler verifies the user's session and student role, chooses the execution price, and calls a service-role-only Postgres function. That function locks the student's portfolio, validates cash/shares, then writes cash, holdings, and the transaction atomically. A per-student ticket UUID prevents retries from executing twice. Pending tickets are retained in browser session storage until a confirmed outcome; a network timeout can be retried safely. Prices are stored to four decimal places and order totals are rounded to cents in Postgres.

`npm test` includes isolated Postgres tests (PGlite), API tests, and DOM interaction tests. They use synthetic accounts and never contact the production database or market-data API. The existing project RLS policies for profile, stock, portfolio, and transaction reads are preserved; the migration does not broaden student access.
