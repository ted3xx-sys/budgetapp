begin;

select plan(42);

select has_table('public', 'households', 'households table exists');
select has_table('public', 'household_members', 'household_members table exists');
select has_table('public', 'income_sources', 'income_sources table exists');
select has_table('public', 'cashflow_occurrences', 'cashflow_occurrences table exists');
select has_table('public', 'balance_snapshots', 'balance_snapshots table exists');

select is(
  (
    select count(*)
    from pg_class
    where oid in (
      'public.households'::regclass,
      'public.household_members'::regclass,
      'public.income_sources'::regclass,
      'public.cashflow_occurrences'::regclass,
      'public.balance_snapshots'::regclass
    )
      and relrowsecurity
  ),
  5::bigint,
  'RLS is enabled on every new public table'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.cashflow_occurrences'::regclass
      and conname = 'cashflow_occurrences_source_date_key'
      and contype = 'u'
  ),
  'cashflow occurrence source/date identity is enforced'
);

select ok(
  exists (
    select 1
    from pg_attribute as attribute
    join pg_attrdef as default_value
      on default_value.adrelid = attribute.attrelid
     and default_value.adnum = attribute.attnum
    where attribute.attrelid = 'public.cashflow_occurrences'::regclass
      and attribute.attname = 'is_adjusted'
      and attribute.attnotnull
      and position('false' in pg_get_expr(default_value.adbin, default_value.adrelid)) > 0
  ),
  'is_adjusted is non-null and defaults false'
);

select ok(
  exists (
    select 1
    from pg_attribute
    where attrelid = 'public.cashflow_occurrences'::regclass
      and attname = 'source_id'
      and attnotnull
  ),
  'source_id is required for idempotent materialization'
);

select is(
  (
    select count(*)
    from pg_constraint
    where conname in (
      'households_reserve_floor_nonnegative',
      'income_sources_amount_nonnegative',
      'cashflow_occurrences_expected_amount_nonnegative',
      'cashflow_occurrences_actual_amount_nonnegative',
      'balance_snapshots_amount_finite'
    )
      and position('Infinity' in pg_get_constraintdef(oid)) > 0
  ),
  5::bigint,
  'new finance-table money constraints reject non-finite numeric values'
);

select has_index(
  'public',
  'balance_snapshots',
  'balance_snapshots_created_by_idx',
  'balance snapshot creator foreign key has a supporting index'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'households',
        'household_members',
        'income_sources',
        'cashflow_occurrences',
        'balance_snapshots'
      )
  ),
  11::bigint,
  'expected household RLS policies exist'
);

select ok(
  has_table_privilege('authenticated', 'public.cashflow_occurrences', 'SELECT')
  and has_table_privilege('authenticated', 'public.cashflow_occurrences', 'INSERT')
  and has_table_privilege('authenticated', 'public.cashflow_occurrences', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.cashflow_occurrences', 'DELETE'),
  'occurrences are writable but not client-deletable'
);

select ok(
  has_table_privilege('authenticated', 'public.balance_snapshots', 'SELECT')
  and has_table_privilege('authenticated', 'public.balance_snapshots', 'INSERT')
  and not has_table_privilege('authenticated', 'public.balance_snapshots', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.balance_snapshots', 'DELETE'),
  'balance snapshots are append-only for clients'
);

select ok(
  not has_table_privilege('anon', 'public.households', 'SELECT')
  and not has_table_privilege('anon', 'public.income_sources', 'SELECT')
  and not has_table_privilege('anon', 'public.cashflow_occurrences', 'SELECT')
  and not has_table_privilege('anon', 'public.balance_snapshots', 'SELECT'),
  'anonymous clients cannot read household finance data'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('settings'),
        ('bills'),
        ('one_time_payments'),
        ('meals'),
        ('shared_lists'),
        ('shared_list_items')
    ) as protected(tablename)
    cross join lateral (
      select to_regclass(format('public.%I', protected.tablename)) as relation
    ) as resolved
    where resolved.relation is not null
      and has_table_privilege(
        'authenticated', resolved.relation, 'DELETE'
      )
  ),
  'browser clients cannot physically delete shared source or planning rows'
);

select ok(
  exists (
    select 1
    from pg_proc
    join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
    where pg_namespace.nspname = 'private'
      and pg_proc.proname = 'current_household_ids'
      and pg_proc.prosecdef
      and 'search_path=""' = any(pg_proc.proconfig)
  ),
  'membership helper is security-definer with a pinned empty search_path'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'private.materialize_income_occurrences(uuid,date,date,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.materialize_legacy_bill_occurrences(uuid,date,date,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.reconcile_legacy_finance_cutover(uuid,text,date)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.legacy_date_suffix(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.legacy_nonnegative_amount(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.normalize_cashflow_occurrence()',
    'EXECUTE'
  )
  and exists (
    select 1
    from pg_proc
    join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
    where pg_namespace.nspname = 'private'
      and pg_proc.proname = 'reconcile_legacy_finance_cutover'
      and pg_proc.prosecdef
      and 'search_path=""' = any(pg_proc.proconfig)
  ),
  'backfill helpers are hardened and not exposed to the client role'
);

select is(
  private.legacy_date_suffix('bill-with-hyphens-2026-02-28'),
  date '2026-02-28',
  'legacy date parser reads a valid trailing ISO date'
);

select is(
  private.legacy_date_suffix('bill-with-hyphens-2026-02-31'),
  null::date,
  'legacy date parser rejects impossible calendar dates safely'
);

select is(
  private.legacy_nonnegative_amount('-5.00'),
  null::numeric,
  'legacy amount parser rejects negative values safely'
);

select ok(
  private.legacy_nonnegative_amount('NaN') is null
  and private.legacy_nonnegative_amount('Infinity') is null
  and private.legacy_nonnegative_amount('-Infinity') is null,
  'legacy amount parser rejects every non-finite numeric value'
);

select ok(
  exists (
    select 1
    from public.households
    where id = '00000000-0000-0000-0000-000000000000'::uuid
  ),
  'stable GHP household is bootstrapped'
);

insert into public.households (id, name, timezone, cycle_days)
values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'Weekly Test', 'America/Chicago', 14),
  ('22222222-2222-2222-2222-222222222222'::uuid, 'Monthly Test', 'America/Chicago', 14);

insert into auth.users (id)
values ('11111111-1111-1111-1111-111111111110'::uuid)
on conflict (id) do nothing;

insert into public.household_members (household_id, user_id, role)
values (
  '11111111-1111-1111-1111-111111111111'::uuid,
  '11111111-1111-1111-1111-111111111110'::uuid,
  'member'
);

set local role authenticated;
do $$
declare
  visible_count integer;
begin
  perform set_config(
    'request.jwt.claim.sub',
    '11111111-1111-1111-1111-111111111110',
    true
  );
  select count(*) into visible_count from public.households;
  perform set_config('ghp_test.member_household_count', visible_count::text, true);
end;
$$;
reset role;

select is(
  current_setting('ghp_test.member_household_count')::integer,
  1,
  'an authenticated member sees only their household'
);

set local role authenticated;
do $$
declare
  visible_count integer;
begin
  perform set_config(
    'request.jwt.claim.sub',
    '99999999-9999-9999-9999-999999999999',
    true
  );
  select count(*) into visible_count from public.households;
  perform set_config('ghp_test.outsider_household_count', visible_count::text, true);
end;
$$;
reset role;

select is(
  current_setting('ghp_test.outsider_household_count')::integer,
  0,
  'an authenticated outsider sees no household finance data'
);

insert into public.income_sources (
  id, household_id, slug, name, cadence, anchor_date, default_amount,
  effective_from, is_active
)
values
  (
    '11111111-1111-1111-1111-111111111112'::uuid,
    '11111111-1111-1111-1111-111111111111'::uuid,
    'weekly-test', 'Weekly test', 'weekly', date '2025-01-06', 100,
    date '2025-01-01', true
  ),
  (
    '22222222-2222-2222-2222-222222222223'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    'month-end-test', 'Month-end test', 'monthly', date '2025-01-31', 200,
    date '2025-01-01', true
  );

select is(
  private.materialize_income_occurrences(
    '11111111-1111-1111-1111-111111111111'::uuid,
    date '2025-01-06',
    date '2025-01-13',
    false
  ),
  2,
  'weekly materializer creates the expected dated occurrences'
);

select is(
  private.materialize_income_occurrences(
    '11111111-1111-1111-1111-111111111111'::uuid,
    date '2025-01-06',
    date '2025-01-13',
    false
  ),
  0,
  'materializer is idempotent over the same source/date window'
);

insert into public.cashflow_occurrences (
  household_id, direction, source_kind, source_id, scheduled_on, label,
  expected_amount, actual_amount, status, settled_at
)
values (
  '11111111-1111-1111-1111-111111111111'::uuid,
  'income',
  'one_time_income',
  'normalization-test',
  date '2025-01-07',
  'Normalization test',
  12.34,
  12.34,
  'settled',
  now()
);

update public.cashflow_occurrences
set status = 'skipped', settled_at = null
where household_id = '11111111-1111-1111-1111-111111111111'::uuid
  and source_id = 'normalization-test';

select is(
  (
    select actual_amount
    from public.cashflow_occurrences
    where household_id = '11111111-1111-1111-1111-111111111111'::uuid
      and source_id = 'normalization-test'
  ),
  null::numeric,
  'moving a settled occurrence to skipped clears its realized amount'
);

with materialized as (
  select private.materialize_income_occurrences(
    '22222222-2222-2222-2222-222222222222'::uuid,
    date '2025-02-01',
    date '2025-02-28',
    false
  ) as inserted_count
)
select is(
  (
    select scheduled_on
    from public.cashflow_occurrences
    where household_id = '22222222-2222-2222-2222-222222222222'::uuid
      and source_id = '22222222-2222-2222-2222-222222222223'
  ),
  date '2025-02-28',
  'monthly materializer clamps a 31st anchor to February month-end'
)
from materialized;

-- Exercise the conditional legacy cutover path even when `db reset` started
-- from a blank database rather than the pre-migration production schema.
create table if not exists public.settings (
  user_id text primary key,
  income_overrides jsonb not null default '{}'::jsonb,
  paid_bills jsonb not null default '{}'::jsonb,
  unpaid_bills jsonb not null default '{}'::jsonb,
  bill_overrides jsonb not null default '{}'::jsonb,
  cleared_income jsonb not null default '{}'::jsonb
);

create table if not exists public.bills (
  id text primary key,
  user_id text not null,
  household_id uuid not null,
  name text not null default '',
  amount numeric not null default 0,
  is_recurring boolean not null default false,
  recur_kind text not null default 'monthly',
  due_day integer not null default 1,
  due_date text,
  category text not null default '',
  is_autodraft boolean not null default false,
  archived_at timestamptz
);

create table if not exists public.one_time_payments (
  id text primary key,
  user_id text not null,
  household_id uuid not null,
  name text not null default '',
  amount numeric not null default 0,
  payment_date date not null,
  archived_at timestamptz
);

insert into public.households (
  id, name, timezone, payday_anchor, cycle_days
)
values (
  '33333333-3333-3333-3333-333333333333'::uuid,
  'Cutover Test',
  'America/Chicago',
  date '2025-01-02',
  14
);

insert into public.income_sources (
  id, household_id, slug, name, cadence, anchor_date, default_amount,
  effective_from, is_active
)
values (
  '33333333-3333-3333-3333-333333333334'::uuid,
  '33333333-3333-3333-3333-333333333333'::uuid,
  'salary',
  'Salary default',
  'weekly',
  date '2025-01-07',
  200,
  date '2025-01-07',
  true
);

insert into public.settings (
  user_id, income_overrides, paid_bills, unpaid_bills, bill_overrides,
  cleared_income
)
values (
  'ghp-cutover-test',
  jsonb_build_object('2025-01-07', '250'),
  jsonb_build_object(
    'cutover-paid-2025-01-08', true,
    'cutover-shifted-2025-01-21', true
  ),
  jsonb_build_object('cutover-unpaid-2025-01-05', true),
  jsonb_build_object(
    'cutover-unpaid-2025-01-05', '125',
    'cutover-shifted-2025-01-21', '500',
    'deleted-cutover-2025-01-04', '44'
  ),
  jsonb_build_object('2025-01-07', true)
);

insert into public.bills (
  id, user_id, household_id, name, amount, is_recurring, recur_kind,
  due_day, due_date
)
values
  (
    'cutover-unpaid', 'ghp-cutover-test',
    '33333333-3333-3333-3333-333333333333'::uuid,
    'Past but unpaid', 100, true, 'monthly', 5, null
  ),
  (
    'cutover-paid', 'ghp-cutover-test',
    '33333333-3333-3333-3333-333333333333'::uuid,
    'Paid early', 50, true, 'monthly', 8, null
  ),
  (
    'cutover-shifted', 'ghp-cutover-test',
    '33333333-3333-3333-3333-333333333333'::uuid,
    'Shifted recurring bill', 550, true, 'monthly', 15, null
  ),
  (
    'cutover-one-time-bill', 'ghp-cutover-test',
    '33333333-3333-3333-3333-333333333333'::uuid,
    'Past one-time bill', 30, false, 'monthly', 1, '2025-01-06'
  );

insert into public.one_time_payments (
  id, user_id, household_id, name, amount, payment_date, archived_at
)
values
  (
    'cutover-payment',
    'ghp-cutover-test',
    '33333333-3333-3333-3333-333333333333'::uuid,
    'Past one-time income',
    35,
    date '2025-01-06',
    null
  ),
  (
    'cutover-ancient-payment',
    'ghp-cutover-test',
    '33333333-3333-3333-3333-333333333333'::uuid,
    'Ancient one-time income',
    15,
    date '1999-01-06',
    null
  ),
  (
    'cutover-archived-payment',
    'ghp-cutover-test',
    '33333333-3333-3333-3333-333333333333'::uuid,
    'Archived one-time income',
    99,
    date '2025-01-06',
    timestamptz '2025-01-07 12:00:00-06'
  );

do $$
begin
  perform private.reconcile_legacy_finance_cutover(
    '33333333-3333-3333-3333-333333333333'::uuid,
    'ghp-cutover-test',
    date '2025-01-07'
  );
end;
$$;

select ok(
  exists (
    select 1
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and direction = 'income'
      and source_kind = 'income_source'
      and scheduled_on = date '2025-01-07'
      and expected_amount = 250
      and actual_amount = 250
      and status = 'settled'
      and not is_inferred
      and is_adjusted
  ),
  'cutover preserves a cleared current-day income override as deterministic'
);

select ok(
  exists (
    select 1
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_id = 'cutover-unpaid'
      and scheduled_on = date '2025-01-05'
      and expected_amount = 125
      and actual_amount is null
      and status = 'planned'
      and is_inferred
      and is_adjusted
  ),
  'cutover preserves an explicit past-unpaid bill and amount override'
);

select ok(
  exists (
    select 1
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_id = 'cutover-paid'
      and scheduled_on = date '2025-01-08'
      and expected_amount = 50
      and actual_amount = 50
      and status = 'settled'
      and not is_inferred
  ),
  'cutover preserves a future bill marked paid early as deterministic'
);

select ok(
  exists (
    select 1
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_kind = 'bill_template'
      and source_id = 'cutover-shifted'
      and scheduled_on = date '2025-01-21'
      and label = 'Shifted recurring bill'
      and expected_amount = 500
      and actual_amount = 500
      and status = 'settled'
      and is_adjusted
      and not is_inferred
  )
  and exists (
    select 1
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_kind = 'bill_template'
      and source_id = 'cutover-shifted'
      and scheduled_on = date '2025-01-15'
      and expected_amount = 550
      and actual_amount is null
      and status = 'skipped'
      and not is_adjusted
  )
  and (
    select count(*)
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_kind = 'bill_template'
      and source_id = 'cutover-shifted'
      and scheduled_on >= date '2025-01-01'
      and scheduled_on < date '2025-02-01'
      and status <> 'skipped'
  ) = 1,
  'a moved recurring override wins while the same-month generated date is suppressed'
);

select ok(
  exists (
    select 1
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_kind = 'bill_template'
      and source_id = 'deleted-cutover'
      and scheduled_on = date '2025-01-04'
      and expected_amount = 44
      and status = 'settled'
      and is_inferred
      and is_adjusted
  ),
  'cutover recovers a deleted bill when a dated amount override survives'
);

select is(
  (
    select count(*)
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_id in ('cutover-one-time-bill', 'cutover-payment')
      and scheduled_on = date '2025-01-06'
      and status = 'settled'
      and is_inferred
  ),
  2::bigint,
  'cutover copies and settles past one-time income and bills idempotently'
);

select ok(
  exists (
    select 1
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_kind = 'one_time_income'
      and source_id = 'cutover-ancient-payment'
      and scheduled_on = date '1999-01-06'
      and expected_amount = 15
      and actual_amount = 15
      and status = 'settled'
      and is_inferred
  ),
  'cutover preserves an ancient one-time row at its exact date'
);

select ok(
  not exists (
    select 1
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_kind = 'one_time_income'
      and source_id = 'cutover-archived-payment'
  ),
  'cutover excludes a soft-archived one-time payment'
);

select ok(
  not exists (
    select 1
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
      and source_kind in ('income_source', 'bill_template')
      and scheduled_on < date '2023-01-07'
  ),
  'an ancient one-time row does not widen recurring reconstruction past 24 months'
);

create temporary table cutover_count_before as
select count(*)::bigint as occurrence_count
from public.cashflow_occurrences
where household_id = '33333333-3333-3333-3333-333333333333'::uuid;

do $$
begin
  perform private.reconcile_legacy_finance_cutover(
    '33333333-3333-3333-3333-333333333333'::uuid,
    'ghp-cutover-test',
    date '2025-01-07'
  );
end;
$$;

select is(
  (
    select count(*)
    from public.cashflow_occurrences
    where household_id = '33333333-3333-3333-3333-333333333333'::uuid
  ),
  (select occurrence_count from cutover_count_before),
  'repeating the cutover helper does not duplicate occurrence identities'
);

select ok(
  not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  )
  or (
    select count(*)
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename in (
        'households',
        'household_members',
        'income_sources',
        'cashflow_occurrences',
        'balance_snapshots'
      )
  ) = 5,
  'all shared-finance tables are published when Supabase Realtime is available'
);

select ok(
  not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  )
  or (
    select count(*)
    from (
      values
        ('bills'),
        ('one_time_payments'),
        ('meals'),
        ('shared_lists'),
        ('shared_list_items')
    ) as expected(tablename)
    where to_regclass(format('public.%I', expected.tablename)) is not null
  ) < 5
  or (
    select count(*)
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename in (
        'bills',
        'one_time_payments',
        'meals',
        'shared_lists',
        'shared_list_items'
      )
  ) = 5,
  'all legacy/shared source tables are published when the full app schema exists'
);

select ok(
  not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  )
  or not exists (
    select 1
    from (
      values
        ('bills'),
        ('one_time_payments'),
        ('meals'),
        ('shared_lists'),
        ('shared_list_items')
    ) as expected(tablename)
    join pg_publication_tables as published
      on published.pubname = 'supabase_realtime'
     and published.schemaname = 'public'
     and published.tablename = expected.tablename
    join pg_class as relation
      on relation.oid = to_regclass(format('public.%I', expected.tablename))
    where relation.relreplident = 'f'
  ),
  'soft-deleted shared tables do not expose full old-row DELETE payloads'
);

select * from finish();
rollback;
