begin;

alter table public.workout_sessions
  add column if not exists "lastInputAt" timestamptz;

update public.workout_sessions
set "lastInputAt" = "startedAt"
where status = 'in_progress'
  and "lastInputAt" is null
  and "startedAt" is not null;

commit;
