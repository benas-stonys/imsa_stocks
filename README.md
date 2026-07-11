

lightweight classroom stock trading simulator built for Supabase + Netlify.

What this includes

Student and admin login with Supabase Auth
Supabase-backed data model for students, portfolios, transactions, and stocks
Admin controls for adding students, adding symbols, overriding prices, and resetting portfolios
Student trading view with holdings, cash balance, total value, and leaderboard

## Notes

Live market refresh is handled server-side to keep the API key secure.
Admin overrides prevent auto-refresh from changing that symbol while the override is active.
This is a starter project and is meant to be very lightweight and upgradable in the future.
