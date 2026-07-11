-- The Dexie Cloud to Supabase migration completed before the Supabase-only
-- runtime was adopted. Nothing in the application reads or writes this table.
drop table if exists public.migration_status;
