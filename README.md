# TinyTrain

TinyTrain is an offline-first workout tracker built with SvelteKit, Supabase, RxDB, and Dexie. The app is designed around fast session logging, local-first persistence, and cloud sync for authenticated users.

## Features

- Google sign-in through Supabase Auth.
- Local-first workout, exercise, session, and set storage.
- Supabase-backed sync with conflict reconciliation.
- Configurable previous-session comparison indicators for workout inputs, with an automatic
  device-preference migration and Bottom left as the default.
- App-wide inactivity recovery with a warning before stale sessions are safely abandoned.
- Progressive hydration for visible sessions, weeks, and workout lists.
- PWA app shell and service worker caching.
- Tracked export/import with preview and conflict-safe sync.

## Stack

- SvelteKit 2 and Svelte 5
- TypeScript with `strict` enabled
- Tailwind CSS 4
- RxDB with Dexie storage
- Supabase Auth and Postgres
- pnpm

## Getting Started

Install dependencies:

```sh
pnpm install
```

Start the dev server:

```sh
pnpm dev
```

Run the main checks:

```sh
pnpm check
pnpm lint
pnpm build
```

## Environment

The app reads Supabase config from public env vars first:

```sh
PUBLIC_SUPABASE_URL=
PUBLIC_SUPABASE_ANON_KEY=
```

For Vite-style local env files, these fallback names also work:

```sh
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

`src/lib/supabase.ts` is only the Supabase client/auth wrapper. It creates the browser Supabase client, handles Google OAuth helpers, exposes the current auth snapshot, and patches a PostgREST reserved-column edge case for the `"order"` column. The public persistence API is exported by `src/lib/db.ts`, with implementations in `src/lib/db/`.

## Project Layout

- `src/lib/db.ts`: stable app-facing database API facade.
- `src/lib/db/`: runtime, model, workout, exercise, and session persistence modules.
- `src/lib/db-cloud-sync.ts`: Supabase reconciliation, upload, remote merge, and recent-row hydration helpers used by the database runtime.
- `src/lib/progress-indicator-preference.ts`: versioned device preference and migration for workout comparison-indicator placement.
- `src/lib/session-inactivity.ts`: shared inactivity thresholds and time helpers for active-session recovery.
- `src/lib/rxdb.ts`: RxDB schema setup and Supabase replication wiring.
- `src/lib/rxdb-dexie-adapter.ts`: Dexie-like adapter around RxDB collections.
- `src/lib/tracked-import.ts`: Tracked export preview, import, and sync logic.
- `src/lib/features/`: Svelte feature components grouped by app area.
- `src/routes/`: SvelteKit routes and page shells.
- `docs/legacy-cleanup.md`: audit of removed startup-era code and retained compatibility paths.

## Data Flow

`db.ts` is the main boundary the UI imports. It re-exports the local database runtime and the focused workout, exercise, and session modules. Cloud sync is delegated to `db-cloud-sync.ts` so reconciliation rules stay separate from domain behavior.

The Supabase/RxDB path is:

1. `supabase.ts` resolves auth and creates the Supabase client.
2. `db/runtime.ts` opens the user-scoped RxDB/Dexie runtime.
3. `rxdb.ts` starts Supabase replication.
4. `db-cloud-sync.ts` handles explicit uploads, richest-row reconciliation, recent-row backfill, and remote row merges.

## Development Notes

- Prefer importing app data operations from `$lib/db`.
- Keep UI components out of direct Supabase calls unless there is a specific auth-only reason.
- Put cloud reconciliation behavior in `db-cloud-sync.ts`.
- Keep Tracked import behavior in `tracked-import.ts`.
- Keep the inline RxDB schemas aligned with the already-provisioned Supabase tables when changing
  persisted models.
- Add tests around the `db/` modules, `db-cloud-sync.ts`, and `tracked-import.ts` before changing sync or import semantics.
