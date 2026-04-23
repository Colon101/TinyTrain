<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';

	let {
		redirectPath = '/',
		showOpenApp = false
	}: { redirectPath?: string; showOpenApp?: boolean } = $props();

	type DatabaseApi = typeof import('$lib/db');
	type CloudUser = {
		name?: string;
		email?: string;
		isLoggedIn?: boolean;
		isLoading?: boolean;
		license?: {
			status?: string;
		};
	};
	type CloudSyncState = {
		phase?: string;
		status?: string;
		progress?: number;
		error?: Error;
		license?: string;
	};
	type SubscriptionLike = {
		unsubscribe(): void;
	};

	let api = $state<DatabaseApi | null>(null);
	let user = $state<CloudUser>({ isLoading: true });
	let syncState = $state<CloudSyncState>({ phase: 'initial', status: 'not-started' });
	let online = $state(true);
	let isBusy = $state(false);
	let actionMessage = $state('');
	let actionError = $state('');

	let isLoggedIn = $derived(Boolean(user?.isLoggedIn));
	let displayName = $derived(user?.name || user?.email || 'Google account');
	let syncLabel = $derived(getSyncLabel());
	let statusTone = $derived(getStatusTone());

	onMount(() => {
		let disposed = false;
		let userSubscription: SubscriptionLike | null = null;
		let syncSubscription: SubscriptionLike | null = null;

		function updateOnlineStatus() {
			online = navigator.onLine;
		}

		window.addEventListener('online', updateOnlineStatus);
		window.addEventListener('offline', updateOnlineStatus);
		updateOnlineStatus();

		void (async () => {
			const dbApi = await import('$lib/db');

			if (disposed) {
				return;
			}

			api = dbApi;
			try {
				await dbApi.ensureDbOpen();
			} catch (error) {
				actionError = getErrorMessage(error);
			}
			userSubscription = dbApi.db.cloud.currentUser.subscribe((nextUser) => {
				user = nextUser;
			});
			syncSubscription = dbApi.db.cloud.syncState.subscribe((nextSyncState) => {
				syncState = nextSyncState;
			});
		})();

		return () => {
			disposed = true;
			userSubscription?.unsubscribe();
			syncSubscription?.unsubscribe();
			window.removeEventListener('online', updateOnlineStatus);
			window.removeEventListener('offline', updateOnlineStatus);
		};
	});

	function getErrorMessage(error: unknown) {
		return error instanceof Error ? error.message : 'Something went wrong.';
	}

	function isOAuthRedirect(error: unknown) {
		return error instanceof Error && error.name === 'OAuthRedirectError';
	}

	async function runAction(action: (dbApi: DatabaseApi) => Promise<void>) {
		if (!api) {
			actionError = 'Account tools are still loading. Try again in a moment.';
			return;
		}

		isBusy = true;
		actionError = '';
		actionMessage = '';

		try {
			await api.ensureDbOpen();
			await action(api);
		} catch (error) {
			if (isOAuthRedirect(error)) {
				return;
			}

			actionError = getErrorMessage(error);
		} finally {
			isBusy = false;
		}
	}

	function signInWithGoogle() {
		void runAction(async (dbApi) => {
			actionMessage = 'Opening Google sign-in...';
			await dbApi.loginWithGoogle(redirectPath);
		});
	}

	function signOut() {
		void runAction(async (dbApi) => {
			await dbApi.logoutFromCloud();
			actionMessage = 'Signed out.';
		});
	}

	function syncNow() {
		void runAction(async (dbApi) => {
			await dbApi.syncNow();
			actionMessage = 'Sync checked.';
		});
	}

	function getSyncLabel() {
		if (!api || user?.isLoading) {
			return 'Loading';
		}

		if (!online) {
			return 'Offline';
		}

		if (!isLoggedIn) {
			return 'Sign in';
		}

		if (syncState.phase === 'pushing' || syncState.phase === 'pulling') {
			return 'Syncing changes';
		}

		if (syncState.phase === 'in-sync') {
			return 'Synced';
		}

		if (syncState.phase === 'offline' || syncState.status === 'offline') {
			return 'Offline';
		}

		if (syncState.phase === 'error' || syncState.status === 'error') {
			return 'Sync needs attention';
		}

		if (syncState.status === 'connecting') {
			return 'Connecting';
		}

		return 'Ready to sync';
	}

	function getStatusTone() {
		if (!online) return 'bg-amber-300';
		if (syncState.phase === 'error' || syncState.status === 'error') return 'bg-red-300';
		if (isLoggedIn && syncState.phase === 'in-sync') return 'bg-emerald-300';
		if (syncState.phase === 'pushing' || syncState.phase === 'pulling') return 'bg-sky-300';
		return 'bg-zinc-500';
	}
</script>

{#if isLoggedIn}
	<section class="border-y border-white/10 py-4" aria-label="Account and sync">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<p class="text-xs font-semibold tracking-[0.16em] text-emerald-200 uppercase">Signed in</p>
				<h2 class="mt-1 truncate text-lg font-semibold text-white">{displayName}</h2>
				<p class="mt-1 text-sm leading-5 text-zinc-400">{syncLabel}</p>
			</div>

			<span class={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${statusTone}`}></span>
		</div>

		<div class="mt-4 grid grid-cols-2 gap-2">
			{#if showOpenApp}
				<a
					class="col-span-2 flex min-h-11 items-center justify-center rounded-lg bg-emerald-300 px-3 text-sm font-bold text-zinc-950"
					href={resolve('/workouts')}
				>
					Open workouts
				</a>
			{/if}

			<button
				class="min-h-11 rounded-lg bg-emerald-300 px-3 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={!api || isBusy}
				onclick={syncNow}
			>
				Sync now
			</button>
			<button
				class="min-h-11 rounded-lg border border-white/10 px-3 text-sm font-semibold text-zinc-300 disabled:text-zinc-600"
				type="button"
				disabled={!api || isBusy}
				onclick={signOut}
			>
				Sign out
			</button>
		</div>

		{#if actionMessage || actionError}
			<p
				class={`mt-3 text-sm leading-5 ${actionError ? 'text-red-200' : 'text-zinc-400'}`}
				aria-live="polite"
			>
				{actionError || actionMessage}
			</p>
		{/if}
	</section>
{:else}
	<div aria-label="Sign in">
		<button
			class="min-h-12 w-full rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
			type="button"
			disabled={isBusy || !api}
			onclick={signInWithGoogle}
		>
			Continue with Google
		</button>

		{#if actionError}
			<p class="mt-3 text-sm leading-5 text-red-200" aria-live="polite">
				{actionError}
			</p>
		{:else if actionMessage}
			<p class="sr-only" aria-live="polite">
				{actionMessage}
			</p>
		{/if}
	</div>
{/if}
