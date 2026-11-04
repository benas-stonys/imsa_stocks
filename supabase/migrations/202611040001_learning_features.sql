begin;

alter table public.stocks add column if not exists price_checked_at timestamptz;

create table if not exists public.trade_journals (
  transaction_id uuid primary key references public.transactions(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  rationale text not null default '' check (length(rationale) <= 2000),
  reflection text not null default '' check (length(reflection) <= 4000),
  feedback text not null default '' check (length(feedback) <= 4000)
);
create table if not exists public.watchlists (
  student_id uuid not null references public.profiles(id) on delete cascade,
  ticker text not null references public.stocks(ticker),
  primary key(student_id,ticker)
);
create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  ticker text not null references public.stocks(ticker),
  direction text not null check(direction in ('above','below')),
  target numeric not null check(target >= 0.01 and target <= 1000000000),
  created_at timestamptz not null default now(),
  triggered_at timestamptz,
  triggered_price numeric,
  acknowledged boolean not null default false
);
create index if not exists price_alerts_student_idx on public.price_alerts(student_id);
create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  title text not null check(length(title) between 1 and 120),
  instructions text not null check(length(instructions) between 1 and 6000),
  due_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  archived boolean not null default false
);
create table if not exists public.assignment_submissions (
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  response text not null check(length(response) between 1 and 10000),
  submitted_at timestamptz not null default now(),
  feedback text not null default '' check(length(feedback) <= 4000),
  reviewed_at timestamptz,
  primary key(assignment_id,student_id)
);
create table if not exists public.portfolio_snapshots (
  student_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  captured_at timestamptz not null,
  cash numeric not null,
  total_value numeric not null,
  benchmark_price numeric,
  benchmark_as_of timestamptz,
  contains_simulated boolean not null default false,
  primary key(student_id,day)
);
create table if not exists public.price_scenarios (
  id uuid primary key default gen_random_uuid(),
  ticker text not null references public.stocks(ticker),
  title text not null check(length(title) between 1 and 120),
  kind text not null check(kind in ('jump','linear')),
  start_price numeric not null check(start_price > 0),
  target_price numeric not null check(target_price >= .01 and target_price <= 1000000000),
  starts_at timestamptz not null,
  ends_at timestamptz not null check(ends_at >= starts_at),
  status text not null default 'scheduled' check(status in ('scheduled','active','completed','cancelled')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create unique index if not exists one_live_scenario_per_stock on public.price_scenarios(ticker) where status in ('scheduled','active');
create table if not exists public.classroom_price_history (
  ticker text not null references public.stocks(ticker),
  recorded_at timestamptz not null default now(),
  price numeric not null check(price > 0),
  primary key(ticker,recorded_at)
);

-- All new data is accessed through authenticated server endpoints, never browser writes.
do $$ declare tbl text; begin
  foreach tbl in array array['trade_journals','watchlists','price_alerts','assignments','assignment_submissions','portfolio_snapshots','price_scenarios','classroom_price_history'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from public, anon, authenticated',tbl);
    execute format('grant select,insert,update,delete on public.%I to service_role',tbl);
  end loop;
end $$;

-- Capture every changed classroom execution price, including manual overrides.
create or replace function public.record_classroom_price() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_overridden then
    insert into public.classroom_price_history(ticker,price) values(new.ticker,new.current_price)
      on conflict(ticker,recorded_at) do update set price=excluded.price;
    -- A new manual override cancels a pending scenario. The scenario worker marks its own updates.
    if coalesce(current_setting('classroom.scenario_update',true),'') <> 'yes' then
      update public.price_scenarios set status='cancelled' where ticker=new.ticker and status in ('scheduled','active');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists classroom_price_capture on public.stocks;
create trigger classroom_price_capture after insert or update of current_price,is_overridden on public.stocks
for each row execute function public.record_classroom_price();
insert into public.classroom_price_history(ticker,price) select ticker,current_price from public.stocks where is_overridden
  and not exists(select 1 from public.classroom_price_history h where h.ticker=stocks.ticker);

-- Journal creation and the money movement commit together; retries cannot overwrite the original rationale.
create or replace function public.execute_journaled_trade(
  p_student_id uuid, p_request_id uuid, p_ticker text, p_action text,
  p_shares integer, p_price numeric, p_quote_as_of timestamptz, p_price_source text, p_rationale text default ''
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if p_rationale is null or length(p_rationale)>2000 then raise exception 'Trade rationale must be at most 2,000 characters.'; end if;
  result := public.execute_market_trade(p_student_id,p_request_id,p_ticker,p_action,p_shares,p_price,p_quote_as_of,p_price_source);
  insert into public.trade_journals(transaction_id,student_id,rationale)
    values((result->>'id')::uuid,p_student_id,p_rationale) on conflict do nothing;
  return result;
end $$;

-- Hourly, idempotent processing. Prices are discrete hourly steps, not continuous or invented candles.
create or replace function public.refresh_learning_data(p_benchmark numeric default null, p_benchmark_as_of timestamptz default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare scenario_row public.price_scenarios%rowtype; price numeric;
begin
  perform pg_advisory_xact_lock(61104001);
  perform set_config('classroom.scenario_update','yes',true);
  -- Always lock stocks before scenarios, matching manual override writes.
  perform 1 from public.stocks where ticker in (select ticker from public.price_scenarios where status in ('scheduled','active')) order by ticker for update;
  for scenario_row in select * from public.price_scenarios where status in ('scheduled','active') and starts_at<=now() for update loop
    if scenario_row.kind='jump' or now()>=scenario_row.ends_at then price:=scenario_row.target_price;
    else price:=round(scenario_row.start_price+(scenario_row.target_price-scenario_row.start_price)*extract(epoch from(now()-scenario_row.starts_at))/nullif(extract(epoch from(scenario_row.ends_at-scenario_row.starts_at)),0),4); end if;
    update public.stocks set current_price=price,last_updated=now() where ticker=scenario_row.ticker and is_overridden;
    update public.price_scenarios set status=case when scenario_row.kind='jump' or now()>=scenario_row.ends_at then 'completed' else 'active' end where id=scenario_row.id;
  end loop;
  perform set_config('classroom.scenario_update','no',true);
  update public.price_alerts a set triggered_at=now(),triggered_price=s.current_price
    from public.stocks s where a.ticker=s.ticker and a.triggered_at is null
    and (s.is_overridden or s.last_updated>=a.created_at)
    and ((a.direction='above' and s.current_price>=a.target) or (a.direction='below' and s.current_price<=a.target));
  insert into public.portfolio_snapshots(student_id,day,captured_at,cash,total_value,benchmark_price,benchmark_as_of,contains_simulated)
    select p.student_id,(now() at time zone 'America/New_York')::date,now(),p.cash,
      round(p.cash+coalesce(sum(h.value::numeric*s.current_price),0),2),
      case when p_benchmark>0 and p_benchmark_as_of>=now()-interval '7 days' and p_benchmark_as_of<=now()+interval '5 minutes' then p_benchmark end,
      case when p_benchmark>0 and p_benchmark_as_of>=now()-interval '7 days' and p_benchmark_as_of<=now()+interval '5 minutes' then p_benchmark_as_of end,
      coalesce(bool_or(s.is_overridden),false)
    from public.portfolios p join public.profiles pr on pr.id=p.student_id and pr.role='student'
    left join lateral jsonb_each_text(p.holdings) h on true left join public.stocks s on s.ticker=h.key
    group by p.student_id,p.cash
    -- Missing prices must not turn investments into zero-dollar holdings.
    having count(h.key)=count(s.ticker)
    on conflict(student_id,day) do update set captured_at=excluded.captured_at,cash=excluded.cash,total_value=excluded.total_value,
      benchmark_price=excluded.benchmark_price,benchmark_as_of=excluded.benchmark_as_of,contains_simulated=excluded.contains_simulated;
end $$;

-- The API supplies actor from a verified session, not from the request body.
create or replace function public.classroom_action(p_actor uuid,p_action text,p_body jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare actor_role text; symbol text; tid uuid; aid uuid; target_student uuid; stock_row public.stocks%rowtype;
  start_time timestamptz; end_time timestamptz; n numeric; page_number integer;
begin
  select role into actor_role from public.profiles where id=p_actor for update;
  if actor_role is null then raise exception 'Account not found.'; end if;
  if p_action='load' then
    return jsonb_build_object(
      'watchlist',coalesce((select jsonb_agg(to_jsonb(s) order by s.ticker) from public.watchlists w join public.stocks s on s.ticker=w.ticker where w.student_id=p_actor),'[]'),
      'alerts',coalesce((select jsonb_agg(a order by a.created_at desc) from public.price_alerts a where a.student_id=p_actor),'[]'),
      'snapshots',coalesce((select jsonb_agg(x order by x.day) from (select * from public.portfolio_snapshots where student_id=p_actor order by day desc limit 1826) x),'[]'),
      'assignments',coalesce((select jsonb_agg(x order by x.created_at desc) from (select a.*,sub.response,sub.feedback,sub.submitted_at,sub.reviewed_at,
        (select count(*) from public.assignment_submissions ss where ss.assignment_id=a.id) as submitted_count
        from public.assignments a left join public.assignment_submissions sub on sub.assignment_id=a.id and sub.student_id=p_actor
        where not a.archived order by a.created_at desc limit 100) x),'[]'),
      'scenarios',case when actor_role='admin' then coalesce((select jsonb_agg(x order by x.created_at desc) from (select * from public.price_scenarios order by created_at desc limit 100) x),'[]') else '[]'::jsonb end);
  elsif p_action='journal.list' then
    page_number:=coalesce((p_body->>'page')::integer,0);
    if page_number<0 or page_number>100000 then raise exception 'Invalid page.'; end if;
    target_student:=case when actor_role='admin' then nullif(p_body->>'student_id','')::uuid else p_actor end;
    return jsonb_build_object('rows',coalesce((select jsonb_agg(x order by x.timestamp desc,x.id desc) from (
      select t.id,t.student_id,t.ticker,t.action,t.shares,t.price,t.timestamp,p.username,coalesce(j.rationale,'') rationale,coalesce(j.reflection,'') reflection,coalesce(j.feedback,'') feedback
      from public.transactions t join public.profiles p on p.id=t.student_id left join public.trade_journals j on j.transaction_id=t.id
      where target_student is null or t.student_id=target_student order by t.timestamp desc,t.id desc limit 25 offset page_number*25) x),'[]'));
  elsif p_action in ('journal.reflect','journal.feedback') then
    tid:=(p_body->>'id')::uuid;
    select student_id into target_student from public.transactions where id=tid;
    if target_student is null or (p_action='journal.reflect' and (actor_role<>'student' or target_student<>p_actor))
      or (p_action='journal.feedback' and actor_role<>'admin') then raise exception 'You cannot edit this journal.'; end if;
    if length(coalesce(p_body->>'text',''))>4000 then raise exception 'Keep notes under 4,000 characters.'; end if;
    insert into public.trade_journals(transaction_id,student_id) values(tid,target_student) on conflict do nothing;
    if p_action='journal.reflect' then update public.trade_journals set reflection=coalesce(p_body->>'text','') where transaction_id=tid;
    else update public.trade_journals set feedback=coalesce(p_body->>'text','') where transaction_id=tid; end if;
  elsif p_action in ('watch.add','watch.remove','alert.add','alert.remove','alert.ack') then
    if actor_role<>'student' then raise exception 'Student access required.'; end if;
    symbol:=p_body->>'ticker';
    if p_action='watch.add' then
      if (select count(*) from public.watchlists where student_id=p_actor)>=50 then raise exception 'Your watchlist holds up to 50 stocks.'; end if;
      insert into public.watchlists values(p_actor,symbol) on conflict do nothing;
    elsif p_action='watch.remove' then delete from public.watchlists where student_id=p_actor and ticker=symbol;
    elsif p_action='alert.add' then
      if (select count(*) from public.price_alerts where student_id=p_actor)>=100 then raise exception 'Remove an old alert first (100 maximum).'; end if;
      insert into public.price_alerts(student_id,ticker,direction,target) values(p_actor,symbol,p_body->>'direction',(p_body->>'target')::numeric);
    elsif p_action='alert.remove' then delete from public.price_alerts where id=(p_body->>'id')::uuid and student_id=p_actor;
    else update public.price_alerts set acknowledged=true where id=(p_body->>'id')::uuid and student_id=p_actor; end if;
  elsif p_action='assignment.submit' then
    if actor_role<>'student' then raise exception 'Student access required.'; end if;
    aid:=(p_body->>'id')::uuid;
    perform 1 from public.assignments where id=aid and not archived for share;
    if not found then raise exception 'This assignment is closed.'; end if;
    insert into public.assignment_submissions(assignment_id,student_id,response) values(aid,p_actor,btrim(p_body->>'text'))
    on conflict(assignment_id,student_id) do update set response=excluded.response,submitted_at=now(),feedback='',reviewed_at=null;
  elsif actor_role<>'admin' then raise exception 'Administrator access required.';
  elsif p_action='assignment.create' then
    if (select count(*) from public.assignments where not archived)>=100 then raise exception 'Archive an assignment first (100 active maximum).'; end if;
    insert into public.assignments(title,instructions,due_at,created_by) values(btrim(p_body->>'title'),btrim(p_body->>'instructions'),nullif(p_body->>'due_at','')::timestamptz,p_actor);
  elsif p_action='assignment.archive' then update public.assignments set archived=true where id=(p_body->>'id')::uuid;
  elsif p_action='assignment.review' then
    return jsonb_build_object('rows',coalesce((select jsonb_agg(x order by x.username) from (
      select p.id student_id,p.username,s.response,s.submitted_at,s.feedback,s.reviewed_at
      from public.profiles p left join public.assignment_submissions s on s.student_id=p.id and s.assignment_id=(p_body->>'id')::uuid
      where p.role='student') x),'[]'));
  elsif p_action='assignment.feedback' then
    update public.assignment_submissions set feedback=coalesce(p_body->>'text',''),reviewed_at=now()
      where assignment_id=(p_body->>'id')::uuid and student_id=(p_body->>'student_id')::uuid;
    if not found then raise exception 'Submission not found.'; end if;
  elsif p_action='scenario.create' then
    symbol:=p_body->>'ticker';
    select * into stock_row from public.stocks where ticker=symbol for update;
    if not found or not stock_row.is_overridden then raise exception 'Set a classroom price override for this stock first.'; end if;
    start_time:=(p_body->>'starts_at')::timestamptz; end_time:=(p_body->>'ends_at')::timestamptz;
    if start_time<now()-interval '1 minute' or start_time>now()+interval '1 year' or end_time>start_time+interval '1 year'
      or (p_body->>'kind'='linear' and end_time<start_time+interval '1 hour') then raise exception 'Choose a future start and at least one hour for a gradual move (maximum one year).'; end if;
    insert into public.price_scenarios(ticker,title,kind,start_price,target_price,starts_at,ends_at,created_by)
      values(symbol,btrim(p_body->>'title'),p_body->>'kind',stock_row.current_price,(p_body->>'target_price')::numeric,start_time,end_time,p_actor);
  elsif p_action='scenario.cancel' then
    -- Lock order matches the worker and manual overrides.
    perform 1 from public.stocks where ticker=(select ticker from public.price_scenarios where id=(p_body->>'id')::uuid) for update;
    update public.price_scenarios set status='cancelled' where id=(p_body->>'id')::uuid and status in ('scheduled','active');
  else raise exception 'Unknown action.';
  end if;
  return '{"ok":true}'::jsonb;
end $$;

-- Reset only the performance timeline when a teacher resets the account; keep audit history.
create or replace function public.reset_learning_history(p_student uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(61104001);
  perform 1 from public.portfolios where student_id=p_student for update;
  update public.portfolios set cash=p.starting_cash,holdings='{}',updated_at=now() from public.profiles p where p.id=p_student and portfolios.student_id=p.id;
  delete from public.portfolio_snapshots where student_id=p_student;
end $$;

revoke all on function public.execute_journaled_trade(uuid,uuid,text,text,integer,numeric,timestamptz,text,text),
  public.classroom_action(uuid,text,jsonb),public.refresh_learning_data(numeric,timestamptz),public.reset_learning_history(uuid) from public,anon,authenticated;
grant execute on function public.execute_journaled_trade(uuid,uuid,text,text,integer,numeric,timestamptz,text,text),
  public.classroom_action(uuid,text,jsonb),public.refresh_learning_data(numeric,timestamptz),public.reset_learning_history(uuid) to service_role;
commit;
