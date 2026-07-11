create index if not exists exercises_user_modified_idx
on public.exercises (user_id, _modified desc);

create index if not exists workouts_user_modified_idx
on public.workouts (user_id, _modified desc);

create index if not exists workout_exercises_user_modified_idx
on public.workout_exercises (user_id, _modified desc);

create index if not exists workout_sessions_user_modified_idx
on public.workout_sessions (user_id, _modified desc);

create index if not exists session_exercises_user_modified_idx
on public.session_exercises (user_id, _modified desc);

create index if not exists session_sets_user_modified_idx
on public.session_sets (user_id, _modified desc);

create index if not exists exercise_reset_events_user_modified_idx
on public.exercise_reset_events (user_id, _modified desc);
