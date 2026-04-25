<script lang="ts">
	import type { SessionOverview } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import { formatDuration, formatSessionStatus } from './session-format';

	let {
		overview,
		nowMs,
		isSaving,
		onStartSession
	}: {
		overview: SessionOverview;
		nowMs: number;
		isSaving: boolean;
		onStartSession: () => void;
	} = $props();
</script>

{#if overview.summary.status !== 'in_progress'}
	<section class="border-y border-white/10 py-5">
		{#if overview.summary.status !== 'planned'}
			<div class="flex items-start justify-between gap-3">
				<div>
					<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Status</p>
					<div class="mt-2 flex items-center gap-2 text-base font-semibold text-white">
						<Icon
							name={overview.summary.status === 'completed' ? 'check-circle' : 'activity'}
							class={`h-4 w-4 ${
								overview.summary.status === 'completed'
									? 'text-emerald-300'
									: overview.summary.status === 'abandoned'
										? 'text-red-300'
										: 'text-amber-300'
							}`}
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
		{/if}

		<div class={`${overview.summary.status === 'planned' ? '' : 'mt-4'} grid grid-cols-2 gap-3`}>
			<div>
				<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Exercises</p>
				<p class="mt-2 text-sm font-medium text-zinc-200">{overview.summary.totalExercises}</p>
			</div>
			<div>
				<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Sets</p>
				<p class="mt-2 text-sm font-medium text-zinc-200">{overview.summary.totalSets}</p>
			</div>
		</div>

		{#if overview.summary.status === 'planned'}
			<button
				class="mt-4 flex min-h-12 w-full items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={isSaving}
				onclick={onStartSession}
			>
				Start session
			</button>
		{/if}
	</section>
{/if}
