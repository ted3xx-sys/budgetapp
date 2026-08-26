begin;

select plan(10);

select has_function(
  'public',
  'save_one_time_bill',
  array['text', 'text', 'uuid', 'text', 'numeric', 'date', 'text', 'boolean'],
  'one-time bills have an atomic save function'
);

select has_function(
  'public',
  'save_one_time_payment',
  array['text', 'text', 'uuid', 'text', 'numeric', 'date'],
  'one-time payments have an atomic save function'
);

select has_function(
  'public',
  'update_one_time_occurrence',
  array['uuid', 'text', 'numeric', 'date', 'text', 'boolean'],
  'one-time edits have an atomic update function'
);

select has_function(
  'public',
  'remove_one_time_occurrence',
  array['uuid'],
  'one-time removals have a public transaction boundary'
);

select has_function(
  'private',
  'remove_one_time_occurrence',
  array['uuid'],
  'one-time removal implementation is outside the exposed API schema'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.save_one_time_bill(text,text,uuid,text,numeric,date,text,boolean)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.save_one_time_payment(text,text,uuid,text,numeric,date)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.update_one_time_occurrence(uuid,text,numeric,date,text,boolean)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.remove_one_time_occurrence(uuid)',
    'execute'
  ),
  'authenticated users can call each one-time transaction function'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.save_one_time_bill(text,text,uuid,text,numeric,date,text,boolean)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.save_one_time_payment(text,text,uuid,text,numeric,date)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.update_one_time_occurrence(uuid,text,numeric,date,text,boolean)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.remove_one_time_occurrence(uuid)',
    'execute'
  ),
  'anonymous users cannot call one-time transaction functions'
);

select ok(
  not has_table_privilege('authenticated', 'public.cashflow_occurrences', 'delete'),
  'authenticated users cannot directly delete ledger rows'
);

select is(
  (
    select count(*)
    from public.cashflow_occurrences as occurrence
    where occurrence.status in ('planned', 'skipped')
      and occurrence.source_kind in ('one_time_income', 'one_time_bill')
      and not exists (
        select 1
        from public.one_time_payments as payment
        where occurrence.source_kind = 'one_time_income'
          and payment.household_id = occurrence.household_id
          and payment.id = occurrence.source_id
          and payment.archived_at is null
          and payment.payment_date = occurrence.scheduled_on
        union all
        select 1
        from public.bills as bill
        where occurrence.source_kind = 'one_time_bill'
          and bill.household_id = occurrence.household_id
          and bill.id = occurrence.source_id
          and bill.archived_at is null
          and not bill.is_recurring
          and private.legacy_date_suffix(bill.due_date) = occurrence.scheduled_on
      )
  ),
  0::bigint,
  'no open one-time occurrence is detached from its active source and date'
);

select is(
  (
    select count(*)
    from (
      select payment.household_id, 'one_time_income'::text as source_kind,
        payment.id as source_id, payment.payment_date as scheduled_on
      from public.one_time_payments as payment
      where payment.archived_at is null
      union all
      select bill.household_id, 'one_time_bill', bill.id,
        private.legacy_date_suffix(bill.due_date)
      from public.bills as bill
      where bill.archived_at is null
        and not bill.is_recurring
        and private.legacy_date_suffix(bill.due_date) is not null
    ) as source
    where not exists (
      select 1
      from public.cashflow_occurrences as occurrence
      where occurrence.household_id = source.household_id
        and occurrence.source_kind = source.source_kind
        and occurrence.source_id = source.source_id
        and occurrence.scheduled_on = source.scheduled_on
    )
  ),
  0::bigint,
  'every dated active one-time source has a durable occurrence'
);

select * from finish();
rollback;
