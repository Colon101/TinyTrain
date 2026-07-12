<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import type { SyncProgress } from '$lib/db';
	import type { CloudUser } from './user';
	import { getUserDisplayName, getUserInitials } from './user';

	type DatabaseApi = typeof import('$lib/db');
	const MANUAL_SYNC_DISMISS_DELAY_MS = 15_000;

	let { user }: { user: CloudUser } = $props();

	let api = $state<DatabaseApi | null>(null);
	let isOpen = $state(false);
	let isBusy = $state(false);
	let isManualSyncing = $state(false);
	let isManualSyncOverlayOpen = $state(false);
	let canDismissManualSync = $state(false);
	let syncProgress = $state<SyncProgress>({ completedTables: 0, totalTables: 7 });
	let actionMessage = $state('');
	let actionError = $state('');
	let container = $state<HTMLElement | null>(null);
	let manualSyncDismissTimeout: ReturnType<typeof setTimeout> | null = null;
	let manualSyncWasDismissed = $state(false);

	let displayName = $derived(getUserDisplayName(user));
	let initials = $derived(getUserInitials(user));
	let syncProgressPercent = $derived(
		Math.round((syncProgress.completedTables / Math.max(syncProgress.totalTables, 1)) * 100)
	);

	onMount(() => {
		function handlePointerDown(event: PointerEvent) {
			const target = event.target as Node | null;

			if (container && target && !container.contains(target)) {
				isOpen = false;
			}
		}

		window.addEventListener('pointerdown', handlePointerDown);

		void import('$lib/db')
			.then((dbApi) => {
				api = dbApi;
			})
			.catch(() => {
				actionError = 'Account tools failed to load. Reload and try again.';
			});

		return () => {
			if (manualSyncDismissTimeout) {
				clearTimeout(manualSyncDismissTimeout);
			}
			window.removeEventListener('pointerdown', handlePointerDown);
		};
	});

	function clearManualSyncDismissTimeout() {
		if (manualSyncDismissTimeout) {
			clearTimeout(manualSyncDismissTimeout);
			manualSyncDismissTimeout = null;
		}
	}

	function dismissManualSyncOverlay() {
		if (!canDismissManualSync) return;

		manualSyncWasDismissed = true;
		isManualSyncOverlayOpen = false;
		actionMessage = 'Sync is still running in the background.';
	}

	async function runAction(action: (dbApi: DatabaseApi) => Promise<void>) {
		if (!api) {
			actionError = 'Account tools are still loading. Try again in a moment.';
			return false;
		}

		isBusy = true;
		actionMessage = '';
		actionError = '';

		try {
			await api.ensureDbOpen();
			await action(api);
			return true;
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Something went wrong.';
			return false;
		} finally {
			isBusy = false;
		}
	}

	function syncNow() {
		void (async () => {
			isManualSyncing = true;
			isManualSyncOverlayOpen = true;
			canDismissManualSync = false;
			manualSyncWasDismissed = false;
			syncProgress = { completedTables: 0, totalTables: 7 };
			isOpen = false;
			clearManualSyncDismissTimeout();
			manualSyncDismissTimeout = setTimeout(() => {
				canDismissManualSync = true;
			}, MANUAL_SYNC_DISMISS_DELAY_MS);

			const didSync = await runAction(async (dbApi) => {
				await dbApi.syncNow({
					onProgress: (progress) => {
						syncProgress = progress;
					}
				});
			});

			clearManualSyncDismissTimeout();
			isManualSyncing = false;
			isManualSyncOverlayOpen = false;

			if (didSync && !manualSyncWasDismissed) {
				window.location.reload();
			} else if (didSync) {
				actionMessage = 'Sync finished.';
			} else if (!manualSyncWasDismissed) {
				isOpen = true;
			}
		})();
	}

	function signOut() {
		void runAction(async (dbApi) => {
			await dbApi.logoutFromCloud();
			isOpen = false;
		});
	}
</script>

{#if isManualSyncing && isManualSyncOverlayOpen}
	<div
		class="fixed inset-0 z-50 grid place-items-center bg-zinc-950/85 px-5 backdrop-blur-md"
		role="dialog"
		aria-modal="true"
		aria-labelledby="manual-sync-title"
		aria-describedby="manual-sync-description"
	>
		<div
			class="grid w-full max-w-sm gap-5 rounded-2xl border border-emerald-200/20 bg-zinc-950 p-6 text-center shadow-2xl shadow-emerald-950/30"
		>
			<div
				class="mx-auto grid h-16 w-16 place-items-center rounded-full border border-emerald-200/25 bg-emerald-300/10 text-emerald-100"
			>
				<Icon name="loader-circle" class="h-8 w-8 animate-spin" />
			</div>
			<div class="grid gap-2">
				<p id="manual-sync-title" class="text-xl font-semibold text-white">Syncing</p>
				<p class="text-sm font-semibold text-zinc-300">
					{syncProgress.completedTables} / {syncProgress.totalTables} synced
				</p>
				<p id="manual-sync-description" class="text-sm leading-6 text-zinc-400">
					{canDismissManualSync
						? 'Sync is taking longer than expected. You can hide this window and keep using TinyTrain while it continues in the background.'
						: 'Keep TinyTrain open while your local workouts are reconciled with the cloud.'}
				</p>
			</div>
			<div
				class="h-2.5 overflow-hidden rounded-full bg-white/10"
				aria-label={`Sync progress ${syncProgressPercent}%`}
			>
				<div
					class="h-full rounded-full bg-emerald-300 transition-all duration-300"
					style={`width: ${syncProgressPercent}%`}
				></div>
			</div>
			{#if canDismissManualSync}
				<button
					class="min-h-11 rounded-lg border border-white/15 px-4 text-sm font-semibold text-zinc-100 transition hover:bg-white/8"
					type="button"
					onclick={dismissManualSyncOverlay}
				>
					Keep using app
				</button>
			{/if}
		</div>
	</div>
{/if}

{#if isManualSyncing && !isManualSyncOverlayOpen}
	<div
		class="fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-lg border border-emerald-200/20 bg-zinc-950 px-4 py-3 text-sm font-medium text-zinc-200 shadow-xl"
		role="status"
	>
		<Icon name="loader-circle" class="h-4 w-4 animate-spin text-emerald-200" />
		<span>Sync is continuing in the background.</span>
	</div>
{/if}

{#if !isManualSyncing && manualSyncWasDismissed && actionError}
	<div
		class="fixed right-4 bottom-4 z-40 max-w-sm rounded-lg border border-red-300/25 bg-zinc-950 px-4 py-3 text-sm font-medium text-red-100 shadow-xl"
		role="alert"
	>
		{actionError}
	</div>
{/if}

<div class="relative" bind:this={container}>
	<button
		class="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/6 text-sm font-semibold text-white transition hover:border-emerald-300/50 hover:bg-white/10"
		type="button"
		title="Open account menu"
		aria-expanded={isOpen}
		onclick={() => (isOpen = !isOpen)}
	>
		<span>{initials}</span>
	</button>

	{#if isOpen}
		<div
			class="absolute top-[calc(100%+0.75rem)] right-0 z-30 w-64 rounded-lg border border-white/10 bg-[#11171a] p-2 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
		>
			<div class="border-b border-white/10 px-3 py-3">
				<p class="truncate text-sm font-semibold text-white">{displayName}</p>
				{#if user.email}
					<p class="mt-1 truncate text-xs text-zinc-400">{user.email}</p>
				{/if}
			</div>

			<div class="pt-2">
				<a
					class="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-zinc-200 transition hover:bg-white/6"
					href={resolve('/settings')}
					onclick={() => (isOpen = false)}
				>
					<Icon name="settings" class="h-4 w-4" />
					<span>Settings</span>
				</a>

				<button
					class="mt-1 flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-zinc-200 transition hover:bg-white/6 disabled:text-zinc-500"
					type="button"
					disabled={!api || isBusy}
					onclick={syncNow}
				>
					{#if isBusy}
						<Icon name="loader-circle" class="h-4 w-4 animate-spin" />
					{:else}
						<Icon name="refresh-cw" class="h-4 w-4" />
					{/if}
					<span>Sync now</span>
				</button>

				<button
					class="mt-1 flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-zinc-200 transition hover:bg-white/6 disabled:text-zinc-500"
					type="button"
					disabled={!api || isBusy}
					onclick={signOut}
				>
					<Icon name="log-out" class="h-4 w-4" />
					<span>Log out</span>
				</button>
			</div>

			{#if actionError || actionMessage}
				<p
					class={`px-3 pt-3 pb-1 text-xs leading-5 ${actionError ? 'text-red-200' : 'text-zinc-400'}`}
				>
					{actionError || actionMessage}
				</p>
			{/if}
		</div>
	{/if}
</div>
