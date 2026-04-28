<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		MIGRATION_APP_VERSION,
		ensureSupabaseMigrationLogin,
		getMigrationStatus,
		recordMigrationFailure,
		runSupabaseMigration,
		type MigrationLogEntry,
		type MigrationStatus,
		type MigrationStatusRow
	} from '$lib/migration/supabase-migration';
	import { getSupabaseUser } from '$lib/supabase';

	type DexieUser = {
		name?: string;
		email?: string;
		isLoggedIn?: boolean;
		isLoading?: boolean;
	};
	type DatabaseApi = typeof import('$lib/db');
	type SubscriptionLike = {
		unsubscribe(): void;
	};

	let api = $state<DatabaseApi | null>(null);
	let dexieUser = $state<DexieUser>({ isLoading: true });
	let supabaseEmail = $state('');
	let status = $state<MigrationStatus>('not_started');
	let logs = $state<MigrationLogEntry[]>([]);
	let isBusy = $state(false);
	let errorMessage = $state('');
	let completedStatus = $state<MigrationStatusRow | null>(null);

	let dexieLabel = $derived(
		dexieUser.isLoading
			? 'Checking Dexie Cloud'
			: dexieUser.isLoggedIn
				? dexieUser.email || dexieUser.name || 'Signed in'
				: 'Not signed in'
	);
	let supabaseLabel = $derived(supabaseEmail || 'Not signed in');
	let canRunMigration = $derived(Boolean(dexieUser.isLoggedIn) && Boolean(supabaseEmail) && !isBusy);
	let needsMigrationRebuild = $derived(
		Boolean(completedStatus && completedStatus.app_version !== MIGRATION_APP_VERSION)
	);

	onMount(() => {
		let disposed = false;
		let subscription: SubscriptionLike | null = null;

		void (async () => {
			const dbApi = await import('$lib/db');

			if (disposed) {
				return;
			}

			api = dbApi;
			await dbApi.ensureDbOpen();
			subscription = dbApi.legacyDb.cloud.currentUser.subscribe((nextUser) => {
				dexieUser = nextUser;
			});
			await refreshSupabaseState();
		})();

		return () => {
			disposed = true;
			subscription?.unsubscribe();
		};
	});

	function appendLog(entry: MigrationLogEntry) {
		logs = [...logs, entry];
	}

	function getMessage(error: unknown) {
		return error instanceof Error ? error.message : 'Something went wrong.';
	}

	async function refreshSupabaseState() {
		const user = await getSupabaseUser();
		supabaseEmail = user?.email ?? '';

		if (!user) {
			return;
		}

		const migrationStatus = await getMigrationStatus(user.id).catch(() => null);

		if (migrationStatus) {
			status = migrationStatus.status;
			completedStatus = migrationStatus.status === 'completed' ? migrationStatus : null;
			logs = migrationStatus.logs ?? [];
		}
	}

	async function signInSupabase() {
		isBusy = true;
		errorMessage = '';

		try {
			await ensureSupabaseMigrationLogin('/migrate/supabase');
			await refreshSupabaseState();
		} catch (error) {
			errorMessage = getMessage(error);
		} finally {
			isBusy = false;
		}
	}

	async function migrate() {
		isBusy = true;
		errorMessage = '';
		status = 'running';
		logs = [];

		try {
			completedStatus = await runSupabaseMigration(appendLog);
			status = 'completed';
		} catch (error) {
			status = 'failed';
			errorMessage = getMessage(error);
			appendLog({
				id: crypto.randomUUID?.() ?? `${Date.now()}`,
				level: 'error',
				message: errorMessage,
				createdAt: new Date().toISOString()
			});
			const user = await getSupabaseUser();

			if (user) {
				await recordMigrationFailure(user.id, error, logs).catch(() => undefined);
			}
		} finally {
			isBusy = false;
		}
	}

	function openApp() {
		void goto(resolve('/'));
	}
</script>

<svelte:head>
	<title>Migrate to Supabase · TinyTrain</title>
</svelte:head>

<section class="flex min-h-0 flex-1 flex-col overflow-hidden pt-14">
	<div class="shrink-0 border-b border-white/10 pb-4">
		<p class="text-xs font-semibold tracking-[0.16em] text-emerald-200 uppercase">Migration</p>
		<h1 class="mt-2 text-2xl font-semibold text-white">Move TinyTrain to Supabase</h1>
		<p class="mt-2 text-sm leading-6 text-zinc-400">
			Copy your current Dexie Cloud data into the new offline Supabase sync backend.
		</p>
	</div>

	<div class="grid shrink-0 gap-2 border-b border-white/10 py-4">
		<div class="flex min-h-11 items-center justify-between gap-3">
			<div class="min-w-0">
				<p class="text-xs font-semibold text-zinc-500 uppercase">Dexie Cloud</p>
				<p class="mt-1 truncate text-sm text-zinc-200">{dexieLabel}</p>
			</div>
			<span class={`h-2.5 w-2.5 rounded-full ${dexieUser.isLoggedIn ? 'bg-emerald-300' : 'bg-amber-300'}`}></span>
		</div>

		<div class="flex min-h-11 items-center justify-between gap-3">
			<div class="min-w-0">
				<p class="text-xs font-semibold text-zinc-500 uppercase">Supabase</p>
				<p class="mt-1 truncate text-sm text-zinc-200">{supabaseLabel}</p>
			</div>
			<span class={`h-2.5 w-2.5 rounded-full ${supabaseEmail ? 'bg-emerald-300' : 'bg-amber-300'}`}></span>
		</div>
	</div>

	<div class="grid shrink-0 gap-2 py-4">
		{#if !supabaseEmail}
			<button
				class="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={isBusy}
				onclick={signInSupabase}
			>
				{#if isBusy}
					<Icon name="loader-circle" class="h-4 w-4 animate-spin" />
				{:else}
					<Icon name="arrow-right" class="h-4 w-4" />
				{/if}
				Sign in to Supabase
			</button>
		{:else if status === 'completed' && !needsMigrationRebuild}
			<button
				class="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950"
				type="button"
				onclick={openApp}
			>
				<Icon name="check-circle" class="h-4 w-4" />
				Open TinyTrain
			</button>
		{:else}
			<button
				class="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={!canRunMigration}
				onclick={migrate}
			>
				{#if isBusy}
					<Icon name="loader-circle" class="h-4 w-4 animate-spin" />
				{:else}
					<Icon name="database" class="h-4 w-4" />
				{/if}
				{needsMigrationRebuild ? 'Rebuild migration' : status === 'failed' ? 'Retry migration' : 'Start migration'}
			</button>
		{/if}

		{#if completedStatus && !needsMigrationRebuild}
			<p class="text-sm leading-6 text-emerald-200">Synced with Supabase.</p>
		{:else if needsMigrationRebuild}
			<p class="text-sm leading-6 text-amber-200">
				This account was migrated with the old per-user baseline exercise layout. Rebuild once to
				share built-in exercises.
			</p>
		{/if}

		{#if errorMessage}
			<p class="text-sm leading-6 text-red-200">{errorMessage}</p>
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-auto border-t border-white/10 pt-4">
		<div class="mb-3 flex items-center justify-between gap-3">
			<h2 class="text-sm font-semibold text-white">Migration log</h2>
			<p class="text-xs text-zinc-500">{status}</p>
		</div>

		{#if logs.length === 0}
			<p class="text-sm leading-6 text-zinc-500">Logs will appear here when migration starts.</p>
		{:else}
			<ol class="space-y-2 pb-8">
				{#each logs as log (log.id)}
					<li
						class={`rounded-md border px-3 py-2 text-sm leading-5 ${
							log.level === 'error'
								? 'border-red-300/20 bg-red-300/5 text-red-100'
								: log.level === 'success'
									? 'border-emerald-300/20 bg-emerald-300/5 text-emerald-100'
									: 'border-white/10 bg-white/[0.03] text-zinc-300'
						}`}
					>
						<p>{log.message}</p>
						<p class="mt-1 text-xs text-zinc-500">{new Date(log.createdAt).toLocaleTimeString()}</p>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</section>
