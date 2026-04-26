<script lang="ts">
	import type { SessionOverview } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import { formatDayHeading, formatDuration, formatSessionTime } from './session-format';

	let {
		overview,
		nowMs,
		isSaving,
		isSharingSession,
		isSessionMenuOpen,
		onToggleSessionMenu,
		onShareSession,
		onEndSession,
		onResetSession,
		onDeleteSession
	}: {
		overview: SessionOverview;
		nowMs: number;
		isSaving: boolean;
		isSharingSession: boolean;
		isSessionMenuOpen: boolean;
		onToggleSessionMenu: () => void;
		onShareSession: () => void;
		onEndSession: () => void;
		onResetSession: () => void;
		onDeleteSession: () => void;
	} = $props();

	let isInProgress = $derived(overview.summary.status === 'in_progress');
	let durationText = $derived(
		overview.summary.startedAt && overview.summary.status !== 'planned'
			? formatDuration(overview.summary.startedAt, overview.summary.completedAt, nowMs)
			: ''
	);
</script>

<div class={isInProgress ? 'pb-3' : 'pb-5'}>
	<div class="flex items-center justify-between gap-3">
		<div class="min-w-0 flex-1">
			{#if isInProgress}
				<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Exercises</p>
			{:else}
				<h1 class="text-3xl font-semibold text-white">
					{overview.summary.workoutNameSnapshot}
				</h1>
				<p class="mt-2 text-sm leading-6 text-zinc-400">
					{formatDayHeading(overview.summary.dayKey)} at
					{formatSessionTime(overview.summary.startedAt ?? overview.summary.createdAt)}
					{#if durationText}
						<span class="text-zinc-600"> · </span>{durationText}
					{/if}
				</p>
			{/if}
		</div>

		<div class="relative mr-[-1.3px] shrink-0">
			<button
				class="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-sm font-semibold text-zinc-300 disabled:text-zinc-500"
				type="button"
				disabled={isSaving || isSharingSession}
				onclick={onToggleSessionMenu}
			>
				···
			</button>

			{#if isSessionMenuOpen}
				<div
					class="absolute top-12 right-0 z-10 grid min-w-44 gap-2 rounded-lg border border-white/10 bg-[#0f1519] p-2 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
				>
					{#if overview.summary.status === 'completed'}
						<button
							class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200 disabled:text-zinc-500"
							type="button"
							disabled={isSaving || isSharingSession}
							onclick={onShareSession}
						>
							<Icon name="share-2" class="h-4 w-4 text-emerald-200" />
							{isSharingSession ? 'Rendering image' : 'Share session'}
						</button>
					{/if}

					{#if overview.summary.status === 'in_progress'}
						<button
							class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
							type="button"
							disabled={isSaving}
							onclick={onEndSession}
						>
							End session
						</button>
						<button
							class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
							type="button"
							disabled={isSaving}
							onclick={onResetSession}
						>
							Reset session
						</button>
					{:else if overview.summary.status === 'planned'}
						<button
							class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-red-200"
							type="button"
							disabled={isSaving}
							onclick={onDeleteSession}
						>
							<Icon name="trash-2" class="h-4 w-4 text-red-300" />
							Delete session
						</button>
					{:else}
						<button
							class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-red-200"
							type="button"
							disabled={isSaving}
							onclick={onDeleteSession}
						>
							<Icon name="trash-2" class="h-4 w-4 text-red-300" />
							Delete session
						</button>
					{/if}

					{#if overview.summary.status === 'in_progress'}
						<button
							class="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-red-200"
							type="button"
							disabled={isSaving}
							onclick={onDeleteSession}
						>
							<Icon name="trash-2" class="h-4 w-4 text-red-300" />
							Delete session
						</button>
					{/if}
				</div>
			{/if}
		</div>
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
