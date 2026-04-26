<script lang="ts">
	import type { SessionOverview } from '$lib/db';
	import { formatDayHeading, formatDuration, formatSessionTime } from './session-format';

	let {
		overview,
		nowMs
	}: {
		overview: SessionOverview;
		nowMs: number;
	} = $props();

	let isInProgress = $derived(overview.summary.status === 'in_progress');
	let durationText = $derived(
		overview.summary.startedAt && overview.summary.status !== 'planned'
			? formatDuration(overview.summary.startedAt, overview.summary.completedAt, nowMs)
			: ''
	);
</script>

<div class={isInProgress ? 'pb-3' : 'pb-5'}>
	<div class="min-w-0 pr-12">
		{#if isInProgress}
			<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Exercises</p>
		{:else}
			<!-- <h1 class="text-3xl font-semibold text-white">
				{overview.summary.workoutNameSnapshot}
			</h1> -->
			<p class="pt-3 mt-2 text-sm leading-6 text-zinc-400">
				{formatDayHeading(overview.summary.dayKey)} at
				{formatSessionTime(overview.summary.startedAt ?? overview.summary.createdAt)}
				{#if durationText}
					<span class="text-zinc-600"> · </span>{durationText}
				{/if}
			</p>
		{/if}
	</div>

	<!-- {#if overview.previousSummary && overview.summary.status !== 'in_progress'}
		<a
			class="mt-4 block rounded-lg border border-white/10 bg-white/[0.03] px-4 py-4 transition hover:border-emerald-300/40 hover:bg-white/[0.05]"
			href={`/sessions/${overview.previousSummary.id}`}
		>
			<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
				Previous session
			</p>
			<p class="mt-2 text-sm font-semibold text-white">
				{formatDayHeading(overview.previousSummary.dayKey)} at
				{formatSessionTime(
					overview.previousSummary.startedAt ?? overview.previousSummary.createdAt
				)}
			</p>
		</a>
	{/if} -->
</div>
