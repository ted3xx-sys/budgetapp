-- Gloodt Home Planner: additive financial history foundation.
--
-- This migration deliberately leaves the legacy settings, bills, and
-- one_time_payments structures intact. The existing client can continue to
-- operate while a later release is moved to targeted, household-scoped writes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon;

create table public.households (
  id              uuid          primary key default gen_random_uuid(),
  name            text          not null,
  timezone        text          not null default 'America/Chicago',
  payday_anchor   date,
  cycle_days      smallint      not null default 14,
  reserve_floor   numeric(12,2) not null default 0,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  constraint households_name_not_blank check (btrim(name) <> ''),
  constraint households_timezone_not_blank check (btrim(timezone) <> ''),
  constraint households_cycle_days_valid check (cycle_days between 1 and 62),
  constraint households_reserve_floor_nonnegative check (
    reserve_floor >= 0
    and reserve_floor::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

create table public.household_members (
  household_id uuid        not null references public.households(id) on delete cascade,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  role         text        not null default 'member',
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id),
  constraint household_members_role_valid check (role in ('owner', 'member'))
);

create table public.income_sources (
  id                uuid          primary key default gen_random_uuid(),
  household_id      uuid          not null references public.households(id) on delete cascade,
  slug              text          not null,
  name              text          not null,
  cadence           text          not null,
  anchor_date       date          not null,
  default_amount    numeric(12,2) not null default 0,
  effective_from    date          not null,
  effective_through date,
  is_active         boolean       not null default true,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  constraint income_sources_household_slug_key unique (household_id, slug),
  constraint income_sources_slug_not_blank check (btrim(slug) <> ''),
  constraint income_sources_name_not_blank check (btrim(name) <> ''),
  constraint income_sources_cadence_valid check (cadence in ('weekly', 'biweekly', 'monthly')),
  constraint income_sources_amount_nonnegative check (
    default_amount >= 0
    and default_amount::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint income_sources_effective_range_valid check (
    effective_through is null or effective_through >= effective_from
  )
);

create table public.cashflow_occurrences (
  id              uuid          primary key default gen_random_uuid(),
  household_id    uuid          not null references public.households(id) on delete cascade,
  direction       text          not null,
  source_kind     text          not null,
  source_id       text          not null,
  scheduled_on    date          not null,
  label           text          not null,
  category        text          not null default '',
  expected_amount numeric(12,2) not null default 0,
  actual_amount   numeric(12,2),
  status          text          not null default 'planned',
  settled_at      timestamptz,
  is_inferred     boolean       not null default false,
  is_adjusted     boolean       not null default false,
  is_autodraft    boolean       not null default false,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  constraint cashflow_occurrences_source_date_key unique (
    household_id, direction, source_kind, source_id, scheduled_on
  ),
  constraint cashflow_occurrences_direction_valid check (direction in ('income', 'expense')),
  constraint cashflow_occurrences_source_kind_not_blank check (btrim(source_kind) <> ''),
  constraint cashflow_occurrences_source_id_not_blank check (btrim(source_id) <> ''),
  constraint cashflow_occurrences_label_not_blank check (btrim(label) <> ''),
  constraint cashflow_occurrences_expected_amount_nonnegative check (
    expected_amount >= 0
    and expected_amount::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint cashflow_occurrences_actual_amount_nonnegative check (
    actual_amount is null
    or (
      actual_amount >= 0
      and actual_amount::text not in ('NaN', 'Infinity', '-Infinity')
    )
  ),
  constraint cashflow_occurrences_status_valid check (status in ('planned', 'settled', 'skipped')),
  constraint cashflow_occurrences_settlement_valid check (
    (status = 'settled' and settled_at is not null)
    or (status <> 'settled' and settled_at is null)
  ),
  constraint cashflow_occurrences_actual_only_when_settled check (
    actual_amount is null or status = 'settled'
  )
);

create table public.balance_snapshots (
  id           uuid          primary key default gen_random_uuid(),
  household_id uuid          not null references public.households(id) on delete cascade,
  amount       numeric(12,2) not null,
  as_of        timestamptz   not null default now(),
  created_by   uuid          references auth.users(id) on delete set null default auth.uid(),
  created_at   timestamptz   not null default now(),
  constraint balance_snapshots_amount_finite check (
    amount::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

-- Foreign keys are not automatically indexed by Postgres. These indexes also
-- match the household/date filters used by the reporting client and RLS.
create index household_members_user_household_idx
  on public.household_members (user_id, household_id);
create index income_sources_household_active_idx
  on public.income_sources (household_id, is_active, effective_from, effective_through);
create index cashflow_occurrences_household_scheduled_idx
  on public.cashflow_occurrences (household_id, scheduled_on);
create index cashflow_occurrences_household_status_scheduled_idx
  on public.cashflow_occurrences (household_id, status, scheduled_on);
create index cashflow_occurrences_household_direction_scheduled_idx
  on public.cashflow_occurrences (household_id, direction, scheduled_on);
create index balance_snapshots_household_as_of_idx
  on public.balance_snapshots (household_id, as_of desc);
create index balance_snapshots_created_by_idx
  on public.balance_snapshots (created_by)
  where created_by is not null;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function private.set_updated_at() from public;
revoke execute on function private.set_updated_at() from anon, authenticated;

-- A skipped/planned item has no realized amount or settlement timestamp. This
-- also makes the client's "remove" transition safe when the item was formerly
-- settled and the patch contains only the new status plus a null timestamp.
create or replace function private.normalize_cashflow_occurrence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'settled' then
    new.actual_amount := null;
    new.settled_at := null;
  end if;
  return new;
end;
$$;

revoke execute on function private.normalize_cashflow_occurrence() from public;
revoke execute on function private.normalize_cashflow_occurrence() from anon, authenticated;

create trigger households_set_updated_at
before update on public.households
for each row execute function private.set_updated_at();

create trigger income_sources_set_updated_at
before update on public.income_sources
for each row execute function private.set_updated_at();

create trigger cashflow_occurrences_set_updated_at
before update on public.cashflow_occurrences
for each row execute function private.set_updated_at();

create trigger cashflow_occurrences_normalize_state
before insert or update on public.cashflow_occurrences
for each row execute function private.normalize_cashflow_occurrence();

-- Security-definer membership lookup lives outside every exposed schema and
-- pins search_path. Returning a set lets RLS evaluate the caller's memberships
-- once per statement instead of running auth.uid() for every candidate row.
create or replace function private.current_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select member.household_id
  from public.household_members as member
  where member.user_id = (select auth.uid());
$$;

revoke execute on function private.current_household_ids() from public;
revoke execute on function private.current_household_ids() from anon;
grant usage on schema private to authenticated;
grant execute on function private.current_household_ids() to authenticated;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.income_sources enable row level security;
alter table public.cashflow_occurrences enable row level security;
alter table public.balance_snapshots enable row level security;

create policy households_select_for_members
on public.households for select to authenticated
using (id in (select private.current_household_ids()));

create policy households_update_for_members
on public.households for update to authenticated
using (id in (select private.current_household_ids()))
with check (id in (select private.current_household_ids()));

create policy household_members_select_for_members
on public.household_members for select to authenticated
using (household_id in (select private.current_household_ids()));

create policy income_sources_select_for_members
on public.income_sources for select to authenticated
using (household_id in (select private.current_household_ids()));

create policy income_sources_insert_for_members
on public.income_sources for insert to authenticated
with check (household_id in (select private.current_household_ids()));

create policy income_sources_update_for_members
on public.income_sources for update to authenticated
using (household_id in (select private.current_household_ids()))
with check (household_id in (select private.current_household_ids()));

create policy cashflow_occurrences_select_for_members
on public.cashflow_occurrences for select to authenticated
using (household_id in (select private.current_household_ids()));

create policy cashflow_occurrences_insert_for_members
on public.cashflow_occurrences for insert to authenticated
with check (household_id in (select private.current_household_ids()));

create policy cashflow_occurrences_update_for_members
on public.cashflow_occurrences for update to authenticated
using (household_id in (select private.current_household_ids()))
with check (household_id in (select private.current_household_ids()));

create policy balance_snapshots_select_for_members
on public.balance_snapshots for select to authenticated
using (household_id in (select private.current_household_ids()));

create policy balance_snapshots_insert_for_members
on public.balance_snapshots for insert to authenticated
with check (
  household_id in (select private.current_household_ids())
  and created_by = (select auth.uid())
);

-- Explicit Data API privileges. New public tables are not assumed to be
-- auto-exposed; RLS remains the row-level enforcement boundary.
revoke all on table public.households from anon, authenticated;
revoke all on table public.household_members from anon, authenticated;
revoke all on table public.income_sources from anon, authenticated;
revoke all on table public.cashflow_occurrences from anon, authenticated;
revoke all on table public.balance_snapshots from anon, authenticated;

grant select, update on table public.households to authenticated;
grant select on table public.household_members to authenticated;
grant select, insert, update on table public.income_sources to authenticated;
grant select, insert, update on table public.cashflow_occurrences to authenticated;
grant select, insert on table public.balance_snapshots to authenticated;

-- Publish targeted household changes when Realtime is available. The catalog
-- check makes this idempotent and keeps plain Postgres/local test databases
-- without Supabase's publication from failing the migration.
do $$
declare
  realtime_table text;
  soft_delete_table text;
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    foreach realtime_table in array array[
      'households',
      'household_members',
      'income_sources',
      'cashflow_occurrences',
      'balance_snapshots',
      'bills',
      'one_time_payments',
      'meals',
      'shared_lists',
      'shared_list_items'
    ]
    loop
      if to_regclass(format('public.%I', realtime_table)) is not null
      and not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = realtime_table
      ) then
        execute format(
          'alter publication supabase_realtime add table public.%I',
          realtime_table
        );
      end if;
    end loop;

    -- Soft-deleted rows arrive as ordinary UPDATEs, so do not retain full old
    -- row images from any earlier/manual Realtime configuration.
    foreach soft_delete_table in array array[
      'bills',
      'one_time_payments',
      'meals',
      'shared_lists',
      'shared_list_items'
    ]
    loop
      if to_regclass(format('public.%I', soft_delete_table)) is not null
      and exists (
        select 1
        from pg_class
        where oid = to_regclass(format('public.%I', soft_delete_table))
          and relreplident = 'f'
      ) then
        execute format(
          'alter table public.%I replica identity default',
          soft_delete_table
        );
      end if;
    end loop;

  end if;
end;
$$;

-- Stable shared-household bootstrap. This reuses the legacy all-zero settings
-- key as a real UUID household ID, but does not alter or delete the legacy row.
insert into public.households (id, name, timezone, cycle_days)
values (
  '00000000-0000-0000-0000-000000000000'::uuid,
  'Gloodt Home',
  'America/Chicago',
  14
)
on conflict (id) do nothing;

-- Keep the legacy bill/payment source tables usable during the gradual client
-- rollout. New clients write the household tag and soft-archive bill templates;
-- older clients can omit both fields because the shared household is the
-- default. Existing rows are retained and assigned to the same household the
-- legacy all-zero user key already represented.
do $$
declare
  target_household constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  if to_regclass('public.bills') is not null then
    execute format(
      'alter table public.bills add column if not exists household_id uuid default %L::uuid',
      target_household::text
    );
    execute 'alter table public.bills add column if not exists archived_at timestamptz';
    execute 'update public.bills set household_id = $1 where household_id is null'
      using target_household;
    execute format(
      'alter table public.bills alter column household_id set default %L::uuid',
      target_household::text
    );
    execute 'alter table public.bills alter column household_id set not null';

    if not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.bills'::regclass
        and conname = 'bills_household_id_fkey'
    ) then
      execute 'alter table public.bills add constraint bills_household_id_fkey foreign key (household_id) references public.households(id) on delete restrict not valid';
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.bills'::regclass
        and conname = 'bills_amount_nonnegative_finite'
    ) then
      execute $constraint$
        alter table public.bills
        add constraint bills_amount_nonnegative_finite
        check (
          amount >= 0
          and amount::text not in ('NaN', 'Infinity', '-Infinity')
        ) not valid
      $constraint$;
    end if;
    execute 'alter table public.bills validate constraint bills_amount_nonnegative_finite';

    execute 'create index if not exists bills_household_archived_idx on public.bills (household_id, archived_at)';
  end if;

  if to_regclass('public.one_time_payments') is not null then
    execute format(
      'alter table public.one_time_payments add column if not exists household_id uuid default %L::uuid',
      target_household::text
    );
    execute 'alter table public.one_time_payments add column if not exists archived_at timestamptz';
    execute 'update public.one_time_payments set household_id = $1 where household_id is null'
      using target_household;
    execute format(
      'alter table public.one_time_payments alter column household_id set default %L::uuid',
      target_household::text
    );
    execute 'alter table public.one_time_payments alter column household_id set not null';

    if not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.one_time_payments'::regclass
        and conname = 'one_time_payments_household_id_fkey'
    ) then
      execute 'alter table public.one_time_payments add constraint one_time_payments_household_id_fkey foreign key (household_id) references public.households(id) on delete restrict not valid';
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.one_time_payments'::regclass
        and conname = 'one_time_payments_amount_nonnegative_finite'
    ) then
      execute $constraint$
        alter table public.one_time_payments
        add constraint one_time_payments_amount_nonnegative_finite
        check (
          amount >= 0
          and amount::text not in ('NaN', 'Infinity', '-Infinity')
        ) not valid
      $constraint$;
    end if;
    execute 'alter table public.one_time_payments validate constraint one_time_payments_amount_nonnegative_finite';

    execute 'create index if not exists one_time_payments_household_active_date_idx on public.one_time_payments (household_id, payment_date) where archived_at is null';
  end if;
end;
$$;

-- Shared planning rows use recoverable soft deletion. Existing rows remain
-- active because every marker is nullable and backfills to NULL. Filtered
-- Realtime UPDATEs then work without exposing old DELETE payloads.
do $$
begin
  if to_regclass('public.meals') is not null then
    execute 'alter table public.meals add column if not exists deleted_at timestamptz';
    execute 'create index if not exists meals_user_active_date_idx on public.meals (user_id, meal_date) where deleted_at is null';
  end if;

  if to_regclass('public.shared_lists') is not null then
    execute 'alter table public.shared_lists add column if not exists archived_at timestamptz';
    execute 'create index if not exists shared_lists_user_active_updated_idx on public.shared_lists (user_id, updated_at desc) where archived_at is null';
  end if;

  if to_regclass('public.shared_list_items') is not null then
    execute 'alter table public.shared_list_items add column if not exists deleted_at timestamptz';
    execute 'create index if not exists shared_list_items_list_active_sort_idx on public.shared_list_items (list_id, sort_order) where deleted_at is null';
  end if;
end;
$$;

-- The migrated client exclusively soft-deletes. Revoke physical deletion even
-- though the legacy FOR ALL RLS policies still exist, so a browser client can
-- never emit a DELETE event or bypass the recoverable markers.
do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'settings',
    'bills',
    'one_time_payments',
    'meals',
    'shared_lists',
    'shared_list_items'
  ]
  loop
    if to_regclass(format('public.%I', protected_table)) is not null then
      execute format(
        'revoke delete on table public.%I from anon, authenticated',
        protected_table
      );
    end if;
  end loop;
end;
$$;

-- Only add allowlisted users that actually exist in auth.users. This keeps the
-- migration safe in a blank local database and mirrors the current RLS access.
insert into public.household_members (household_id, user_id, role)
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  auth_user.id,
  'owner'
from auth.users as auth_user
where auth_user.id in (
  'bbda4531-a756-4ff4-b479-2448c516b254'::uuid,
  '80e9eb94-5a71-4ff1-8481-60fb69722c5d'::uuid
)
on conflict (household_id, user_id) do nothing;

-- Add the optional reserve fallback without assuming the legacy table exists
-- in a fresh local database. No legacy value is changed or removed.
do $$
begin
  if to_regclass('public.settings') is not null then
    execute $column$
      alter table public.settings
      add column if not exists reserve_floor numeric(12,2) not null default 0
      check (
        reserve_floor >= 0
        and reserve_floor::text not in ('NaN', 'Infinity', '-Infinity')
      )
    $column$;
    if not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.settings'::regclass
        and conname = 'settings_reserve_floor_nonnegative_finite'
    ) then
      execute $constraint$
        alter table public.settings
        add constraint settings_reserve_floor_nonnegative_finite
        check (
          reserve_floor >= 0
          and reserve_floor::text not in ('NaN', 'Infinity', '-Infinity')
        ) not valid
      $constraint$;
    end if;
    execute 'alter table public.settings validate constraint settings_reserve_floor_nonnegative_finite';
  end if;
end;
$$;

-- Backfill directly knowable current defaults and a starting balance. The
-- reconciler below separately reconstructs a bounded, visibly inferred history.
do $$
declare
  legacy_user_id constant text := '00000000-0000-0000-0000-000000000000';
  target_household constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  local_today date := (now() at time zone 'America/Chicago')::date;
  salary_amount numeric;
  payday_amount numeric;
  instapay_amount numeric;
  current_balance numeric;
  current_reserve numeric;
  settings_found boolean;
  anchor_text text;
  anchor_value date;
  fallback_thursday date;
  salary_tuesday date;
begin
  if to_regclass('public.settings') is null then
    return;
  end if;

  execute $query$
    select
      true,
      wife_weekly_income,
      payday_default,
      instapay_default,
      balance,
      reserve_floor,
      anchor_thursday
    from public.settings
    where user_id = $1
    limit 1
  $query$
  into settings_found, salary_amount, payday_amount, instapay_amount,
       current_balance, current_reserve, anchor_text
  using legacy_user_id;

  if not coalesce(settings_found, false) then
    return;
  end if;

  if salary_amount is null
  or salary_amount < 0
  or salary_amount::text in ('NaN', 'Infinity', '-Infinity') then
    salary_amount := 0;
  end if;
  if payday_amount is null
  or payday_amount < 0
  or payday_amount::text in ('NaN', 'Infinity', '-Infinity') then
    payday_amount := 0;
  end if;
  if instapay_amount is null
  or instapay_amount < 0
  or instapay_amount::text in ('NaN', 'Infinity', '-Infinity') then
    instapay_amount := 0;
  end if;
  if current_reserve is null
  or current_reserve < 0
  or current_reserve::text in ('NaN', 'Infinity', '-Infinity') then
    current_reserve := 0;
  end if;
  if current_balance is null
  or current_balance::text in ('NaN', 'Infinity', '-Infinity') then
    current_balance := 0;
  end if;

  begin
    anchor_value := nullif(anchor_text, '')::date;
  exception when others then
    anchor_value := null;
  end;

  fallback_thursday := local_today - (((extract(dow from local_today)::integer - 4) + 7) % 7);
  salary_tuesday := local_today - (((extract(dow from local_today)::integer - 2) + 7) % 7);

  update public.households
  set payday_anchor = coalesce(anchor_value, payday_anchor),
      reserve_floor = greatest(coalesce(current_reserve, 0), 0)
  where id = target_household;

  insert into public.income_sources (
    household_id, slug, name, cadence, anchor_date, default_amount,
    effective_from, is_active
  )
  values (
    target_household, 'salary', 'Salary default', 'weekly',
    salary_tuesday, greatest(coalesce(salary_amount, 0), 0), local_today, true
  )
  on conflict (household_id, slug) do nothing;

  insert into public.income_sources (
    household_id, slug, name, cadence, anchor_date, default_amount,
    effective_from, is_active
  )
  values
    (
      target_household, 'payday', 'Payday default', 'biweekly',
      coalesce(anchor_value, fallback_thursday),
      greatest(coalesce(payday_amount, 0), 0), local_today,
      anchor_value is not null
    ),
    (
      target_household, 'instapay', 'Instapay default', 'biweekly',
      coalesce(anchor_value, fallback_thursday) + 7,
      greatest(coalesce(instapay_amount, 0), 0), local_today,
      anchor_value is not null
    )
  on conflict (household_id, slug) do nothing;

  insert into public.balance_snapshots (
    household_id, amount, as_of, created_by
  )
  values (
    target_household, coalesce(current_balance, 0), now(), null
  );
end;
$$;

-- Admin-only, idempotent materializer for an explicitly chosen date window.
-- Set p_mark_inferred=true when reconstructing past expected income; the helper
-- never claims that a historical payment actually settled.
create or replace function private.materialize_income_occurrences(
  p_household_id uuid,
  p_from date,
  p_through date,
  p_mark_inferred boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if p_from is null or p_through is null or p_through < p_from then
    raise exception 'Invalid occurrence window: % through %', p_from, p_through;
  end if;

  insert into public.cashflow_occurrences (
    household_id,
    direction,
    source_kind,
    source_id,
    scheduled_on,
    label,
    expected_amount,
    status,
    is_inferred
  )
  select
    source.household_id,
    'income',
    'income_source',
    source.id::text,
    candidate.day,
    source.name,
    source.default_amount,
    'planned',
    p_mark_inferred
  from public.income_sources as source
  cross join lateral (
    select series_day::date as day
    from generate_series(
      greatest(p_from, source.effective_from)::timestamp,
      least(p_through, coalesce(source.effective_through, p_through))::timestamp,
      interval '1 day'
    ) as series(series_day)
    where case source.cadence
      when 'weekly' then mod(series_day::date - source.anchor_date, 7) = 0
      when 'biweekly' then mod(series_day::date - source.anchor_date, 14) = 0
      when 'monthly' then
        extract(day from series_day)::integer = least(
          extract(day from source.anchor_date)::integer,
          extract(day from (date_trunc('month', series_day) + interval '1 month - 1 day'))::integer
        )
      else false
    end
  ) as candidate
  where source.household_id = p_household_id
    and source.is_active
  on conflict on constraint cashflow_occurrences_source_date_key do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke execute on function private.materialize_income_occurrences(uuid, date, date, boolean) from public;
revoke execute on function private.materialize_income_occurrences(uuid, date, date, boolean) from anon, authenticated;

-- Legacy occurrence keys end in an ISO date, but imported JSON and old text
-- date columns are not trusted blindly. Invalid calendar dates return null
-- instead of aborting the migration transaction.
create or replace function private.legacy_date_suffix(p_value text)
returns date
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  date_text text;
begin
  date_text := substring(p_value from '([0-9]{4}-[0-9]{2}-[0-9]{2})$');
  if date_text is null then
    return null;
  end if;

  begin
    return date_text::date;
  exception when others then
    return null;
  end;
end;
$$;

create or replace function private.legacy_nonnegative_amount(p_value text)
returns numeric(12,2)
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  parsed numeric;
  normalized text;
begin
  begin
    normalized := lower(btrim(p_value));
    if normalized in (
      'nan', '+nan', '-nan',
      'infinity', '+infinity', '-infinity',
      'inf', '+inf', '-inf'
    ) then
      return null;
    end if;

    parsed := normalized::numeric;
    if parsed < 0 then
      return null;
    end if;
    return parsed::numeric(12,2);
  exception when others then
    return null;
  end;
end;
$$;

revoke execute on function private.legacy_date_suffix(text) from public;
revoke execute on function private.legacy_date_suffix(text) from anon, authenticated;
revoke execute on function private.legacy_nonnegative_amount(text) from public;
revoke execute on function private.legacy_nonnegative_amount(text) from anon, authenticated;

-- Admin-only bridge for the existing public.bills template table. The body uses
-- dynamic SQL so this foundation can also be tested in a fresh local database
-- where the pre-migration legacy schema has not yet been baselined.
create or replace function private.materialize_legacy_bill_occurrences(
  p_household_id uuid,
  p_from date,
  p_through date,
  p_mark_inferred boolean default false,
  p_legacy_user_id text default '00000000-0000-0000-0000-000000000000'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if p_from is null or p_through is null or p_through < p_from then
    raise exception 'Invalid occurrence window: % through %', p_from, p_through;
  end if;

  if to_regclass('public.bills') is null then
    return 0;
  end if;

  execute $query$
    insert into public.cashflow_occurrences (
      household_id,
      direction,
      source_kind,
      source_id,
      scheduled_on,
      label,
      category,
      expected_amount,
      status,
      is_inferred,
      is_autodraft
    )
    select
      $1,
      'expense',
      case when bill.is_recurring then 'bill_template' else 'one_time_bill' end,
      bill.id,
      candidate.day,
      coalesce(nullif(btrim(bill.name), ''), 'Unnamed bill'),
      coalesce(bill.category, ''),
      greatest(coalesce(bill.amount, 0), 0),
      'planned',
      $4,
      coalesce(bill.is_autodraft, false)
    from public.bills as bill
    cross join lateral (
      select generated.series_day::date as day
      from generate_series(
        $2::timestamp,
        $3::timestamp,
        interval '1 day'
      ) as generated(series_day)
      where
        (
          bill.is_recurring
          and coalesce(bill.recur_kind, 'monthly') = 'weekly'
          and extract(dow from generated.series_day)::integer =
              least(greatest(coalesce(bill.due_day, 0), 0), 6)
        )
        or
        (
          bill.is_recurring
          and coalesce(bill.recur_kind, 'monthly') <> 'weekly'
          and extract(day from generated.series_day)::integer = least(
            least(greatest(coalesce(bill.due_day, 1), 1), 31),
            extract(day from (
              date_trunc('month', generated.series_day) + interval '1 month - 1 day'
            ))::integer
          )
        )
        or
        (
          not bill.is_recurring
          and private.legacy_date_suffix(bill.due_date) = generated.series_day::date
        )
    ) as candidate
    where bill.user_id = $5
      and bill.household_id = $1
      and bill.archived_at is null
    on conflict on constraint cashflow_occurrences_source_date_key do nothing
  $query$
  using p_household_id, p_from, p_through, p_mark_inferred, p_legacy_user_id;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke execute on function private.materialize_legacy_bill_occurrences(uuid, date, date, boolean, text) from public;
revoke execute on function private.materialize_legacy_bill_occurrences(uuid, date, date, boolean, text) from anon, authenticated;

-- Cut over a saved legacy model without changing its source rows. This private,
-- admin-only function also gives branch/local tests a deterministic p_as_of.
-- The bank balance snapshot already includes cleared activity, so reconstructing
-- those same occurrences as planned would count them twice. Start at the
-- earliest useful recurring evidence (bounded to 24 months), extend the
-- planning horizon 400 household-local days, preserve overrides, and reproduce
-- the legacy status rules. One-time rows are copied at their exact date without
-- widening every recurring schedule. Only reconstructed dates before the
-- household-local cutover remain visibly inferred until reviewed.
create or replace function private.reconcile_legacy_finance_cutover(
  p_household_id uuid,
  p_legacy_user_id text,
  p_as_of date default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_household uuid := p_household_id;
  legacy_user_id text := p_legacy_user_id;
  household_timezone text;
  payday_anchor date;
  cycle_length integer;
  local_today date;
  cutover_at timestamptz;
  backfill_from date;
  backfill_through date;
  recurring_history_floor date;
  earliest_recurring_evidence date;
  candidate_date date;
  legacy_key text;
  settings_found boolean;
  legacy_income_overrides jsonb := '{}'::jsonb;
  legacy_paid_bills jsonb := '{}'::jsonb;
  legacy_unpaid_bills jsonb := '{}'::jsonb;
  legacy_bill_overrides jsonb := '{}'::jsonb;
  legacy_cleared_income jsonb := '{}'::jsonb;
begin
  if to_regclass('public.settings') is null then
    return;
  end if;

  execute $query$
    select
      true,
      case when jsonb_typeof(income_overrides) = 'object'
        then income_overrides else '{}'::jsonb end,
      case when jsonb_typeof(paid_bills) = 'object'
        then paid_bills else '{}'::jsonb end,
      case when jsonb_typeof(unpaid_bills) = 'object'
        then unpaid_bills else '{}'::jsonb end,
      case when jsonb_typeof(bill_overrides) = 'object'
        then bill_overrides else '{}'::jsonb end,
      case when jsonb_typeof(cleared_income) = 'object'
        then cleared_income else '{}'::jsonb end
    from public.settings
    where user_id = $1
    limit 1
  $query$
  into settings_found, legacy_income_overrides, legacy_paid_bills,
       legacy_unpaid_bills, legacy_bill_overrides, legacy_cleared_income
  using legacy_user_id;

  if not coalesce(settings_found, false) then
    return;
  end if;

  select household.timezone, household.payday_anchor, household.cycle_days
  into household_timezone, payday_anchor, cycle_length
  from public.households as household
  where household.id = target_household;

  if not found then
    raise exception 'Unknown household %', target_household;
  end if;

  household_timezone := coalesce(nullif(household_timezone, ''), 'America/Chicago');
  cycle_length := greatest(coalesce(cycle_length, 14), 1);
  local_today := coalesce(p_as_of, (now() at time zone household_timezone)::date);
  cutover_at := case
    when p_as_of is null then now()
    else (p_as_of::timestamp + interval '12 hours') at time zone household_timezone
  end;

  if payday_anchor is not null then
    backfill_from := local_today - mod(
      mod(local_today - payday_anchor, cycle_length) + cycle_length,
      cycle_length
    );
  else
    backfill_from := local_today - (cycle_length - 1);
  end if;
  backfill_from := least(backfill_from, date_trunc('month', local_today)::date);
  backfill_through := local_today + 400;
  recurring_history_floor := (local_today - interval '24 months')::date;

  -- Date-only income keys are evidence for the recurring pay schedules. A
  -- one-time payment key has a "payment-...-YYYY-MM-DD" prefix and therefore
  -- does not widen recurring history; that source row is copied exactly below.
  -- Invalid imported keys are ignored by the safe parser.
  for legacy_key in
    select json_key
    from (
      select entry.key as json_key
      from jsonb_each_text(legacy_income_overrides) as entry(key, value)
      where private.legacy_nonnegative_amount(entry.value) is not null
      union
      select entry.key
      from jsonb_each_text(legacy_cleared_income) as entry(key, value)
      where lower(entry.value) in ('true', '1', 'yes', 'on')
    ) as surviving_income_keys
    where json_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  loop
    candidate_date := private.legacy_date_suffix(legacy_key);
    if candidate_date is not null then
      earliest_recurring_evidence := least(
        coalesce(earliest_recurring_evidence, candidate_date),
        candidate_date
      );
    end if;
  end loop;

  -- A bill status/override key widens recurring history only when its source ID
  -- still identifies a recurring template. Ancient one-time rows must not cause
  -- every current template and pay source to be fabricated across that span.
  if to_regclass('public.bills') is not null then
    execute $query$
      select min(private.legacy_date_suffix(key_set.json_key))
      from (
        select entry.key as json_key
        from jsonb_each_text($1) as entry(key, value)
        where lower(entry.value) in ('true', '1', 'yes', 'on')
        union
        select entry.key
        from jsonb_each_text($2) as entry(key, value)
        where lower(entry.value) in ('true', '1', 'yes', 'on')
        union
        select entry.key
        from jsonb_each_text($3) as entry(key, value)
        where private.legacy_nonnegative_amount(entry.value) is not null
      ) as key_set
      join public.bills as bill
        on bill.id::text = regexp_replace(
          key_set.json_key,
          '-[0-9]{4}-[0-9]{2}-[0-9]{2}$',
          ''
        )
      where bill.user_id = $4
        and bill.household_id = $5
        and bill.archived_at is null
        and bill.is_recurring
        and private.legacy_date_suffix(key_set.json_key) is not null
    $query$
    into candidate_date
    using legacy_paid_bills, legacy_unpaid_bills, legacy_bill_overrides,
          legacy_user_id, target_household;
    if candidate_date is not null then
      earliest_recurring_evidence := least(
        coalesce(earliest_recurring_evidence, candidate_date),
        candidate_date
      );
    end if;
  end if;

  backfill_from := greatest(
    least(
      backfill_from,
      coalesce(earliest_recurring_evidence, backfill_from)
    ),
    recurring_history_floor
  );

  -- One-time rows already have durable source IDs and dates. Copy them
  -- idempotently before applying the same legacy status rules as recurring rows.
  if to_regclass('public.one_time_payments') is not null then
    execute $query$
      insert into public.cashflow_occurrences (
        household_id, direction, source_kind, source_id, scheduled_on,
        label, expected_amount, status, is_inferred
      )
      select
        $1,
        'income',
        'one_time_income',
        payment.id,
        payment.payment_date,
        coalesce(nullif(btrim(payment.name), ''), 'One-time income'),
        greatest(coalesce(payment.amount, 0), 0),
        'planned',
        true
      from public.one_time_payments as payment
      where payment.user_id = $2
        and payment.household_id = $1
        and payment.archived_at is null
      on conflict on constraint cashflow_occurrences_source_date_key do nothing
    $query$
    using target_household, legacy_user_id;
  end if;

  if to_regclass('public.bills') is not null then
    execute $query$
      insert into public.cashflow_occurrences (
        household_id, direction, source_kind, source_id, scheduled_on,
        label, category, expected_amount, status, is_inferred, is_autodraft
      )
      select
        $1,
        'expense',
        'one_time_bill',
        bill.id,
        private.legacy_date_suffix(bill.due_date),
        coalesce(nullif(btrim(bill.name), ''), 'One-time bill'),
        coalesce(bill.category, ''),
        greatest(coalesce(bill.amount, 0), 0),
        'planned',
        true,
        coalesce(bill.is_autodraft, false)
      from public.bills as bill
      where bill.user_id = $2
        and bill.household_id = $1
        and bill.archived_at is null
        and not bill.is_recurring
        and private.legacy_date_suffix(bill.due_date) is not null
      on conflict on constraint cashflow_occurrences_source_date_key do nothing
    $query$
    using target_household, legacy_user_id;
  end if;

  -- These initial sources represent the legacy defaults. Moving their effective
  -- start backward is explicit reconstruction, and every generated row is marked
  -- inferred; durable occurrence amounts protect reviewed history afterward.
  update public.income_sources
  set effective_from = least(effective_from, backfill_from)
  where household_id = target_household
    and slug in ('salary', 'payday', 'instapay');

  perform private.materialize_income_occurrences(
    target_household, backfill_from, backfill_through, true
  );
  perform private.materialize_legacy_bill_occurrences(
    target_household, backfill_from, backfill_through, true, legacy_user_id
  );

  -- A recurring template may have moved to a different due day after a legacy
  -- occurrence was edited. Preserve the exact override date as that surviving
  -- source before considering the key orphaned; the generated same-period
  -- occurrence is suppressed after status reconciliation below.
  if to_regclass('public.bills') is not null then
    execute $query$
      insert into public.cashflow_occurrences (
        household_id, direction, source_kind, source_id, scheduled_on, label,
        category, expected_amount, status, is_inferred, is_autodraft,
        is_adjusted
      )
      select
        $1,
        'expense',
        'bill_template',
        bill.id::text,
        parsed.scheduled_on,
        coalesce(nullif(btrim(bill.name), ''), 'Bill'),
        coalesce(bill.category, ''),
        parsed.amount,
        'planned',
        true,
        coalesce(bill.is_autodraft, false),
        true
      from jsonb_each_text($2) as entry(key, value)
      cross join lateral (
        select
          regexp_replace(entry.key, '-[0-9]{4}-[0-9]{2}-[0-9]{2}$', '') as source_id,
          private.legacy_date_suffix(entry.key) as scheduled_on,
          private.legacy_nonnegative_amount(entry.value) as amount
      ) as parsed
      join public.bills as bill
        on bill.id::text = parsed.source_id
      where bill.user_id = $3
        and bill.household_id = $1
        and bill.archived_at is null
        and bill.is_recurring
        and parsed.source_id <> ''
        and parsed.scheduled_on is not null
        and parsed.amount is not null
      on conflict on constraint cashflow_occurrences_source_date_key do nothing
    $query$
    using target_household, legacy_bill_overrides, legacy_user_id;
  end if;

  -- A removed template can also leave a dated amount override behind. Preserve
  -- those recoverable dollars as standalone inferred bill occurrences only
  -- after surviving sources were restored above. Status-only keys without a
  -- source or amount cannot be reconstructed honestly and remain in untouched
  -- legacy JSON for manual review/export.
  insert into public.cashflow_occurrences (
    household_id, direction, source_kind, source_id, scheduled_on, label,
    expected_amount, status, is_inferred, is_adjusted
  )
  select
    target_household,
    'expense',
    'bill_template',
    parsed.source_id,
    parsed.scheduled_on,
    'Deleted bill (legacy)',
    parsed.amount,
    'planned',
    true,
    true
  from jsonb_each_text(legacy_bill_overrides) as entry(key, value)
  cross join lateral (
    select
      regexp_replace(entry.key, '-[0-9]{4}-[0-9]{2}-[0-9]{2}$', '') as source_id,
      private.legacy_date_suffix(entry.key) as scheduled_on,
      private.legacy_nonnegative_amount(entry.value) as amount
  ) as parsed
  where parsed.source_id <> ''
    and parsed.scheduled_on is not null
    and parsed.amount is not null
    and not exists (
      select 1
      from public.cashflow_occurrences as existing
      where existing.household_id = target_household
        and existing.direction = 'expense'
        and existing.source_kind = 'bill_template'
        and existing.source_id = parsed.source_id
        and existing.scheduled_on = parsed.scheduled_on
    )
  on conflict on constraint cashflow_occurrences_source_date_key do nothing;

  -- Occurrence-specific dollar edits win over defaults/templates.
  update public.cashflow_occurrences as occurrence
  set expected_amount = private.legacy_nonnegative_amount(
        legacy_income_overrides ->> occurrence.scheduled_on::text
      ),
      is_adjusted = true,
      is_inferred = true
  where occurrence.household_id = target_household
    and occurrence.direction = 'income'
    and occurrence.source_kind = 'income_source'
    and private.legacy_nonnegative_amount(
      legacy_income_overrides ->> occurrence.scheduled_on::text
    ) is not null;

  update public.cashflow_occurrences as occurrence
  set expected_amount = private.legacy_nonnegative_amount(
        legacy_bill_overrides ->> (
          occurrence.source_id || '-' || occurrence.scheduled_on::text
        )
      ),
      is_adjusted = true,
      is_inferred = true
  where occurrence.household_id = target_household
    and occurrence.direction = 'expense'
    and private.legacy_nonnegative_amount(
      legacy_bill_overrides ->> (
        occurrence.source_id || '-' || occurrence.scheduled_on::text
      )
    ) is not null;

  -- Reset inferred rows to the neutral planned state first. The normalization
  -- trigger clears any realized fields before the exact legacy rules below are
  -- applied. Household-local today avoids UTC-midnight classification errors.
  update public.cashflow_occurrences
  set status = 'planned', actual_amount = null, settled_at = null
  where household_id = target_household
    and is_inferred;

  update public.cashflow_occurrences as occurrence
  set status = 'settled',
      actual_amount = occurrence.expected_amount,
      settled_at = case
        when occurrence.scheduled_on < local_today
          then (occurrence.scheduled_on::timestamp + interval '12 hours')
               at time zone household_timezone
        else cutover_at
      end
  where occurrence.household_id = target_household
    and occurrence.direction = 'income'
    and occurrence.is_inferred
    and (
      occurrence.scheduled_on < local_today
      or lower(coalesce(
        legacy_cleared_income ->> case
          when occurrence.source_kind = 'one_time_income'
            then 'payment-' || occurrence.source_id || '-' || occurrence.scheduled_on::text
          else occurrence.scheduled_on::text
        end,
        ''
      )) in ('true', '1', 'yes', 'on')
    );

  update public.cashflow_occurrences as occurrence
  set status = 'settled',
      actual_amount = occurrence.expected_amount,
      settled_at = case
        when occurrence.scheduled_on < local_today
          then (occurrence.scheduled_on::timestamp + interval '12 hours')
               at time zone household_timezone
        else cutover_at
      end
  where occurrence.household_id = target_household
    and occurrence.direction = 'expense'
    and occurrence.is_inferred
    and case
      when occurrence.scheduled_on < local_today then
        lower(coalesce(
          legacy_unpaid_bills ->> (
            occurrence.source_id || '-' || occurrence.scheduled_on::text
          ),
          ''
        )) not in ('true', '1', 'yes', 'on')
      else
        lower(coalesce(
          legacy_paid_bills ->> (
            occurrence.source_id || '-' || occurrence.scheduled_on::text
          ),
          ''
        )) in ('true', '1', 'yes', 'on')
    end;

  -- When a surviving recurring bill has an exact override on a moved date,
  -- exclude the inferred occurrence generated from today's template for the
  -- same logical period. Monthly sources use the calendar month; weekly sources
  -- suppress only the closest unadjusted occurrence within six days. Explicit
  -- legacy evidence on the generated date prevents suppression.
  if to_regclass('public.bills') is not null then
    execute $query$
      with moved_override as (
        select
          bill.id::text as source_id,
          bill.recur_kind,
          parsed.scheduled_on
        from jsonb_each_text($2) as entry(key, value)
        cross join lateral (
          select
            regexp_replace(entry.key, '-[0-9]{4}-[0-9]{2}-[0-9]{2}$', '') as source_id,
            private.legacy_date_suffix(entry.key) as scheduled_on,
            private.legacy_nonnegative_amount(entry.value) as amount
        ) as parsed
        join public.bills as bill
          on bill.id::text = parsed.source_id
        where bill.user_id = $3
          and bill.household_id = $1
          and bill.archived_at is null
          and bill.is_recurring
          and parsed.scheduled_on is not null
          and parsed.amount is not null
      ),
      ranked_candidate as (
        select
          candidate.id,
          row_number() over (
            partition by moved.source_id, moved.scheduled_on
            order by abs(candidate.scheduled_on - moved.scheduled_on),
                     candidate.scheduled_on
          ) as proximity_rank
        from moved_override as moved
        join public.cashflow_occurrences as candidate
          on candidate.household_id = $1
         and candidate.direction = 'expense'
         and candidate.source_kind = 'bill_template'
         and candidate.source_id = moved.source_id
         and candidate.scheduled_on <> moved.scheduled_on
         and candidate.is_inferred
         and not candidate.is_adjusted
        where case
          when moved.recur_kind = 'weekly' then
            abs(candidate.scheduled_on - moved.scheduled_on) <= 6
          else
            date_trunc('month', candidate.scheduled_on::timestamp)
              = date_trunc('month', moved.scheduled_on::timestamp)
        end
          and not ($4 ? (candidate.source_id || '-' || candidate.scheduled_on::text))
          and not ($5 ? (candidate.source_id || '-' || candidate.scheduled_on::text))
          and not ($2 ? (candidate.source_id || '-' || candidate.scheduled_on::text))
      )
      update public.cashflow_occurrences as occurrence
      set status = 'skipped', actual_amount = null, settled_at = null
      from ranked_candidate as candidate
      where occurrence.id = candidate.id
        and candidate.proximity_rank = 1
    $query$
    using target_household, legacy_bill_overrides, legacy_user_id,
          legacy_paid_bills, legacy_unpaid_bills;
  end if;

  -- `is_inferred` is a historical-confidence marker, not a blanket migration
  -- marker. Today/future rows are deterministic plans from durable sources (or
  -- explicit legacy one-time rows/statuses), so only pre-cutover history keeps
  -- the inferred flag for later statement reconciliation.
  update public.cashflow_occurrences
  set is_inferred = false
  where household_id = target_household
    and scheduled_on >= local_today
    and is_inferred;
end;
$$;

revoke execute on function private.reconcile_legacy_finance_cutover(uuid, text, date) from public;
revoke execute on function private.reconcile_legacy_finance_cutover(uuid, text, date) from anon, authenticated;

select private.reconcile_legacy_finance_cutover(
  '00000000-0000-0000-0000-000000000000'::uuid,
  '00000000-0000-0000-0000-000000000000',
  null
);

commit;
