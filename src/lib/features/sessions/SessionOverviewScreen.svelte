<script lang="ts">
	import { onMount } from 'svelte';
	import type { SessionOverview } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		formatDayHeading,
		formatDuration,
		formatSessionStatus,
		formatSetLine,
		formatSessionTime
	} from './session-format';

	type DatabaseApi = typeof import('$lib/db');

	let { sessionId }: { sessionId: string } = $props();

	let api = $state<DatabaseApi | null>(null);
	let overview = $state<SessionOverview | null>(null);
	let isLoading = $state(true);
	let errorMessage = $state('');
	let nowMs = $state(Date.now());

	let isRunning = $derived(
		Boolean(overview?.summary.status === 'in_progress' && !overview.summary.completedAt)
	);

	onMount(() => {
		let disposed = false;
		let intervalId: ReturnType<typeof setInterval> | null = null;

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (disposed) {
					return;
				}

				api = dbApi;
				overview = await dbApi.getSessionOverview(sessionId);
				isLoading = false;

				if (overview?.summary.status === 'in_progress' && !overview.summary.completedAt) {
					intervalId = setInterval(() => {
						nowMs = Date.now();
					}, 1000);
				}
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
				isLoading = false;
			}
		})();

		return () => {
			disposed = true;
			if (intervalId) {
				clearInterval(intervalId);
			}
		};
	});
</script>

<section class="flex flex-1 flex-col">
	{#if errorMessage}
		<p
			class="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
			role="alert"
		>
			{errorMessage}
		</p>
	{:else if isLoading}
		<section class="flex flex-1 flex-col justify-center">
			<div class="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
				<div class="h-full w-1/2 animate-pulse rounded-full bg-emerald-300"></div>
			</div>
			<h1 class="mt-5 text-2xl font-semibold text-white">Loading session</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">Gathering the session summary.</p>
		</section>
	{:else if !overview}
		<section class="flex flex-1 flex-col justify-center">
			<h1 class="text-3xl font-semibold text-white">Session not found</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				This session is not available in local storage.
			</p>
			<a
				class="mt-6 flex min-h-12 items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950"
				href="/"
			>
				Back to home
			</a>
		</section>
	{:else}
		<div class="pb-5">
			<a
				class="flex min-h-10 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-medium text-zinc-300"
				href="/"
			>
				<Icon name="arrow-left" class="h-4 w-4" />
				Back to home
			</a>
			<p class="mt-4 text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
				Session overview
			</p>
			<h1 class="mt-2 text-3xl font-semibold text-white">{overview.summary.workoutNameSnapshot}</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				{formatDayHeading(overview.summary.dayKey)} at {formatSessionTime(
					overview.summary.startedAt
				)}
			</p>
		</div>

		<section class="border-y border-white/10 py-5">
			<div class="flex items-start justify-between gap-3">
				<div>
					<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Status</p>
					<div class="mt-2 flex items-center gap-2 text-base font-semibold text-white">
						<Icon
							name="check-circle"
							class={`h-4 w-4 ${overview.summary.status === 'completed' ? 'text-emerald-300' : 'text-zinc-500'}`}
						/>
						{formatSessionStatus(overview.summary.status)}
					</div>
				</div>
				<div class="text-right">
					<p class="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">Duration</p>
					<p class="mt-2 flex items-center justify-end gap-2 text-base font-semibold text-white">
						<Icon name="clock-3" class="h-4 w-4 text-zinc-500" />
						{formatDuration(overview.summary.startedAt, overview.summary.completedAt, nowMs)}
					</p>
				</div>
			</div>

			<div class="mt-4 grid grid-cols-2 gap-3">
				<div>
					<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Exercises</p>
					<p class="mt-2 text-sm font-medium text-zinc-200">{overview.summary.totalExercises}</p>
				</div>
				<div>
					<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Sets</p>
					<p class="mt-2 text-sm font-medium text-zinc-200">{overview.summary.totalSets}</p>
				</div>
			</div>
		</section>

		<section class="py-5">
			<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Exercises</p>
			<div class="mt-4 grid gap-3">
				{#each overview.exercises as sessionExercise}
					<div class="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-4">
						<h2 class="text-lg font-semibold text-white">{sessionExercise.exerciseNameSnapshot}</h2>

						<div class="mt-3 grid gap-2">
							{#each sessionExercise.sets as set}
								<div
									class="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2 text-sm"
								>
									<span class="font-medium text-zinc-300">Set {set.order}</span>
									<span class="font-semibold text-white">{formatSetLine(set.weight, set.reps)}</span
									>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</section>
