# Classroom learning features

## Deployment

Apply `supabase/migrations/202611040001_learning_features.sql` in the Supabase SQL editor **before** deploying the JavaScript/functions. It is transactional and repeatable. Existing portfolios, transactions, and users are retained. It depends on the market-trades migration and the qualified price-history trigger fix already used by this app.

Deploy through the existing Netlify Git integration. The new `classroom-tick` scheduled function runs at minute 10 of each hour (UTC). Netlify only runs schedules on published deploys, and scheduled functions cannot be invoked through a public URL. On the Netlify Functions screen, Run now can verify processing without waiting an hour.

Existing environment variables are sufficient: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and FINNHUB_API_KEY (or FINNHUB_KEY). No new browser secrets or dependencies. Price refreshes use Finnhub and validate its price and quote timestamp. Each run checks up to 40 stocks with four requests in parallel and a bounded time budget, rotating least-recently-checked symbols first. Larger catalogs or provider failures can defer stocks to later runs; the admin refresh reports checked, unavailable and deferred counts. The manual refresh now requires an administrator session. The snapshot/scenario job runs independently so a provider outage does not stop teacher simulations.

## Student workflow

- Trade: optional original rationale, saved atomically with the trade and unchanged by ticket retries. Add the selected stock to a personal watchlist.
- Research: private watchlist and one-time above/below price alerts. Each alert triggers at or beyond the threshold on an hourly check, then can be acknowledged or removed. Alerts are in-app, not email/push. Fixed teacher prices qualify too.
- Accounts: daily portfolio snapshots, comparison with SPY price returns (an S&P 500 ETF, excluding dividends), cash/stock allocation and concentration, assignments, and a paginated trade journal with editable reflections and teacher feedback.
- Demo: watchlists, alerts, journal notes and a sample assignment are memory-only and reset with the demo. Its chart shows only the current sample snapshot, not invented performance history.

## Teacher workflow

Learning tools contains assignments, student progress and feedback, journals with student filters, and price scenarios. Assignments go to all students, including students added later. Due dates mark late work but do not block submission. Resubmission clears the prior review and feedback. Closing an assignment prevents further submissions; its data is retained.

For a scenario, first override a supported stock in Manage stocks. Supply a title, stock, target, and future start. A jump reaches the target on the first scheduled run after the start. A linear move interpolates from the saved starting override according to elapsed time, in hourly steps, for at least one hour and at most one year. Only one pending/active scenario is allowed per stock. The scenario affects every student's execution price, valuation and leaderboard. Completion holds the target; cancellation holds the last value. A new manual override automatically cancels any active/pending scenario for that stock.

Overridden stock charts show only recorded classroom prices, labelled simulated; market fundamentals remain market fundamentals. A minute interval aggregates observations and does not invent minute-by-minute prices. Trades with a classroom quote that changed before execution are rejected, preserving the existing atomic order checks.

## Accounting and access

The hourly processor updates scenario prices, triggers alerts, then records cash plus shares multiplied by the same saved prices used in Accounts and the leaderboard. Snapshots use New York calendar dates, are updated during the day, and retain one point per day. A missing holding price skips that account's snapshot rather than valuing the holding at zero. Benchmark failures create gaps, not fabricated values; SPY quotes always come from the market provider independently of classroom overrides. Comparisons start at a common recorded date, and charts disclose simulated holdings.

History begins after deployment; old daily values cannot be reconstructed reliably. Resetting a portfolio clears its performance timeline atomically with resetting cash/holdings and retains its transaction/journal audit trail. The UI displays at most five years of recorded snapshots. Quote/provider outages may leave saved prices stale; alerts and classroom steps are not real-time ticks.

All new tables have row-level security and no browser grants. A verified server session supplies the actor ID to service-only RPCs. Students can read/edit only their own watchlists, alerts, reflections and submissions. Only administrators can create scenarios/assignments, see all student journals and submissions, or provide teacher feedback. Text is length-limited and escaped in the UI. Existing student audit CSV remains unchanged; journal notes are available in Learning tools.

## Verification

Run `node --test tests/*.test.js`. The PGlite tests execute real PostgreSQL migrations, check repeatability and role grants, validate journal retry behavior and privacy, simulate market and overridden price moves, verify totals and snapshots, test assignment review/resubmission/closing, and test scenario conflicts/cancellation/completion. DOM tests exercise the student and teacher controls and demo isolation.
