# Advanced classroom orders

Adds a separate advanced ticket below the quick market ticket, with up to eight stock legs, Add/Remove order buttons, Day/GTC, and pending ticket controls on Trade and Accounts.

Order types: Market, Limit, Stop market, Stop limit, Trailing stop (dollars or percentage), simulated Market on close.

Groups: all-or-none basket; OCO (two legs); first triggers all; sequence; first triggers OCO (three legs); contingent stock-price threshold activating an all-or-none basket. Equal-time OCO triggers resolve in ticket order. Activated children start at a subsequent observation. Follow-up orders that cannot reserve funds are rejected, while completed parent fills remain recorded.

## Accounting and execution

All fills use the existing atomic journaled trade routine, so holdings, cash, audit history and journal entries update together. Portfolio locks serialize quick trades, order submissions, worker fills, cancellation and resets. Version checks protect against cancellation/worker races. IDs persist across ambiguous browser requests. Baskets roll back all fills if any leg fails.

Active buys reserve limit value or a current-price/stop estimate plus 10%; active sells reserve shares. OCO alternatives share the larger requirement. Waiting child orders reserve nothing until activated. Buying is cash-only: basket sell proceeds do not fund its initial buy reservation. Quotes beyond available cash cause explicit rejection. Account resets cancel remaining orders while retaining historical tickets and fills.

The scheduler runs once per minute on weekdays in a UTC window covering Eastern daylight and standard time; runtime checks restrict trading to 9:30–16:00 Eastern and allow close processing through 16:15. Day orders use the next weekday 16:00 close. This is a classroom session convention, not a complete exchange holiday/early-close calendar. Quotes must be no older than 15 minutes and not precede activation; stale/holiday observations cannot fill ordinary orders. Classroom overrides bypass market quote freshness but use the same session hours. Trails track observed prices only. Brief intraminute movements can be missed.

Simulated close orders use a recent observed quote at/after the classroom close, not an exchange auction price; they expire if no eligible quote is observed within 15 minutes. Early close days are not modeled. GTC otherwise remains open until filled or cancelled.

## Free-tier budget

Finnhub requests share a database-backed sliding-window cap of 50 calls per 60 seconds (below the published free allowance of 60). Monitoring gets at most 20, leaving room for research/trades/catalog requests. This does not cover unrelated apps using the same key. Stocks are rotated by last check and shared across student tickets. Large baskets may wait until all their stocks receive fresh quotes together. Other hourly/manual refreshes also consume the shared budget. Quote failures leave orders pending, not falsely filled.

Netlify schedules still consume the hosting plan's usage allowance. Actual account plan/usage has not been inspected; no paid resources or upgrades were enabled.

## Rollout (database first)

1. Apply `supabase/migrations/202611040002_advanced_orders.sql` in the existing Supabase project, after the learning-features migration. It is transactional and rerunnable.
2. Verify order_tickets and market_api_slots have RLS enabled and no anon/authenticated direct access. Functions are service-role only.
3. Merge the feature branch to main to deploy via Netlify. Do not deploy functions before the migration: all Finnhub calls now use the shared rate-budget function.
4. Verify the orders-tick scheduled function, signed-in order list, form controls and available/reserved balances. Use a designated test account for actual test tickets. No real student orders have been placed during implementation.

Validation: `node --test tests/*.test.js` (51 passing at implementation). Tests include actual PGlite PostgreSQL migrations and accounting, privacy, rate limits, rules and uncertain UI retry behavior. Live scheduler execution and browser visual QA remain to be verified.
