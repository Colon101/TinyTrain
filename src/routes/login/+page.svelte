<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import AccountSync from '$lib/AccountSync.svelte';
	import InstallPrompt from '$lib/InstallPrompt.svelte';

	type SubscriptionLike = {
		unsubscribe(): void;
	};

	onMount(() => {
		let disposed = false;
		let currentUserSubscription: SubscriptionLike | null = null;

		void (async () => {
			const api = await import('$lib/db');

			if (disposed) {
				return;
			}

			currentUserSubscription = api.db.cloud.currentUser.subscribe((nextUser) => {
				if (nextUser.isLoggedIn) {
					void goto(resolve('/'), { replaceState: true });
				}
			});

			try {
				await api.ensureDbOpen();
			} catch {
				// Keep the sign-in UI usable even if IndexedDB bootstrap fails here.
			}
		})();

		return () => {
			disposed = true;
			currentUserSubscription?.unsubscribe();
		};
	});
</script>

<main
	class="mx-auto flex min-h-svh w-full max-w-[430px] flex-col justify-center bg-[#080b0d] px-4 py-8 text-zinc-100"
>
	<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">TinyTrain</p>
	<h1 class="mt-2 text-3xl font-semibold text-white">Sign in</h1>
	<p class="mt-2 text-sm leading-6 text-zinc-400">Continue with Google to open your tracker.</p>

	<div class="mt-6">
		<InstallPrompt />
	</div>

	<div class="mt-6">
		<AccountSync redirectPath="/" />
	</div>
</main>
