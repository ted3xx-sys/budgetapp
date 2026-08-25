begin;

-- One-time entries are user-created planning rows, so household members may
-- permanently remove mistakes. Recurring and settled history remains protected.
create policy cashflow_occurrences_delete_one_time_for_members
on public.cashflow_occurrences for delete to authenticated
using (
  household_id in (select private.current_household_ids())
  and source_kind in ('one_time_bill', 'one_time_income')
  and status in ('planned', 'skipped')
);

grant delete on table public.cashflow_occurrences to authenticated;

commit;
