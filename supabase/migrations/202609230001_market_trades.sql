begin;

alter table public.transactions add column if not exists request_id uuid;
alter table public.transactions add column if not exists cash_after numeric;
alter table public.transactions add column if not exists total_amount numeric;
alter table public.transactions add column if not exists quote_as_of timestamptz;
alter table public.transactions add column if not exists price_source text;
create unique index if not exists transactions_student_request_idx
  on public.transactions (student_id, request_id);

-- Only the authenticated Netlify handler may supply an execution price.
create or replace function public.execute_market_trade(
  p_student_id uuid, p_request_id uuid, p_ticker text, p_action text,
  p_shares integer, p_price numeric, p_quote_as_of timestamptz, p_price_source text
) returns jsonb
language plpgsql security invoker set search_path = '' set lock_timeout = '5s'
as $$
declare
  account public.portfolios%rowtype;
  executed public.transactions%rowtype;
  stock public.stocks%rowtype;
  owned bigint;
  next_owned bigint;
  total numeric;
  execution_price numeric;
  next_cash numeric;
  positions jsonb;
begin
  if p_request_id is null or p_action is null or p_action not in ('buy', 'sell')
      or p_shares is null or p_shares <= 0 then
    raise exception 'Enter a valid order with a positive whole number of shares.';
  end if;
  if not exists (select 1 from public.profiles where id = p_student_id and role = 'student') then
    raise exception 'A student account is required to trade.';
  end if;
  -- Serialize all orders for this account, including simultaneous requests.
  select * into account from public.portfolios where student_id = p_student_id for update;
  if not found then raise exception 'No portfolio found. Contact your teacher.'; end if;
  select * into executed from public.transactions
    where student_id = p_student_id and request_id = p_request_id;
  if found then
    if executed.ticker <> p_ticker or executed.action <> p_action or executed.shares <> p_shares then
      raise exception 'This ticket was already used for a different order.';
    end if;
  else
    if p_price is null or p_price <= 0 or p_price::text in ('NaN', 'Infinity', '-Infinity')
        or p_quote_as_of is null or p_price_source is null or p_price_source not in ('market', 'classroom') then
      raise exception 'A valid execution quote is required.';
    end if;
    select * into stock from public.stocks where ticker = p_ticker for update;
    if not found then raise exception 'This stock is not available for classroom trading.'; end if;
    if stock.is_overridden then
      if p_price_source <> 'classroom' or p_price <> stock.current_price then
        raise exception 'The classroom price changed. Please submit a new ticket.';
      end if;
    elsif p_price_source <> 'market' or p_quote_as_of < now() - interval '7 days'
        or p_quote_as_of > now() + interval '5 minutes' then
      raise exception 'The market quote is no longer valid. Please try again.';
    end if;
    execution_price := round(p_price, 4);
    total := round(execution_price * p_shares, 2);
    if execution_price <= 0 or total <= 0 then raise exception 'Trade value must be at least one cent.'; end if;
    owned := coalesce((account.holdings ->> p_ticker)::bigint, 0);
    if p_action = 'buy' and total > account.cash then raise exception 'Not enough cash to complete this trade.'; end if;
    if p_action = 'sell' and p_shares > owned then raise exception 'Not enough shares to sell.'; end if;
    next_cash := account.cash + case when p_action = 'buy' then -total else total end;
    next_owned := owned + case when p_action = 'buy' then p_shares else -p_shares end;
    positions := coalesce(account.holdings, '{}'::jsonb);
    if next_owned = 0 then positions := positions - p_ticker;
    else positions := jsonb_set(positions, array[p_ticker], to_jsonb(next_owned)); end if;
    update public.portfolios set cash = next_cash, holdings = positions, updated_at = now() where id = account.id;
    insert into public.transactions (student_id, request_id, ticker, action, shares, price, cash_after, total_amount, quote_as_of, price_source)
      values (p_student_id, p_request_id, p_ticker, p_action, p_shares, execution_price, next_cash, total, p_quote_as_of, p_price_source)
      returning * into executed;
    if p_price_source = 'market' then
      update public.stocks set current_price = execution_price, last_updated = p_quote_as_of
        where ticker = p_ticker and (last_updated <= p_quote_as_of or current_price <> execution_price);
    end if;
  end if;
  return jsonb_build_object('id', executed.id, 'ticker', executed.ticker,
    'action', executed.action, 'shares', executed.shares, 'price', executed.price,
    'total', executed.total_amount, 'cash', executed.cash_after,
    'timestamp', executed.timestamp, 'quote_as_of', executed.quote_as_of, 'price_source', executed.price_source);
end;
$$;

revoke all on function public.execute_market_trade(uuid, uuid, text, text, integer, numeric, timestamptz, text) from public, anon, authenticated;
grant execute on function public.execute_market_trade(uuid, uuid, text, text, integer, numeric, timestamptz, text) to service_role;
-- Browser writes must not bypass the order checks. Admin creation/reset uses the service role.
revoke insert, update, delete, truncate on public.portfolios, public.transactions from public, anon, authenticated;

commit;
