<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import InstallPrompt from '$lib/InstallPrompt.svelte';

	type SubscriptionLike = {
		unsubscribe(): void;
	};
	type DatabaseApi = typeof import('$lib/db');

	let api = $state<DatabaseApi | null>(null);
	let isBusy = $state(false);
	let actionError = $state('');

	onMount(() => {
		let disposed = false;
		let currentUserSubscription: SubscriptionLike | null = null;

		void (async () => {
			const dbApi = await import('$lib/db');

			if (disposed) {
				return;
			}

			api = dbApi;
			currentUserSubscription = dbApi.db.cloud.currentUser.subscribe((nextUser) => {
				if (nextUser.isLoggedIn) {
					void goto(resolve('/'), { replaceState: true });
				}
			});

			try {
				await dbApi.ensureDbOpen();
			} catch {
				// Keep the sign-in UI usable even if IndexedDB bootstrap fails here.
			}
		})();

		return () => {
			disposed = true;
			currentUserSubscription?.unsubscribe();
		};
	});

	function getErrorMessage(error: unknown) {
		return error instanceof Error ? error.message : 'Something went wrong.';
	}

	function isOAuthRedirect(error: unknown) {
		return error instanceof Error && error.name === 'OAuthRedirectError';
	}

	async function signIn() {
		if (!api) {
			actionError = 'Account tools are still loading. Try again in a moment.';
			return;
		}

		isBusy = true;
		actionError = '';

		try {
			await api.loginWithSupabaseGoogleForApp('/');
		} catch (error) {
			if (isOAuthRedirect(error)) {
				return;
			}

			actionError = getErrorMessage(error);
		} finally {
			isBusy = false;
		}
	}
</script>

<main
	class="mx-auto flex min-h-svh w-full max-w-[460px] flex-col justify-center bg-[#080b0d] px-4 py-8 text-zinc-100"
>
	<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">TinyTrain</p>
	<h1 class="mt-2 text-3xl font-semibold text-white">Sign in</h1>
	<p class="mt-2 text-sm leading-6 text-zinc-400">Sign in to sync your workouts across devices.</p>

	<div class="mt-6">
		<InstallPrompt />
	</div>

	<div class="mt-6 space-y-3">
		<section class="border-y border-white/10 py-4">
			<p class="text-xs font-semibold tracking-[0.16em] text-emerald-200 uppercase">Cloud sync</p>
			<h2 class="mt-1 text-lg font-semibold text-white">Continue to TinyTrain</h2>
			<p class="mt-1 text-sm leading-6 text-zinc-400">
				Your workouts stay in sync and remain available offline on this device.
			</p>
			<button
				class="mt-4 min-h-12 w-full rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={!api || Boolean(isBusy)}
				onclick={signIn}
			>
				{isBusy ? 'Opening Google...' : 'Continue with Google'}
			</button>
		</section>
	</div>

	{#if actionError}
		<p class="mt-4 text-sm leading-5 text-red-200" aria-live="polite">{actionError}</p>
	{/if}
</main>
