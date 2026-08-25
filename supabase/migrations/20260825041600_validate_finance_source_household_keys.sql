-- Validate the source-table household keys after the ledger cutover audit
-- confirmed that every legacy row points to an existing household.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.bills
  validate constraint bills_household_id_fkey;

alter table public.one_time_payments
  validate constraint one_time_payments_household_id_fkey;

commit;
