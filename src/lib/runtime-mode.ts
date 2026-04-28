export type AuthBackend = 'dexie-migration' | 'supabase';
export type StorageBackend = 'dexie-cloud-legacy' | 'supabase-rxdb';

export const AUTH_BACKEND: AuthBackend = 'dexie-migration';
export const ENABLE_SUPABASE_MIGRATION = true;
export const USE_SUPABASE_FOR_MIGRATED_USERS = true;

