<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { ExerciseHistoryEntry, SessionOverview } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		formatDayHeading,
		formatDuration,
		formatSessionStatus,
		formatSessionTime
	} from './session-format';

	type DatabaseApi = typeof import('$lib/db');

	let { sessionId }: { sessionId: string } = $props();

	let api = $state<DatabaseApi | null>(null);
	let overview = $state<SessionOverview | null>(null);
	let isLoading = $state(true);
	let isDeleting = $state(false);
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

	function formatSetCellValue(value?: number) {
		return typeof value === 'number' && Number.isFinite(value)
			? `${Number(value.toFixed(2))}`
			: '-';
	}

	function formatSetOrder(order: number) {
		return String(order).padStart(2, '0');
	}

	function getPreviousSet(previousPerformance: ExerciseHistoryEntry | null, setIndex: number) {
		return previousPerformance?.sets[setIndex] ?? null;
	}

	function getPositiveDeltaLabel(current?: number, previous?: number) {
		if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) {
			return '';
		}

		const previousValue = typeof previous === 'number' && Number.isFinite(previous) ? previous : 0;

		if (current <= previousValue) {
			return '';
		}

		return `(+${Number((current - previousValue).toFixed(2))})`;
	}

	async function handleDeleteSession() {
		if (!api || !overview || isDeleting) {
			return;
		}

		const confirmed = window.confirm(
			`Delete ${overview.summary.workoutNameSnapshot} from ${formatDayHeading(overview.summary.dayKey)}?`
		);

		if (!confirmed) {
			return;
		}

		isDeleting = true;
		errorMessage = '';

		try {
			await api.deleteWorkoutSession(overview.summary.id);
			await goto('/', { replaceState: true });
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
			isDeleting = false;
		}
	}
</script>

<section class="flex flex-1 flex-col">
	{#if errorMessage}
		<p
			class="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
			role="alert"
		>
			{errorMessage}
		</p>
	{/if}

	{#if isLoading}
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
			<div class="flex items-center justify-between gap-3">
				<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
					Session overview
				</p>
				<button
					class="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 disabled:text-zinc-500"
					type="button"
					disabled={isDeleting}
					onclick={handleDeleteSession}
					aria-label="Delete session"
					title="Delete session"
				>
					<Icon name="trash-2" class="h-4 w-4" />
				</button>
			</div>
			<h1 class="mt-2 text-3xl font-semibold text-white">{overview.summary.workoutNameSnapshot}</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				{formatDayHeading(overview.summary.dayKey)} at {formatSessionTime(
					overview.summary.startedAt
				)}
			</p>

			<div class="mt-4 grid gap-3">
				{#if overview.previousSummary}
					<a
						class="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-4 transition hover:border-emerald-300/40 hover:bg-white/[0.05]"
						href={`/sessions/${overview.previousSummary.id}`}
					>
						<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
							Previous session
						</p>
						<p class="mt-2 text-sm font-semibold text-white">
							{formatDayHeading(overview.previousSummary.dayKey)} at
							{formatSessionTime(overview.previousSummary.startedAt)}
						</p>
					</a>
				{/if}
			</div>
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

						<table class="mt-4 w-full table-fixed border-separate border-spacing-y-2">
							<thead>
								<tr class="text-[11px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">
									<th class="w-20 px-3 text-left"></th>
									<th class="px-2 text-center">Weight</th>
									<th class="px-2 text-center">Reps</th>
									<th class="px-2 text-center">RIR</th>
								</tr>
							</thead>
							<tbody>
								{#each sessionExercise.sets as set, setIndex}
									{@const previousSet = getPreviousSet(
										sessionExercise.previousPerformance,
										setIndex
									)}
									{@const weightDelta = getPositiveDeltaLabel(set.weight, previousSet?.weight)}
									{@const repsDelta = getPositiveDeltaLabel(set.reps, previousSet?.reps)}
									{@const rirDelta = getPositiveDeltaLabel(set.rir, previousSet?.rir)}
									<tr>
										<td class="rounded-l-md bg-white/[0.04] px-3 py-3 align-middle">
											<span
												class="block text-xs font-medium tracking-[0.12em] text-zinc-400 uppercase"
											>
												Set
											</span>
											<span class="mt-1 block text-xl leading-none font-semibold text-white">
												{formatSetOrder(set.order)}
											</span>
										</td>
										<td
											class="bg-white/[0.04] px-2 py-3 text-center align-middle text-base font-semibold text-white"
										>
											<div class="flex items-baseline justify-center gap-1">
												<span>{formatSetCellValue(set.weight)}</span>
												{#if weightDelta}
													<span class="text-xs font-semibold text-emerald-300">{weightDelta}</span>
												{/if}
											</div>
										</td>
										<td
											class="bg-white/[0.04] px-2 py-3 text-center align-middle text-base font-semibold text-white"
										>
											<div class="flex items-baseline justify-center gap-1">
												<span>{formatSetCellValue(set.reps)}</span>
												{#if repsDelta}
													<span class="text-xs font-semibold text-emerald-300">{repsDelta}</span>
												{/if}
											</div>
										</td>
										<td
											class="rounded-r-md bg-white/[0.04] px-2 py-3 text-center align-middle text-base font-semibold text-white"
										>
											<div class="flex items-baseline justify-center gap-1">
												<span>{formatSetCellValue(set.rir)}</span>
												{#if rirDelta}
													<span class="text-xs font-semibold text-emerald-300">{rirDelta}</span>
												{/if}
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</section>
