-- Repair accounts that were created without a portfolio. Never reset an existing
-- portfolio or infer a balance for a student who already has trading history.
insert into public.portfolios (student_id, cash, holdings)
select p.id, p.starting_cash, '{}'::jsonb
from public.profiles p
where p.role = 'student'
  and p.starting_cash >= 0
  and p.starting_cash::text not in ('NaN', 'Infinity', '-Infinity')
  and not exists (select 1 from public.portfolios f where f.student_id = p.id)
  and not exists (select 1 from public.transactions t where t.student_id = p.id)
on conflict (student_id) do nothing;
