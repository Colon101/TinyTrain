# Legacy cleanup audit

This audit records the startup-era code and infrastructure found in TinyTrain and the disposition of each item. It was assembled from the repository history and a reference search across the current application.

## Removed

### Dexie Cloud migration remnants

TinyTrain originally supported a Dexie Cloud runtime and later introduced a staged migration to Supabase. Commit `ffce0b3` removed the Dexie Cloud runtime, but a single-value `StorageBackend` switch and repeated `supabase-rxdb` branches remained in the database runtime. They could no longer select another backend.

The redundant backend state, `runtime-mode.ts`, backend-status UI, and Supabase-only conditional branches have been removed. Authentication, storage recovery, hydration, and sync now express the only supported runtime directly.

The original Supabase bootstrap also created `public.migration_status`, which belonged to the removed Dexie Cloud migration flow. Migration `20260711170000_drop_legacy_migration_status.sql` removes that unused table from existing databases. The original migration is intentionally left unchanged because applied migrations are immutable history.

### Development-only data tools

The following unlinked routes were available only in development builds:

- `/testing/backfill` manually created completed historical sessions and carried demo workout seed helpers in the production database module.
- `/testing/recovery` repaired timestamps produced by an older version of the Tracked importer.
- `/testing/customization` was the interactive prototype for comparison-indicator placement. The supported version now lives in Settings.

The routes, their three feature components, and their private database/import APIs have been removed. The supported Tracked import flow remains in Settings, and normal session creation and editing are unchanged.

### Supabase bootstrap scratch files

The `scripts/` directory contained a duplicate of the first migration, a destructive reset-and-seed script, two one-off policy/migration scripts, and a generator that rewrote the duplicate bootstrap file. These were useful while the first Supabase project was being assembled, but the canonical schema is now the ordered migration set in `supabase/migrations/`.

Those scratch files were removed to prevent an old bootstrap from being mistaken for the deployment path. New schema changes must be added as new migrations; existing migration files must not be regenerated or edited.

### No-op baseline seeding

`ensureBaselineExercises()` only had an implementation for the removed backend. Under the Supabase/RxDB backend it returned immediately, while baseline exercises are already supplied by the canonical dataset and database migrations. The no-op API and its startup call were removed.

## Retained compatibility

These items may look historical but still protect active users or current installs:

- The RxDB workout-session schema migration converts old `startedAt: null` values to an omitted optional field. Removing it can prevent an existing browser database from opening.
- The `tinytrain-testing-delta-position` preference read migrates a value from the former customization prototype into the supported versioned preference. It is a bounded, one-time client-data migration.
- The service worker deployment manifest and generated deployment ID drive visible update detection and cache refreshes; they are current PWA infrastructure, not deployment leftovers.
- Progressive “backfill” in `db-cloud-sync.ts` hydrates recent cloud rows into the local-first cache. Despite the name, it is part of current sync behavior and is unrelated to the removed manual backfill screen.
- `rxdb-dexie-adapter.ts` uses Dexie as RxDB's IndexedDB storage adapter. It does not restore the removed Dexie Cloud backend.

## Maintenance rule

Keep compatibility code only while it has a live data or installation path. Mark future compatibility shims with the data version they support and remove them in a later migration once that version is no longer supported. Keep experiments outside production feature modules, and delete prototypes when their supported implementation ships.
