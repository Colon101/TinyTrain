create table if not exists public.migration_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  dexie_user_id text,
  dexie_email text,
  status text not null check (status in ('not_started', 'running', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  dexie_counts jsonb not null default '{}'::jsonb,
  supabase_counts jsonb not null default '{}'::jsonb,
  logs jsonb not null default '[]'::jsonb,
  app_version text,
  updated_at timestamptz not null default now()
);

alter table public.migration_status enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'migration_status'
      and policyname = 'Users can read own migration status'
  ) then
    create policy "Users can read own migration status"
    on public.migration_status
    for select
    to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'migration_status'
      and policyname = 'Users can insert own migration status'
  ) then
    create policy "Users can insert own migration status"
    on public.migration_status
    for insert
    to authenticated
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'migration_status'
      and policyname = 'Users can update own migration status'
  ) then
    create policy "Users can update own migration status"
    on public.migration_status
    for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;
end $$;

