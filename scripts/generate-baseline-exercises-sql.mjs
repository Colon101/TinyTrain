import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/exercises.ts', import.meta.url), 'utf8');

function readNames(constName) {
	const match = source.match(new RegExp(String.raw`const ${constName} = \[([\s\S]*?)\n\];`));

	if (!match) {
		throw new Error(`Could not find ${constName}.`);
	}

	return [...match[1].matchAll(/'((?:[^'\\\\]|\\\\.)*)'/g)].map((entry) =>
		entry[1].replace(/\\'/g, "'")
	);
}

function normalizeName(name) {
	return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function hash32(input, seed) {
	let hash = seed >>> 0;

	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	return hash >>> 0;
}

function toHex32(value) {
	return value.toString(16).padStart(8, '0');
}

function createBaselineExerciseId(normalizedName) {
	const input = `tinytrain:baseline-exercise:${normalizeName(normalizedName)}`;
	const first = toHex32(hash32(input, 0x811c9dc5));
	const second = toHex32(hash32(input, 0x12345678));
	const third = toHex32(hash32(input, 0x9e3779b9));
	const fourth = toHex32(hash32(input, 0x85ebca6b));

	return `${first}-${second.slice(0, 4)}-5${second.slice(5, 8)}-a${third.slice(1, 4)}-${third.slice(4)}${fourth}`;
}

function sqlString(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

const bilateral = readNames('BILATERAL_EXERCISE_NAMES').map((name) => ({ name, unilateral: false }));
const unilateral = readNames('UNILATERAL_EXERCISE_NAMES').map((name) => ({ name, unilateral: true }));
const jointAction = readNames('JOINT_ACTION_EXERCISE_NAMES').map((name) => ({
	name,
	unilateral:
		name.startsWith('Single Arm') ||
		name.startsWith('Single Leg') ||
		name.startsWith('Single Side') ||
		name.startsWith('Unilateral')
}));
const exerciseByNormalizedName = new Map();

for (const exercise of [...bilateral, ...unilateral, ...jointAction]) {
	const normalizedName = normalizeName(exercise.name);

	if (!exerciseByNormalizedName.has(normalizedName)) {
		exerciseByNormalizedName.set(normalizedName, {
			...exercise,
			normalizedName,
			id: createBaselineExerciseId(normalizedName)
		});
	}
}

const exercises = [...exerciseByNormalizedName.values()].sort((first, second) =>
	first.name.localeCompare(second.name)
);
const values = exercises
	.map(
		(exercise) =>
			`  (${sqlString(exercise.id)}::uuid, ${sqlString(exercise.normalizedName)}, ${sqlString(
				exercise.name
			)}, ${exercise.unilateral ? 'true' : 'false'})`
	)
	.join(',\n');

const bootstrapSql = `-- TinyTrain Supabase full bootstrap for a new/empty project.
-- DANGER: this drops TinyTrain app tables and deletes Supabase Auth users.
-- Run this in the Supabase SQL Editor for the new project only.

begin;

drop table if exists
  public.exercise_reset_events,
  public.session_sets,
  public.session_exercises,
  public.workout_sessions,
  public.workout_exercises,
  public.workouts,
  public.exercises,
  public.migration_status,
  public.baseline_exercises
cascade;

delete from auth.users;

create table if not exists public.baseline_exercises (
  id uuid primary key,
  normalized_name text not null unique,
  name text not null,
  unilateral boolean not null default false,
  created_at timestamptz not null default '2026-04-01T00:00:00.000Z',
  updated_at timestamptz not null default '2026-04-01T00:00:00.000Z'
);

alter table public.baseline_exercises enable row level security;

create table public.exercises (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  "normalizedName" text not null,
  unilateral boolean not null default false,
  source text not null default 'custom' check (source in ('baseline', 'custom')),
  archived boolean not null default false,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null,
  _deleted boolean not null default false,
  _modified timestamptz not null default now()
);

create table public.workouts (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  "normalizedName" text not null,
  archived boolean not null default false,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null,
  _deleted boolean not null default false,
  _modified timestamptz not null default now()
);

create table public.workout_exercises (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  "workoutId" text not null,
  "exerciseId" text not null,
  "order" integer not null default 0,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null,
  _deleted boolean not null default false,
  _modified timestamptz not null default now()
);

create table public.workout_sessions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  "workoutId" text not null,
  "workoutNameSnapshot" text not null,
  "dayKey" text not null,
  "startedAt" timestamptz,
  "completedAt" timestamptz,
  status text not null check (status in ('planned', 'in_progress', 'completed', 'abandoned')),
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null,
  _deleted boolean not null default false,
  _modified timestamptz not null default now()
);

create table public.session_exercises (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  "sessionId" text not null,
  "workoutId" text not null,
  "exerciseId" text not null,
  "exerciseNameSnapshot" text not null,
  "order" integer not null default 0,
  "performedAt" timestamptz not null,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null,
  _deleted boolean not null default false,
  _modified timestamptz not null default now()
);

create table public.session_sets (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  "sessionExerciseId" text not null,
  "exerciseId" text not null,
  "order" integer not null default 0,
  side text not null default 'bilateral' check (side in ('bilateral', 'left', 'right')),
  "weightInput" text,
  "repsInput" text,
  "rirInput" text,
  weight numeric,
  reps numeric,
  rir numeric,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null,
  _deleted boolean not null default false,
  _modified timestamptz not null default now()
);

create table public.exercise_reset_events (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  "exerciseId" text not null,
  "resetAt" timestamptz not null,
  "createdAt" timestamptz not null,
  _deleted boolean not null default false,
  _modified timestamptz not null default now()
);

create table public.migration_status (
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

create index exercises_user_id_idx on public.exercises (user_id);
create index exercises_user_normalized_idx on public.exercises (user_id, "normalizedName");
create index workouts_user_id_idx on public.workouts (user_id);
create index workouts_user_normalized_idx on public.workouts (user_id, "normalizedName");
create index workout_exercises_user_workout_idx on public.workout_exercises (user_id, "workoutId");
create index workout_exercises_user_exercise_idx on public.workout_exercises (user_id, "exerciseId");
create index workout_sessions_user_workout_idx on public.workout_sessions (user_id, "workoutId");
create index workout_sessions_user_day_idx on public.workout_sessions (user_id, "dayKey");
create index workout_sessions_user_status_idx on public.workout_sessions (user_id, status);
create index session_exercises_user_session_idx on public.session_exercises (user_id, "sessionId");
create index session_exercises_user_exercise_idx on public.session_exercises (user_id, "exerciseId");
create index session_sets_user_session_exercise_idx on public.session_sets (user_id, "sessionExerciseId");
create index session_sets_user_exercise_idx on public.session_sets (user_id, "exerciseId");
create index exercise_reset_events_user_exercise_idx on public.exercise_reset_events (user_id, "exerciseId");

create or replace function public.set_tinytrain_modified()
returns trigger
language plpgsql
as $$
begin
  new._modified = now();
  return new;
end;
$$;

create trigger set_exercises_modified before insert or update on public.exercises
for each row execute function public.set_tinytrain_modified();
create trigger set_workouts_modified before insert or update on public.workouts
for each row execute function public.set_tinytrain_modified();
create trigger set_workout_exercises_modified before insert or update on public.workout_exercises
for each row execute function public.set_tinytrain_modified();
create trigger set_workout_sessions_modified before insert or update on public.workout_sessions
for each row execute function public.set_tinytrain_modified();
create trigger set_session_exercises_modified before insert or update on public.session_exercises
for each row execute function public.set_tinytrain_modified();
create trigger set_session_sets_modified before insert or update on public.session_sets
for each row execute function public.set_tinytrain_modified();
create trigger set_exercise_reset_events_modified before insert or update on public.exercise_reset_events
for each row execute function public.set_tinytrain_modified();

alter table public.exercises enable row level security;
alter table public.workouts enable row level security;
alter table public.workout_exercises enable row level security;
alter table public.workout_sessions enable row level security;
alter table public.session_exercises enable row level security;
alter table public.session_sets enable row level security;
alter table public.exercise_reset_events enable row level security;
alter table public.migration_status enable row level security;

do $$
declare
  table_identifier text;
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'baseline_exercises'
      and policyname = 'Anyone can read baseline exercises'
  ) then
    create policy "Anyone can read baseline exercises"
    on public.baseline_exercises
    for select
    to anon, authenticated
    using (true);
  end if;

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
    execute format('create policy "Users can read own rows" on public.%I for select to authenticated using (auth.uid() = user_id)', table_identifier);
    execute format('create policy "Users can insert own rows" on public.%I for insert to authenticated with check (auth.uid() = user_id)', table_identifier);
    execute format('create policy "Users can update own rows" on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', table_identifier);
    execute format('create policy "Users can delete own rows" on public.%I for delete to authenticated using (auth.uid() = user_id)', table_identifier);
  end loop;

  create policy "Users can read own migration status"
  on public.migration_status
  for select
  to authenticated
  using (auth.uid() = user_id);

  create policy "Users can insert own migration status"
  on public.migration_status
  for insert
  to authenticated
  with check (auth.uid() = user_id);

  create policy "Users can update own migration status"
  on public.migration_status
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
end $$;

alter table public.exercises replica identity full;
alter table public.workouts replica identity full;
alter table public.workout_exercises replica identity full;
alter table public.workout_sessions replica identity full;
alter table public.session_exercises replica identity full;
alter table public.session_sets replica identity full;
alter table public.exercise_reset_events replica identity full;

insert into public.baseline_exercises (id, normalized_name, name, unilateral)
values
${values}
on conflict (id) do update set
  normalized_name = excluded.normalized_name,
  name = excluded.name,
  unilateral = excluded.unilateral,
  updated_at = now();

commit;
`;

writeFileSync(new URL('supabase-bootstrap-new-project.sql', import.meta.url), bootstrapSql);
console.log(`Wrote ${exercises.length} baseline exercises.`);
