<script lang="ts">
	import type { Workout, WorkoutExerciseWithExercise } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';

	type DragPreview = {
		x: number;
		y: number;
		width: number;
		height: number;
	};

	let {
		selectedWorkout,
		workoutExercises,
		isSaving,
		dragPreview,
		draggedWorkoutExerciseId,
		draggedWorkoutExercise,
		onOpenPicker,
		onRemoveExercise,
		onDragPointerDown,
		onDragPointerMove,
		onDragPointerUp,
		onDragPointerCancel,
		onReorderKeydown,
		children
	}: {
		selectedWorkout: Workout;
		workoutExercises: WorkoutExerciseWithExercise[];
		isSaving: boolean;
		dragPreview: DragPreview | null;
		draggedWorkoutExerciseId: string;
		draggedWorkoutExercise: WorkoutExerciseWithExercise | null;
		onOpenPicker: () => void;
		onRemoveExercise: (workoutExerciseId: string) => void;
		onDragPointerDown: (event: PointerEvent, workoutExerciseId: string) => void;
		onDragPointerMove: (event: PointerEvent) => void;
		onDragPointerUp: (event: PointerEvent) => void;
		onDragPointerCancel: (event: PointerEvent) => void;
		onReorderKeydown: (event: KeyboardEvent, workoutExerciseId: string) => void;
		children?: import('svelte').Snippet;
	} = $props();
</script>

<section class="box-border flex min-w-0 flex-1 flex-col px-1">
	<div class="flex items-start justify-between gap-3 border-b border-white/10 pb-5">
		<div class="min-w-0 flex-1">
			<h1 class="text-3xl leading-tight font-semibold break-words text-white">
				{selectedWorkout.name}
			</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				Reorder the movement list and keep the template clean.
			</p>
		</div>

		<button
			class="flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
			type="button"
			disabled={isSaving}
			onclick={onOpenPicker}
		>
			<Icon name="plus" class="h-4 w-4" />
			Add exercise
		</button>
	</div>

	<section class="py-5">
		<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Exercise order</p>

		{#if workoutExercises.length > 0}
			<div class="mt-4 grid gap-3">
				{#each workoutExercises as workoutExercise (workoutExercise.id)}
					<div
						class={`rounded-lg border border-white/10 bg-white/[0.03] px-4 py-4 ${
							workoutExercise.id === draggedWorkoutExerciseId ? 'opacity-40' : ''
						}`}
						data-workout-exercise-id={workoutExercise.id}
					>
						<div class="flex items-center gap-3">
							<button
								class="flex h-10 w-10 shrink-0 touch-none items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-400 select-none"
								type="button"
								aria-label={`Reorder ${workoutExercise.exercise.name}. Use the up and down arrow keys.`}
								aria-keyshortcuts="ArrowUp ArrowDown"
								onpointerdown={(event) => onDragPointerDown(event, workoutExercise.id)}
								onpointermove={onDragPointerMove}
								onpointerup={onDragPointerUp}
								onpointercancel={onDragPointerCancel}
								onkeydown={(event) => onReorderKeydown(event, workoutExercise.id)}
							>
								<Icon name="grip-vertical" class="h-4 w-4" />
							</button>

							<div class="min-w-0 flex-1">
								<p class="line-clamp-2 text-base leading-5 font-semibold break-words text-white">
									{workoutExercise.exercise.name}
								</p>
								<p class="mt-1 text-sm text-zinc-400">
									{workoutExercise.exercise.unilateral ? 'Unilateral' : 'Bilateral'}
								</p>
							</div>

							<button
								class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-400 transition hover:border-red-400/40 hover:text-red-200"
								type="button"
								title="Remove exercise"
								onclick={() => onRemoveExercise(workoutExercise.id)}
							>
								<Icon name="trash-2" class="h-4 w-4" />
							</button>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div
				class="mt-4 rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-zinc-400"
			>
				This workout does not have any exercises yet.
			</div>
		{/if}
	</section>

	{#if dragPreview && draggedWorkoutExercise}
		<div
			class="pointer-events-none fixed z-30 rounded-lg border border-emerald-300/40 bg-[#11171a] px-4 py-4 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
			style={`left:${dragPreview.x}px; top:${dragPreview.y}px; width:${dragPreview.width}px;`}
		>
			<p class="line-clamp-2 text-base leading-5 font-semibold break-words text-white">
				{draggedWorkoutExercise.exercise.name}
			</p>
			<p class="mt-1 text-sm text-zinc-400">
				{draggedWorkoutExercise.exercise.unilateral ? 'Unilateral' : 'Bilateral'}
			</p>
		</div>
	{/if}

	{@render children?.()}
</section>
