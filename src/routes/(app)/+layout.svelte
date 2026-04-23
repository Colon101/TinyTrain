<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import ProfileMenu from '$lib/features/app/ProfileMenu.svelte';
	import type { CloudUser } from '$lib/features/app/user';
	import Icon from '$lib/ui/Icon.svelte';

	type DatabaseApi = typeof import('$lib/db');
	type SubscriptionLike = {
		unsubscribe(): void;
	};

	const CALLBACK_TIMEOUT_MS = 15000;

	let { children } = $props();

	let currentUser = $state<CloudUser>({ isLoading: true });
	let isCheckingAuth = $state(true);
	let authError = $state('');
	let callbackTimedOut = $state(false);
	let isHandlingOAuthCallback = $derived(page.url.searchParams.has('dxc-auth'));
	let isHomePage = $derived(page.url.pathname === '/');

	onMount(() => {
		let disposed = false;
		let currentUserSubscription: SubscriptionLike | null = null;
		let callbackTimeoutId: ReturnType<typeof setTimeout> | null = null;

		function clearCallbackTimeout() {
			if (callbackTimeoutId) {
				clearTimeout(callbackTimeoutId);
				callbackTimeoutId = null;
			}
		}

		void (async () => {
			try {
				const api = (await import('$lib/db')) as DatabaseApi;

				if (disposed) {
					return;
				}

				currentUserSubscription = api.db.cloud.currentUser.subscribe((nextUser) => {
					currentUser = nextUser;

					if (nextUser.isLoading) {
						isCheckingAuth = true;
						return;
					}

					clearCallbackTimeout();

					if (!nextUser.isLoggedIn) {
						void goto('/login', { replaceState: true });
						return;
					}

					authError = '';
					callbackTimedOut = false;
					isCheckingAuth = false;
				});

				if (window.location.search.includes('dxc-auth=')) {
					callbackTimeoutId = setTimeout(() => {
						callbackTimedOut = true;
						authError = 'Google sign-in did not finish. Try again from the sign-in page.';
						isCheckingAuth = false;
					}, CALLBACK_TIMEOUT_MS);
				}

				await api.ensureDbOpen();
			} catch (error) {
				clearCallbackTimeout();
				authError = error instanceof Error ? error.message : 'Failed to open local storage.';
				isCheckingAuth = false;
			}
		})();

		return () => {
			disposed = true;
			clearCallbackTimeout();
			currentUserSubscription?.unsubscribe();
		};
	});

	function goBack() {
		if (window.history.length > 1) {
			window.history.back();
			return;
		}

		void goto('/');
	}
</script>

<main
	class="mx-auto flex min-h-svh w-full max-w-[430px] flex-col bg-[#080b0d] px-4 py-4 text-zinc-100"
>
	{#if isCheckingAuth}
		<section class="flex flex-1 flex-col justify-center">
			<div class="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
				<div class="h-full w-1/2 animate-pulse rounded-full bg-emerald-300"></div>
			</div>
			<h1 class="mt-5 text-2xl font-semibold text-white">
				{isHandlingOAuthCallback ? 'Finishing sign-in' : 'Loading TinyTrain'}
			</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				{isHandlingOAuthCallback ? 'Connecting your Google account.' : 'Opening your workspace.'}
			</p>
		</section>
	{:else if authError}
		<section class="flex flex-1 flex-col justify-center">
			<h1 class="text-3xl font-semibold text-white">Sign-in needs attention</h1>
			<p class="mt-3 text-sm leading-6 text-red-200">{authError}</p>
			<a
				class="mt-6 flex min-h-12 items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950"
				href="/login"
			>
				Back to login
			</a>
			{#if callbackTimedOut}
				<p class="mt-3 text-sm leading-5 text-zinc-400">
					The OAuth callback reached the app, but the local database never finished starting.
				</p>
			{/if}
		</section>
	{:else}
		{#if !isHomePage}
			<header class="flex items-center justify-between pb-3">
				<button
					class="flex min-h-10 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-medium text-zinc-300"
					type="button"
					onclick={goBack}
					aria-label="Go back"
				>
					<Icon name="arrow-left" class="h-4 w-4" />
				</button>

				<ProfileMenu user={currentUser} />
			</header>
		{/if}

		<div class="flex flex-1 flex-col pb-6">
			{@render children()}
		</div>
	{/if}
</main>
