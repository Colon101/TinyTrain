<script lang="ts">
	import type { SessionOverview } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import { getPerformedSets } from './session-overview';
	import SessionExerciseCard from './SessionExerciseCard.svelte';

	let {
		sessionId,
		overview,
		isEditMode = false,
		isEditable,
		isSaving,
		hideHeading = false,
		openExerciseMenuId,
		onToggleExerciseMenu,
		onAddExercise,
		onSwapExercise,
		onRemoveExercise,
		onDragPointerDown,
		onDragPointerMove,
		onDragPointerUp,
		onDragPointerCancel
	}: {
		sessionId: string;
		overview: SessionOverview;
		isEditMode?: boolean;
		isEditable: boolean;
		isSaving: boolean;
		hideHeading?: boolean;
		openExerciseMenuId: string;
		onToggleExerciseMenu: (sessionExerciseId: string) => void;
		onAddExercise: () => void;
		onSwapExercise: (sessionExerciseId: string) => void;
		onRemoveExercise: (sessionExerciseId: string) => void;
		onDragPointerDown: (event: PointerEvent, sessionExerciseId: string) => void;
		onDragPointerMove: (event: PointerEvent) => void;
		onDragPointerUp: (event: PointerEvent) => void;
		onDragPointerCancel: (event: PointerEvent) => void;
	} = $props();

	let sectionClass = $derived(hideHeading ? 'pb-4' : 'py-4');
	let listClass = $derived(
		`${hideHeading ? '' : isEditable ? 'mt-3 ' : 'mt-4 '}${isEditable ? 'grid gap-2.5' : 'grid gap-3'}`
	);
</script>

<section class={sectionClass}>
	{#if !hideHeading}
		<p class="text-xs font-semibold tracking-[0.18em] text-accent-soft uppercase">Exercises</p>
	{/if}

	<div class={listClass}>
		{#each overview.exercises as sessionExercise (sessionExercise.id)}
			<SessionExerciseCard
				{sessionId}
				{sessionExercise}
				status={overview.summary.status}
				{isEditMode}
				{isEditable}
				{isSaving}
				isMenuOpen={isEditable && openExerciseMenuId === sessionExercise.id}
				performedSets={getPerformedSets(sessionExercise)}
				onToggleMenu={onToggleExerciseMenu}
				{onSwapExercise}
				{onRemoveExercise}
				{onDragPointerDown}
				{onDragPointerMove}
				{onDragPointerUp}
				{onDragPointerCancel}
			/>
		{/each}
	</div>

	{#if isEditable}
		<button
			class="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-base font-semibold text-white disabled:text-zinc-500"
			type="button"
			disabled={isSaving}
			onclick={onAddExercise}
		>
			<Icon name="plus" class="h-4 w-4" />
			Add exercise
		</button>
	{/if}
</section>
