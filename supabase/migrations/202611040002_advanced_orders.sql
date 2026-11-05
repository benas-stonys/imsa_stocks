begin;
create table if not exists public.order_tickets (
 id uuid primary key, student_id uuid not null references public.profiles(id),
 definition jsonb not null, state jsonb not null, version integer not null default 0,
 status text not null default 'open' check(status in ('open','completed','cancelled','rejected')),
 message text, created_at timestamptz not null default now(), checked_at timestamptz,
 updated_at timestamptz not null default now()
);
create index if not exists order_tickets_pending on public.order_tickets(checked_at nulls first,created_at) where status='open';
create index if not exists order_tickets_student on public.order_tickets(student_id,created_at desc);
alter table public.order_tickets enable row level security;
revoke all on public.order_tickets from public,anon,authenticated;
grant select,insert,update,delete on public.order_tickets to service_role;

-- Reservations are derived from live legs, so cancellation immediately releases them.
-- An OCO pair shares the larger cash/share requirement instead of reserving twice.
create or replace function public.order_reservations(p_student uuid)
returns table(cash numeric,shares jsonb) language sql stable set search_path='' as $$
 with legs as (
 select t.id,l, (t.state->>'mode'='oco' or (t.state->>'mode'='triggers_oco' and t.state->'legs'->0->>'status'='filled')) as oco
 from public.order_tickets t cross join lateral jsonb_array_elements(t.state->'legs') l
 where t.student_id=p_student and t.status='open' and l->>'status'='open'
 ), buys as (
 select id,case when bool_or(oco) then max(round((l->>'shares')::numeric*(l->>'reserve_price')::numeric,2)) else sum(round((l->>'shares')::numeric*(l->>'reserve_price')::numeric,2)) end amount
 from legs where l->>'action'='buy' group by id
 ), sells as (
 select id,l->>'ticker' ticker,case when bool_or(oco) then max((l->>'shares')::bigint) else sum((l->>'shares')::bigint) end amount
 from legs where l->>'action'='sell' group by id,l->>'ticker'
 ), totals as (select ticker,sum(amount) amount from sells group by ticker)
 select coalesce((select sum(amount) from buys),0),coalesce((select jsonb_object_agg(ticker,amount) from totals),'{}'::jsonb);
$$;

create or replace function public.assert_order_capacity(p_student uuid) returns void
language plpgsql set search_path='' as $$
declare a public.portfolios%rowtype; r record; item record;
begin
 select * into a from public.portfolios where student_id=p_student for update;
 if not found then raise exception 'No portfolio found.'; end if;
 select * into r from public.order_reservations(p_student);
 if r.cash>a.cash then raise exception 'Not enough unreserved cash for these orders.'; end if;
 for item in select * from jsonb_each_text(r.shares) loop
 if item.value::numeric>coalesce((a.holdings->>item.key)::numeric,0) then raise exception 'Not enough unreserved shares of %.',item.key; end if;
 end loop;
end $$;

create or replace function public.order_ticket_action(p_actor uuid,p_action text,p_body jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='5s' as $$
declare t public.order_tickets%rowtype; a public.portfolios%rowtype; r record; result jsonb;
begin
 if not exists(select 1 from public.profiles where id=p_actor and role='student') then raise exception 'A student account is required.'; end if;
 select * into a from public.portfolios where student_id=p_actor for update;
 if not found then raise exception 'No portfolio found.'; end if;
 if p_action='submit' then
   select * into t from public.order_tickets where id=(p_body->>'id')::uuid;
   if found then
     if t.student_id<>p_actor or t.definition<>p_body->'definition' then raise exception 'This ticket ID has already been used.'; end if;
     return to_jsonb(t);
   end if;
   if (select count(*) from public.order_tickets where student_id=p_actor and status='open')>=50 then raise exception 'Cancel an open ticket before adding more (maximum 50).'; end if;
   insert into public.order_tickets(id,student_id,definition,state) values((p_body->>'id')::uuid,p_actor,p_body->'definition',p_body->'state') returning * into t;
   perform public.assert_order_capacity(p_actor);
   return to_jsonb(t);
 elsif p_action='cancel' then
   update public.order_tickets set status='cancelled',version=version+1,updated_at=now(),
   state=jsonb_set(state,'{legs}',(select jsonb_agg(case when l->>'status' in ('open','waiting') then l||'{"status":"cancelled"}'::jsonb else l end) from jsonb_array_elements(state->'legs') l))
   where id=(p_body->>'id')::uuid and student_id=p_actor and status='open';
 elsif p_action<>'list' then raise exception 'Unknown order action.';
 end if;
 select * into r from public.order_reservations(p_actor);
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (select * from public.order_tickets where student_id=p_actor order by created_at desc limit 100) x;
 return jsonb_build_object('tickets',result,'reserved_cash',r.cash,'reserved_shares',r.shares,'available_cash',a.cash-r.cash);
end $$;

-- A worker submits one evaluated state. The version, portfolio and stock locks
-- make retries, cancellation races and baskets atomic across all order routes.
create or replace function public.apply_order_evaluation(p_id uuid,p_version integer,p_state jsonb,p_fills jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='5s' as $$
declare t public.order_tickets%rowtype; f jsonb; s public.stocks%rowtype; receipts jsonb='[]'; receipt jsonb; actor uuid;
begin
 select student_id into actor from public.order_tickets where id=p_id;
 perform 1 from public.portfolios where student_id=actor for update;
 select * into t from public.order_tickets where id=p_id for update;
 if t.status<>'open' or t.version<>p_version then return jsonb_build_object('skipped',true); end if;
 perform 1 from public.stocks where ticker in(select value->>'ticker' from jsonb_array_elements(p_fills)) order by ticker for update;
 for f in select value from jsonb_array_elements(p_fills) loop
   if not exists(select 1 from jsonb_array_elements(t.state->'legs') l where l->>'id'=f->>'id' and l->>'status'='open' and l->>'ticker'=f->>'ticker' and l->>'action'=f->>'action' and l->>'shares'=f->>'shares') then raise exception 'Invalid order transition.'; end if;
   select * into s from public.stocks where ticker=f->>'ticker';
   if s.current_price<>(f->>'price')::numeric or s.is_overridden<>((f->>'source')='classroom') or (not s.is_overridden and s.last_updated<>(f->>'asOf')::timestamptz) then return jsonb_build_object('skipped',true); end if;
 end loop;
 -- Exclude this ticket's reservations while filling; other tickets remain protected.
 update public.order_tickets set status='completed' where id=p_id;
 begin
   for f in select value from jsonb_array_elements(p_fills) loop
     receipt:=public.execute_journaled_trade(actor,(f->>'id')::uuid,f->>'ticker',f->>'action',(f->>'shares')::integer,(f->>'price')::numeric,(f->>'asOf')::timestamptz,f->>'source',t.definition->>'rationale');
     receipts:=receipts||jsonb_build_array(receipt);
   end loop;
 exception when raise_exception then
   update public.order_tickets set status='rejected',message=sqlerrm,version=version+1,checked_at=now(),updated_at=now(),state=jsonb_set(t.state,'{legs}',(select jsonb_agg(case when l->>'status' in ('open','waiting') then l||'{"status":"rejected"}'::jsonb else l end) from jsonb_array_elements(t.state->'legs') l)) where id=p_id;
   return jsonb_build_object('rejected',true);
 end;
 update public.order_tickets set state=p_state,status=case when exists(select 1 from jsonb_array_elements(p_state->'legs') l where l->>'status' in ('open','waiting')) then 'open' else 'completed' end,
 version=version+1,checked_at=now(),updated_at=now() where id=p_id;
 begin
   perform public.assert_order_capacity(actor);
 exception when raise_exception then
   -- A filled parent remains filled; unfundable children are explicitly rejected.
   update public.order_tickets set status='rejected',message=sqlerrm,state=jsonb_set(state,'{legs}',(select jsonb_agg(case when l->>'status' in ('open','waiting') then l||'{"status":"rejected"}'::jsonb else l end) from jsonb_array_elements(state->'legs') l)) where id=p_id;
 end;
 return jsonb_build_object('receipts',receipts);
end $$;

create table if not exists public.market_api_slots(id bigint generated always as identity primary key,called_at timestamptz not null default clock_timestamp(),purpose text not null);
create index if not exists market_api_slots_time on public.market_api_slots(called_at);
alter table public.market_api_slots enable row level security;
revoke all on public.market_api_slots from public,anon,authenticated;
grant all on public.market_api_slots to service_role;
grant usage,select on sequence public.market_api_slots_id_seq to service_role;
create or replace function public.claim_market_api_slot(p_purpose text default 'interactive') returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer; bg integer;
begin
 perform pg_advisory_xact_lock(61104002);
 delete from public.market_api_slots where called_at<clock_timestamp()-interval '61 seconds';
 select count(*),count(*) filter(where purpose='monitor') into n,bg from public.market_api_slots where called_at>clock_timestamp()-interval '60 seconds';
 if n>=50 or (p_purpose='monitor' and bg>=20) then return false; end if;
 insert into public.market_api_slots(purpose) values(p_purpose); return true;
end $$;

create or replace function public.cancel_orders_on_reset() returns trigger language plpgsql set search_path='' as $$
begin
 if new.holdings='{}'::jsonb and new.cash=(select starting_cash from public.profiles where id=new.student_id) and current_setting('classroom.reset',true)='yes' then
 update public.order_tickets set status='cancelled',message='Portfolio reset by teacher.',version=version+1,updated_at=now(),state=jsonb_set(state,'{legs}',(select jsonb_agg(case when l->>'status' in ('open','waiting') then l||'{"status":"cancelled"}'::jsonb else l end) from jsonb_array_elements(state->'legs') l)) where student_id=new.student_id and status='open';
 end if; return new;
end $$;
drop trigger if exists orders_reset on public.portfolios;
create trigger orders_reset after update on public.portfolios for each row execute function public.cancel_orders_on_reset();
create or replace function public.reset_learning_history(p_student uuid) returns void language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(61104001);
 perform 1 from public.portfolios where student_id=p_student for update;
 perform set_config('classroom.reset','yes',true);
 update public.portfolios set cash=p.starting_cash,holdings='{}',updated_at=now() from public.profiles p where p.id=p_student and portfolios.student_id=p.id;
 perform set_config('classroom.reset','no',true);
 delete from public.portfolio_snapshots where student_id=p_student;
end $$;

revoke all on function public.order_reservations(uuid),public.assert_order_capacity(uuid),public.order_ticket_action(uuid,text,jsonb),public.apply_order_evaluation(uuid,integer,jsonb,jsonb),public.claim_market_api_slot(text),public.cancel_orders_on_reset() from public,anon,authenticated;
grant execute on function public.order_reservations(uuid),public.assert_order_capacity(uuid),public.order_ticket_action(uuid,text,jsonb),public.apply_order_evaluation(uuid,integer,jsonb,jsonb),public.claim_market_api_slot(text),public.cancel_orders_on_reset() to service_role;
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
  reserved record;
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
    select * into reserved from public.order_reservations(p_student_id);
    if p_action = 'buy' and total > account.cash - reserved.cash then raise exception 'Not enough cash to complete this trade.'; end if;
    if p_action = 'sell' and p_shares > owned - coalesce((reserved.shares ->> p_ticker)::bigint, 0) then raise exception 'Not enough shares to sell.'; end if;
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


commit;
