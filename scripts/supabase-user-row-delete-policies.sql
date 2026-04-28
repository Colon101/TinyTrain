do $$
declare
  table_identifier text;
begin
  foreach table_identifier in array array[
    'exercises',
    'workouts',
    'workout_exercises',
    'workout_sessions',
    'session_exercises',
    'session_sets',
    'exercise_reset_events'
  ]
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_identifier
        and policyname = 'Users can delete own rows'
    ) then
      execute format(
        'create policy "Users can delete own rows" on public.%I for delete to authenticated using (auth.uid() = user_id)',
        table_identifier
      );
    end if;
  end loop;
end $$;
