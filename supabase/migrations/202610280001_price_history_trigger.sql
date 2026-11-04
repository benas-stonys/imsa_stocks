-- Trades use an empty search_path; triggers must qualify their table references.
create or replace function public.log_price_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.price_history (ticker, price)
    values (new.ticker, new.current_price);
  return new;
end;
$$;
