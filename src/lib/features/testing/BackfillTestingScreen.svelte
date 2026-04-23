<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/ui/Icon.svelte';

	type DatabaseApi = typeof import('$lib/db');
	type BackfillSeedResult = import('$lib/db').BackfillSeedResult;
	type BackfillMode = 'baseline' | 'improved';

	let api = $state<DatabaseApi | null>(null);
	let result = $state<BackfillSeedResult | null>(null);
	let isSaving = $state(false);
	let message = $state('');
	let errorMessage = $state('');
	let resultLabel = $state('example session');

	onMount(() => {
		void (async () => {
			api = await import('$lib/db');
		})();
	});

	async function seedExample(mode: BackfillMode) {
		if (!api) {
			return;
		}

		isSaving = true;
		errorMessage = '';
		message = '';

		try {
			result =
				mode === 'improved' ? await api.seedImprovedBackfill() : await api.seedExampleBackfill();
			resultLabel =
				mode === 'improved' ? "yesterday's improved session" : 'the older example session';

			if (mode === 'improved') {
				message = result.created
					? "Yesterday's improved session is ready. Open it to see progress against the earlier workout."
					: "Yesterday's improved session already exists. Open it to inspect the progress view.";
			} else {
				message = result.created
					? 'Example workout and session added for two days ago.'
					: 'Example workout already exists. Reusing the older seeded session.';
			}
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
			Seed sample completed sessions so the calendar and session overview have real data, including
			a yesterday improvement for the progress comparison.
		</p>
	</div>

	<div class="grid gap-3">
		<button
			class="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
			type="button"
			disabled={isSaving}
			onclick={() => seedExample('baseline')}
		>
			{#if isSaving}
				<Icon name="database" class="h-5 w-5 animate-pulse" />
			{:else}
				<Icon name="sparkles" class="h-5 w-5" />
			{/if}
			Add older example session
		</button>

		<button
			class="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-base font-semibold text-white disabled:text-zinc-500"
			type="button"
			disabled={isSaving}
			onclick={() => seedExample('improved')}
		>
			<Icon name="refresh-cw" class={`h-5 w-5 ${isSaving ? 'animate-spin' : ''}`} />
			Add yesterday improvement
		</button>
	</div>

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
				Open {resultLabel}
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
