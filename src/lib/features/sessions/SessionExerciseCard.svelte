<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import type { SessionExerciseOverview, SessionSetOverview, SessionStatus } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import { getExerciseSetSummary } from './session-overview';
	import SessionSetTable from './SessionSetTable.svelte';

	let {
		sessionId,
		sessionExercise,
		status,
		isEditable,
		isSaving,
		isMenuOpen,
		performedSets,
		onToggleMenu,
		onSwapExercise,
		onRemoveExercise,
		onDragPointerDown,
		onDragPointerMove,
		onDragPointerUp,
		onDragPointerCancel
	}: {
		sessionId: string;
		sessionExercise: SessionExerciseOverview;
		status: SessionStatus;
		isEditable: boolean;
		isSaving: boolean;
		isMenuOpen: boolean;
		performedSets: SessionSetOverview[];
		onToggleMenu: (sessionExerciseId: string) => void;
		onSwapExercise: (sessionExerciseId: string) => void;
		onRemoveExercise: (sessionExerciseId: string) => void;
		onDragPointerDown: (event: PointerEvent, sessionExerciseId: string) => void;
		onDragPointerMove: (event: PointerEvent) => void;
		onDragPointerUp: (event: PointerEvent) => void;
		onDragPointerCancel: (event: PointerEvent) => void;
	} = $props();
</script>

{#if isEditable}
	<div
		class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3"
		data-session-exercise-id={sessionExercise.id}
	>
		<div class="grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center gap-3">
			<button
				class="flex h-9 w-9 shrink-0 touch-none items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-400 select-none"
				type="button"
				aria-label="Reorder exercise"
				onpointerdown={(event) => onDragPointerDown(event, sessionExercise.id)}
				onpointermove={onDragPointerMove}
				onpointerup={onDragPointerUp}
				onpointercancel={onDragPointerCancel}
			>
				<Icon name="grip-vertical" class="h-4 w-4" />
			</button>

			<button
				class="min-w-0 flex-1 text-left"
				type="button"
				disabled={status === 'planned'}
				onclick={() =>
					goto(
						resolve('/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]', {
							sessionId,
							sessionExerciseId: sessionExercise.id
						})
					)}
			>
				<p class="line-clamp-2 text-base leading-5 font-semibold break-words text-white">
					{sessionExercise.exerciseNameSnapshot}
				</p>
				<p class="mt-0.5 text-sm leading-5 text-zinc-400">
					{getExerciseSetSummary(sessionExercise, status, performedSets.length)}
				</p>
			</button>

			<button
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-sm font-semibold text-zinc-300"
				type="button"
				onclick={() => onToggleMenu(sessionExercise.id)}
			>
				···
			</button>
		</div>

		{#if isMenuOpen}
			<div class="mt-3 grid gap-2 border-t border-white/10 pt-3">
				<button
					class="rounded-lg border border-white/10 px-3 py-2 text-left text-sm font-medium text-zinc-200"
					type="button"
					disabled={isSaving}
					onclick={() => onSwapExercise(sessionExercise.id)}
				>
					Swap exercise
				</button>
				<button
					class="rounded-lg border border-white/10 px-3 py-2 text-left text-sm font-medium text-red-200"
					type="button"
					disabled={isSaving}
					onclick={() => onRemoveExercise(sessionExercise.id)}
				>
					Remove exercise
				</button>
			</div>
		{/if}

		<SessionSetTable sets={performedSets} variant="compact" />
	</div>
{:else}
	<div class="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-4">
		<h2 class="line-clamp-2 text-lg leading-6 font-semibold break-words text-white">
			{sessionExercise.exerciseNameSnapshot}
		</h2>

		<SessionSetTable sets={performedSets} />
	</div>
{/if}
