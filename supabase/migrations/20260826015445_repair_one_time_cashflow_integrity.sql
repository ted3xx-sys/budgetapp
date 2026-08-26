-- One-time cashflow is represented by a legacy source row plus one durable
-- occurrence. Keep those two writes in a single database transaction so a
-- Realtime refresh or network failure can never expose half of the mutation.

create or replace function public.save_one_time_bill(
  p_id text,
  p_user_id text,
  p_household_id uuid,
  p_name text,
  p_amount numeric,
  p_due_date date,
  p_category text default '',
  p_is_autodraft boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_saved boolean := false;
  saved_occurrence jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1
    from public.household_members as member
    where member.household_id = p_household_id
      and member.user_id = (select auth.uid())
  ) then
    raise exception 'Not authorized for this household' using errcode = '42501';
  end if;

  if nullif(btrim(p_id), '') is null
    or nullif(btrim(p_user_id), '') is null
    or nullif(btrim(p_name), '') is null
    or p_due_date is null
    or p_amount is null
    or p_amount < 0
    or p_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Invalid one-time bill' using errcode = '22023';
  end if;

  insert into public.bills as source (
    id, user_id, household_id, name, amount, is_recurring, recur_kind,
    due_day, due_date, category, is_autodraft, archived_at
  )
  values (
    p_id, p_user_id, p_household_id, btrim(p_name), p_amount, false,
    'monthly', 1, p_due_date::text, coalesce(p_category, ''),
    coalesce(p_is_autodraft, false), null
  )
  on conflict (id) do update
  set
    name = excluded.name,
    amount = excluded.amount,
    is_recurring = false,
    recur_kind = 'monthly',
    due_day = 1,
    due_date = excluded.due_date,
    category = excluded.category,
    is_autodraft = excluded.is_autodraft,
    archived_at = null
  where source.user_id = excluded.user_id
    and source.household_id = excluded.household_id
  returning true into source_saved;

  if not source_saved then
    raise exception 'Bill ID belongs to another household' using errcode = '23505';
  end if;

  insert into public.cashflow_occurrences as occurrence (
    household_id, direction, source_kind, source_id, scheduled_on, label,
    category, expected_amount, actual_amount, status, settled_at,
    is_inferred, is_adjusted, is_autodraft
  )
  values (
    p_household_id, 'expense', 'one_time_bill', p_id, p_due_date,
    btrim(p_name), coalesce(p_category, ''), p_amount, null, 'planned', null,
    false, false, coalesce(p_is_autodraft, false)
  )
  on conflict on constraint cashflow_occurrences_source_date_key do update
  set
    label = excluded.label,
    category = excluded.category,
    expected_amount = excluded.expected_amount,
    status = 'planned',
    actual_amount = null,
    settled_at = null,
    is_inferred = false,
    is_autodraft = excluded.is_autodraft
  where occurrence.status <> 'settled'
  returning to_jsonb(occurrence) into saved_occurrence;

  if saved_occurrence is null then
    select to_jsonb(occurrence)
    into saved_occurrence
    from public.cashflow_occurrences as occurrence
    where occurrence.household_id = p_household_id
      and occurrence.direction = 'expense'
      and occurrence.source_kind = 'one_time_bill'
      and occurrence.source_id = p_id
      and occurrence.scheduled_on = p_due_date;
  end if;

  return saved_occurrence;
end;
$$;

create or replace function public.save_one_time_payment(
  p_id text,
  p_user_id text,
  p_household_id uuid,
  p_name text,
  p_amount numeric,
  p_payment_date date
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_saved boolean := false;
  saved_occurrence jsonb;
begin
  if (select auth.uid()) is null or not exists (
    select 1
    from public.household_members as member
    where member.household_id = p_household_id
      and member.user_id = (select auth.uid())
  ) then
    raise exception 'Not authorized for this household' using errcode = '42501';
  end if;

  if nullif(btrim(p_id), '') is null
    or nullif(btrim(p_user_id), '') is null
    or nullif(btrim(p_name), '') is null
    or p_payment_date is null
    or p_amount is null
    or p_amount < 0
    or p_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Invalid one-time payment' using errcode = '22023';
  end if;

  insert into public.one_time_payments as source (
    id, user_id, household_id, name, amount, payment_date, archived_at
  )
  values (
    p_id, p_user_id, p_household_id, btrim(p_name), p_amount,
    p_payment_date, null
  )
  on conflict (id) do update
  set
    name = excluded.name,
    amount = excluded.amount,
    payment_date = excluded.payment_date,
    archived_at = null
  where source.user_id = excluded.user_id
    and source.household_id = excluded.household_id
  returning true into source_saved;

  if not source_saved then
    raise exception 'Payment ID belongs to another household' using errcode = '23505';
  end if;

  insert into public.cashflow_occurrences as occurrence (
    household_id, direction, source_kind, source_id, scheduled_on, label,
    category, expected_amount, actual_amount, status, settled_at,
    is_inferred, is_adjusted, is_autodraft
  )
  values (
    p_household_id, 'income', 'one_time_income', p_id, p_payment_date,
    btrim(p_name), '', p_amount, null, 'planned', null, false, false, false
  )
  on conflict on constraint cashflow_occurrences_source_date_key do update
  set
    label = excluded.label,
    category = '',
    expected_amount = excluded.expected_amount,
    status = 'planned',
    actual_amount = null,
    settled_at = null,
    is_inferred = false
  where occurrence.status <> 'settled'
  returning to_jsonb(occurrence) into saved_occurrence;

  if saved_occurrence is null then
    select to_jsonb(occurrence)
    into saved_occurrence
    from public.cashflow_occurrences as occurrence
    where occurrence.household_id = p_household_id
      and occurrence.direction = 'income'
      and occurrence.source_kind = 'one_time_income'
      and occurrence.source_id = p_id
      and occurrence.scheduled_on = p_payment_date;
  end if;

  return saved_occurrence;
end;
$$;

create or replace function public.update_one_time_occurrence(
  p_occurrence_id uuid,
  p_name text,
  p_amount numeric,
  p_date date,
  p_category text default '',
  p_is_autodraft boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.cashflow_occurrences%rowtype;
  source_saved boolean := false;
  saved_occurrence jsonb;
begin
  if nullif(btrim(p_name), '') is null
    or p_date is null
    or p_amount is null
    or p_amount < 0
    or p_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Invalid one-time occurrence update' using errcode = '22023';
  end if;

  select occurrence.*
  into target
  from public.cashflow_occurrences as occurrence
  where occurrence.id = p_occurrence_id
  for update;

  if not found then
    raise exception 'One-time occurrence not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.household_members as member
    where member.household_id = target.household_id
      and member.user_id = (select auth.uid())
  ) then
    raise exception 'Not authorized for this household' using errcode = '42501';
  end if;

  if target.status = 'settled' then
    raise exception 'Settled one-time occurrences cannot be edited' using errcode = '22023';
  end if;

  if target.source_kind = 'one_time_bill' then
    update public.bills as source
    set
      name = btrim(p_name),
      amount = p_amount,
      due_date = p_date::text,
      category = coalesce(p_category, ''),
      is_autodraft = coalesce(p_is_autodraft, false)
    where source.id = target.source_id
      and source.household_id = target.household_id
      and not source.is_recurring
      and source.archived_at is null
    returning true into source_saved;
  elsif target.source_kind = 'one_time_income' then
    update public.one_time_payments as source
    set
      name = btrim(p_name),
      amount = p_amount,
      payment_date = p_date
    where source.id = target.source_id
      and source.household_id = target.household_id
      and source.archived_at is null
    returning true into source_saved;
  else
    raise exception 'Occurrence is not one-time' using errcode = '22023';
  end if;

  if not source_saved then
    raise exception 'Active one-time source not found' using errcode = 'P0002';
  end if;

  update public.cashflow_occurrences as occurrence
  set
    scheduled_on = p_date,
    label = btrim(p_name),
    expected_amount = p_amount,
    actual_amount = null,
    status = 'planned',
    settled_at = null,
    category = case
      when target.source_kind = 'one_time_bill' then coalesce(p_category, '')
      else ''
    end,
    is_autodraft = case
      when target.source_kind = 'one_time_bill' then coalesce(p_is_autodraft, false)
      else false
    end,
    is_adjusted = true,
    is_inferred = false
  where occurrence.id = target.id
  returning to_jsonb(occurrence) into saved_occurrence;

  return saved_occurrence;
end;
$$;

create or replace function private.remove_one_time_occurrence(
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.cashflow_occurrences%rowtype;
  deleted_count integer := 0;
begin
  select occurrence.*
  into target
  from public.cashflow_occurrences as occurrence
  where occurrence.id = p_occurrence_id
  for update;

  if not found then
    raise exception 'One-time occurrence not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.household_members as member
    where member.household_id = target.household_id
      and member.user_id = (select auth.uid())
  ) then
    raise exception 'Not authorized for this household' using errcode = '42501';
  end if;

  if target.source_kind not in ('one_time_bill', 'one_time_income')
    or target.status = 'settled' then
    raise exception 'Only open one-time occurrences can be removed' using errcode = '22023';
  end if;

  if target.source_kind = 'one_time_bill' then
    update public.bills as source
    set archived_at = coalesce(source.archived_at, now())
    where source.id = target.source_id
      and source.household_id = target.household_id
      and not source.is_recurring;
  else
    update public.one_time_payments as source
    set archived_at = coalesce(source.archived_at, now())
    where source.id = target.source_id
      and source.household_id = target.household_id;
  end if;

  delete from public.cashflow_occurrences as occurrence
  where occurrence.household_id = target.household_id
    and occurrence.source_kind = target.source_kind
    and occurrence.source_id = target.source_id
    and occurrence.status in ('planned', 'skipped');

  get diagnostics deleted_count = row_count;

  return jsonb_build_object(
    'sourceKind', target.source_kind,
    'sourceId', target.source_id,
    'deletedCount', deleted_count
  );
end;
$$;

create or replace function public.remove_one_time_occurrence(
  p_occurrence_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.remove_one_time_occurrence(p_occurrence_id);
$$;

revoke all on function public.save_one_time_bill(text, text, uuid, text, numeric, date, text, boolean) from public, anon, authenticated;
revoke all on function public.save_one_time_payment(text, text, uuid, text, numeric, date) from public, anon, authenticated;
revoke all on function public.update_one_time_occurrence(uuid, text, numeric, date, text, boolean) from public, anon, authenticated;
revoke all on function public.remove_one_time_occurrence(uuid) from public, anon, authenticated;
revoke all on function private.remove_one_time_occurrence(uuid) from public, anon, authenticated;

grant execute on function public.save_one_time_bill(text, text, uuid, text, numeric, date, text, boolean) to authenticated;
grant execute on function public.save_one_time_payment(text, text, uuid, text, numeric, date) to authenticated;
grant execute on function public.update_one_time_occurrence(uuid, text, numeric, date, text, boolean) to authenticated;
grant execute on function public.remove_one_time_occurrence(uuid) to authenticated;
grant execute on function private.remove_one_time_occurrence(uuid) to authenticated;

-- Removal now goes through the membership-checked private function. The
-- authenticated role no longer needs direct DELETE access to the ledger.
drop policy if exists cashflow_occurrences_delete_one_time_for_members
on public.cashflow_occurrences;
revoke delete on table public.cashflow_occurrences from anon, authenticated;

-- Remove only open occurrence rows that no longer have an exact active source.
-- Settled rows remain immutable financial history. This also clears the known
-- orphan left when the old two-step removal failed between its two requests.
delete from public.cashflow_occurrences as occurrence
where occurrence.status in ('planned', 'skipped')
  and (
    (
      occurrence.source_kind = 'one_time_income'
      and not exists (
        select 1
        from public.one_time_payments as payment
        where payment.household_id = occurrence.household_id
          and payment.id = occurrence.source_id
          and payment.archived_at is null
          and payment.payment_date = occurrence.scheduled_on
      )
    )
    or (
      occurrence.source_kind = 'one_time_bill'
      and not exists (
        select 1
        from public.bills as bill
        where bill.household_id = occurrence.household_id
          and bill.id = occurrence.source_id
          and bill.archived_at is null
          and not bill.is_recurring
          and private.legacy_date_suffix(bill.due_date) = occurrence.scheduled_on
      )
    )
  );

-- Rebuild every active source, including overdue dates. Existing settled rows
-- are preserved; a formerly skipped active one-time item becomes planned again.
insert into public.cashflow_occurrences as occurrence (
  household_id, direction, source_kind, source_id, scheduled_on, label,
  category, expected_amount, status, is_inferred, is_adjusted, is_autodraft
)
select
  payment.household_id,
  'income',
  'one_time_income',
  payment.id,
  payment.payment_date,
  coalesce(nullif(btrim(payment.name), ''), 'One-time payment'),
  '',
  greatest(coalesce(payment.amount, 0), 0),
  'planned',
  false,
  false,
  false
from public.one_time_payments as payment
where payment.archived_at is null
on conflict on constraint cashflow_occurrences_source_date_key do update
set
  label = excluded.label,
  expected_amount = excluded.expected_amount,
  status = 'planned',
  actual_amount = null,
  settled_at = null,
  is_inferred = false
where occurrence.status <> 'settled';

insert into public.cashflow_occurrences as occurrence (
  household_id, direction, source_kind, source_id, scheduled_on, label,
  category, expected_amount, status, is_inferred, is_adjusted, is_autodraft
)
select
  bill.household_id,
  'expense',
  'one_time_bill',
  bill.id,
  private.legacy_date_suffix(bill.due_date),
  coalesce(nullif(btrim(bill.name), ''), 'One-time bill'),
  coalesce(bill.category, ''),
  greatest(coalesce(bill.amount, 0), 0),
  'planned',
  false,
  false,
  coalesce(bill.is_autodraft, false)
from public.bills as bill
where bill.archived_at is null
  and not bill.is_recurring
  and private.legacy_date_suffix(bill.due_date) is not null
on conflict on constraint cashflow_occurrences_source_date_key do update
set
  label = excluded.label,
  category = excluded.category,
  expected_amount = excluded.expected_amount,
  status = 'planned',
  actual_amount = null,
  settled_at = null,
  is_inferred = false,
  is_autodraft = excluded.is_autodraft
where occurrence.status <> 'settled';

notify pgrst, 'reload schema';
