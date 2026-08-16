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
	let isPlanned = $derived(overview.summary.status === 'planned');
	let durationText = $derived(
		overview.summary.startedAt && overview.summary.status !== 'planned'
			? formatDuration(overview.summary.startedAt, overview.summary.completedAt, nowMs)
			: ''
	);
</script>

<div class={isInProgress ? 'pb-3' : 'pb-5'}>
	<div class="min-w-0 pr-12">
		{#if isInProgress}
			<p class="text-md pt-5 pb-3 font-semibold tracking-[0.18em] text-accent-soft uppercase">
				Exercises
			</p>
		{:else}
			<p class="mt-2 pt-3 text-sm leading-6 text-zinc-400">
				{formatDayHeading(overview.summary.dayKey)}
				{#if isPlanned}
					<span class="text-zinc-600"> · </span>Not started
				{:else}
					at {formatSessionTime(overview.summary.startedAt)}
				{/if}
				{#if durationText}
					<span class="text-zinc-600"> · </span>{durationText}
				{/if}
			</p>
		{/if}
	</div>
</div>
