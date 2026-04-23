<script lang="ts">
	import { onMount } from 'svelte';
	import type { DayOverview } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		formatDuration,
		formatSessionStatus,
		formatSessionTime
	} from '$lib/features/sessions/session-format';

	let { overview }: { overview: DayOverview | null } = $props();

	let nowMs = $state(Date.now());
	let running = $derived(
		Boolean(overview?.session?.status === 'in_progress' && !overview.session.completedAt)
	);

	let intervalId = $state<ReturnType<typeof setInterval> | null>(null);

	$effect(() => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}

		if (running) {
			intervalId = setInterval(() => {
				nowMs = Date.now();
			}, 1000);
		}
	});

	onMount(() => {
		return () => {
			if (intervalId) {
				clearInterval(intervalId);
			}
		};
	});
</script>

<section class="pt-4">
	{#if overview?.session}
		<a
			class="block rounded-lg border border-white/10 bg-white/[0.03] px-4 py-4 transition hover:border-emerald-300/50 hover:bg-white/[0.05]"
			href={`/sessions/${overview.session.id}`}
		>
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<p class="text-sm font-medium text-zinc-400">
						{formatSessionTime(overview.session.startedAt)}
					</p>
					<h2 class="mt-1 truncate text-xl font-semibold text-white">
						{overview.session.workoutNameSnapshot}
					</h2>
				</div>

				<span
					class="inline-flex items-center gap-2 rounded-full bg-white/[0.05] px-3 py-1 text-xs font-medium text-zinc-200"
				>
					{#if overview.session.status === 'completed'}
						<Icon name="check-circle" class="h-3.5 w-3.5 text-emerald-300" />
					{:else}
						<Icon name="activity" class="h-3.5 w-3.5 text-amber-300" />
					{/if}
					{formatSessionStatus(overview.session.status)}
				</span>
			</div>

			<div class="mt-4 grid grid-cols-3 gap-3 border-t border-white/10 pt-4">
				<div>
					<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Time</p>
					<p class="mt-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
						<Icon name="clock-3" class="h-4 w-4 text-zinc-500" />
						{formatDuration(overview.session.startedAt, overview.session.completedAt, nowMs)}
					</p>
				</div>
				<div>
					<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Exercises</p>
					<p class="mt-2 text-sm font-medium text-zinc-200">{overview.session.totalExercises}</p>
				</div>
				<div>
					<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Sets</p>
					<p class="mt-2 text-sm font-medium text-zinc-200">{overview.session.totalSets}</p>
				</div>
			</div>
		</a>
	{:else}
		<div
			class="rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-zinc-500"
		>
			No workout logged for this day.
		</div>
	{/if}
</section>
