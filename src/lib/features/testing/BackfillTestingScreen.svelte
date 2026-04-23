<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/ui/Icon.svelte';

	type DatabaseApi = typeof import('$lib/db');
	type BackfillSeedResult = import('$lib/db').BackfillSeedResult;

	let api = $state<DatabaseApi | null>(null);
	let result = $state<BackfillSeedResult | null>(null);
	let isSaving = $state(false);
	let message = $state('');
	let errorMessage = $state('');

	onMount(() => {
		void (async () => {
			api = await import('$lib/db');
		})();
	});

	async function seedExample() {
		if (!api) {
			return;
		}

		isSaving = true;
		errorMessage = '';
		message = '';

		try {
			result = await api.seedExampleBackfill();
			message = result.created
				? 'Example workout and session added for two days ago.'
				: 'Example workout already exists. Reusing the seeded session.';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
		} finally {
			isSaving = false;
		}
	}
</script>

<section class="flex flex-1 flex-col">
	<div class="pb-5">
		<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Testing</p>
		<h1 class="mt-2 text-3xl font-semibold text-white">Backfill</h1>
		<p class="mt-2 text-sm leading-6 text-zinc-400">
			Seed a sample completed session so the calendar and session overview have real data to render.
		</p>
	</div>

	<button
		class="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
		type="button"
		disabled={isSaving}
		onclick={seedExample}
	>
		{#if isSaving}
			<Icon name="database" class="h-5 w-5 animate-pulse" />
		{:else}
			<Icon name="sparkles" class="h-5 w-5" />
		{/if}
		Add example UI
	</button>

	{#if message}
		<p
			class="mt-4 rounded-lg border border-emerald-300/30 bg-emerald-500/10 px-3 py-3 text-sm leading-5 text-emerald-100"
		>
			{message}
		</p>
	{/if}

	{#if errorMessage}
		<p
			class="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
		>
			{errorMessage}
		</p>
	{/if}

	{#if result}
		<div class="mt-5 grid gap-3">
			<a
				class="flex min-h-11 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white"
				href={`/sessions/${result.sessionId}`}
			>
				Open example session
			</a>
			<a
				class="flex min-h-11 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white"
				href="/"
			>
				Open home
			</a>
		</div>
	{/if}
</section>
