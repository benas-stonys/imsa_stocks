-- Supabase schema for Classroom Trading Simulator

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  role text not null check (role in ('student', 'admin')),
  starting_cash numeric not null default 10000,
  created_at timestamptz not null default now()
);

create table portfolios (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references profiles(id) on delete cascade,
  cash numeric not null default 10000,
  holdings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (student_id)
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references profiles(id) on delete cascade,
  ticker text not null,
  action text not null check (action in ('buy', 'sell')),
  shares int not null,
  price numeric not null,
  timestamp timestamptz not null default now()
);

create table stocks (
  ticker text primary key,
  name text not null,
  current_price numeric not null,
  prev_close numeric not null,
  last_updated timestamptz not null default now(),
  is_overridden boolean not null default false
);

-- Sample data
insert into stocks (ticker, name, current_price, prev_close, last_updated) values
('AAPL', 'Apple Inc.', 175, 174.2, now()),
('MSFT', 'Microsoft Corporation', 380, 377.8, now()),
('TSLA', 'Tesla, Inc.', 245, 242.5, now()),
('AMZN', 'Amazon.com, Inc.', 165, 163.5, now());
