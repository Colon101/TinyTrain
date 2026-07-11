<script lang="ts">
	import type { DayOverview, SessionSummary } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import HomeSessionCard from './HomeSessionCard.svelte';

	let {
		overview,
		currentSession = null,
		isTodaySelected = false,
		isBusy = false,
		onOpenScheduleWorkout,
		onStartSession
	}: {
		overview: DayOverview | null;
		currentSession?: SessionSummary | null;
		isTodaySelected?: boolean;
		isBusy?: boolean;
		onOpenScheduleWorkout: () => void;
		onStartSession: (sessionId: string) => void;
	} = $props();

	let nowMs = $state(Date.now());
	let shouldTick = $derived(
		Boolean(
			(overview?.session?.status === 'in_progress' && !overview.session.completedAt) ||
			(currentSession?.status === 'in_progress' && !currentSession.completedAt)
		)
	);
	let showPinnedCurrentSession = $derived(
		Boolean(currentSession && currentSession.id !== overview?.session?.id)
	);

	$effect(() => {
		nowMs = Date.now();

		if (!shouldTick) {
			return;
		}

		const intervalId = setInterval(() => {
			nowMs = Date.now();
		}, 1000);

		return () => {
			clearInterval(intervalId);
		};
	});
</script>

<section class="pt-4">
	{#if showPinnedCurrentSession && currentSession}
		<div class="pb-3">
			<HomeSessionCard
				session={currentSession}
				label="Current session"
				{nowMs}
				{isBusy}
				onStart={() => onStartSession(currentSession.id)}
			/>
		</div>
	{/if}

	{#if overview?.session}
		{@const session = overview.session}
		<HomeSessionCard
			{session}
			label={showPinnedCurrentSession ? 'Selected day' : ''}
			{nowMs}
			{isBusy}
			onStart={() => onStartSession(session.id)}
		/>
	{:else if isTodaySelected}
		<div class="rounded-lg border border-dashed border-white/10 px-4 py-5">
			<p class="text-sm font-medium text-zinc-300">No workout scheduled for today.</p>
			<p class="mt-2 text-sm leading-6 text-zinc-500">
				Pick one of your workout templates and turn it into today&apos;s live session.
			</p>

			<button
				class="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={isBusy}
				onclick={onOpenScheduleWorkout}
			>
				<Icon name="plus" class="h-4 w-4" />
				Schedule workout
			</button>
		</div>
	{:else}
		<div
			class="rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-zinc-500"
		>
			No workout logged for this day.
		</div>
	{/if}
</section>
