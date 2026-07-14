<script lang="ts">
	import type { Exercise } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import { trapDialogFocus } from '$lib/ui/dialog-focus';

	let {
		exerciseSearch,
		newExerciseName,
		isNewExerciseUnilateral,
		visiblePickerExercises,
		hiddenPickerExerciseCount,
		selectedPickerExerciseIdSet,
		selectedExerciseIds,
		addSelectedLabel,
		submitDisabled,
		canCreateCustomExercise,
		isSaving,
		sheetEyebrow = 'Exercise picker',
		sheetTitle = 'Add exercises',
		onClose,
		onExerciseSearchInput,
		onCustomExerciseNameInput,
		onTogglePickerExercise,
		onToggleUnilateral,
		onCreateExercise,
		onAddSelected,
		isPreviouslyUsedExercise,
		getPickerExercisePosition,
		getExerciseMetadata = null
	}: {
		exerciseSearch: string;
		newExerciseName: string;
		isNewExerciseUnilateral: boolean;
		visiblePickerExercises: Exercise[];
		hiddenPickerExerciseCount: number;
		selectedPickerExerciseIdSet: Set<string>;
		selectedExerciseIds: Set<string>;
		addSelectedLabel: string;
		submitDisabled: boolean;
		canCreateCustomExercise: boolean;
		isSaving: boolean;
		sheetEyebrow?: string;
		sheetTitle?: string;
		onClose: () => void;
		onExerciseSearchInput: (event: Event) => void;
		onCustomExerciseNameInput: (value: string) => void;
		onTogglePickerExercise: (exerciseId: string) => void;
		onToggleUnilateral: (nextValue: boolean) => void;
		onCreateExercise: (event: SubmitEvent) => void;
		onAddSelected: () => void;
		isPreviouslyUsedExercise: (exercise: Exercise) => boolean;
		getPickerExercisePosition: (exerciseId: string) => number | null;
		getExerciseMetadata?: ((exercise: Exercise) => string) | null;
	} = $props();
</script>

<div class="fixed inset-0 z-20 bg-black/60 px-4 py-5">
	<div
		class="mx-auto flex h-full w-full max-w-[430px] flex-col rounded-lg border border-white/10 bg-surface-overlay"
		role="dialog"
		aria-modal="true"
		aria-labelledby="exercise-picker-title"
		tabindex="-1"
		use:trapDialogFocus={{ onEscape: onClose, initialFocus: '#exercise-search' }}
	>
		<header class="flex items-center justify-between border-b border-white/10 px-4 py-4">
			<div>
				<p class="text-xs font-semibold tracking-[0.18em] text-accent-soft uppercase">
					{sheetEyebrow}
				</p>
				<h2 id="exercise-picker-title" class="mt-2 text-xl font-semibold text-white">
					{sheetTitle}
				</h2>
			</div>
			<button
				class="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300"
				type="button"
				aria-label="Close exercise picker"
				onclick={onClose}
			>
				<Icon name="x" class="h-4 w-4" />
			</button>
		</header>

		<div class="flex-1 overflow-y-auto px-4 py-4">
			<label class="block" for="exercise-search">
				<span class="mb-2 block text-sm font-medium text-zinc-300">Search library</span>
				<input
					id="exercise-search"
					class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-accent/60"
					value={exerciseSearch}
					autocomplete="off"
					placeholder="Bench, pull-up, row..."
					oninput={onExerciseSearchInput}
				/>
			</label>

			<div class="mt-4 grid gap-3">
				{#each visiblePickerExercises as exercise (exercise.id)}
					<button
						class={`flex min-h-14 w-full items-start justify-between gap-3 overflow-hidden rounded-lg border px-4 py-3 text-left transition ${
							selectedExerciseIds.has(exercise.id)
								? 'border-white/10 bg-white/[0.02] text-zinc-500'
								: selectedPickerExerciseIdSet.has(exercise.id)
									? 'border-accent/50 bg-accent/10 text-white'
									: 'border-white/10 bg-white/[0.03] text-white'
						}`}
						type="button"
						disabled={selectedExerciseIds.has(exercise.id)}
						onclick={() => onTogglePickerExercise(exercise.id)}
					>
						<div class="min-w-0 flex-1 overflow-hidden">
							<p class="line-clamp-2 text-sm leading-5 font-semibold wrap-break-word">
								{exercise.name}
							</p>
							<p class="mt-1 text-xs text-zinc-400">
								{exercise.source === 'custom' ? 'Custom' : 'Built-in'} · {exercise.unilateral
									? 'Unilateral'
									: 'Bilateral'}
								{#if getExerciseMetadata?.(exercise)}
									<span> · {getExerciseMetadata(exercise)}</span>
								{/if}
								{#if isPreviouslyUsedExercise(exercise)}
									<span class="text-accent-soft"> · Previously used</span>
								{/if}
							</p>
						</div>

						<div class="flex shrink-0 items-center gap-3 pt-0.5">
							{#if selectedExerciseIds.has(exercise.id)}
								<span class="text-xs font-medium text-zinc-500">Added</span>
							{:else if getPickerExercisePosition(exercise.id)}
								<span class="text-xs font-medium text-accent-soft">
									#{getPickerExercisePosition(exercise.id)}
								</span>
							{/if}

							{#if selectedPickerExerciseIdSet.has(exercise.id)}
								<Icon name="check" class="h-4 w-4 text-accent-soft" />
							{/if}
						</div>
					</button>
				{/each}
			</div>

			{#if hiddenPickerExerciseCount > 0}
				<p class="mt-3 text-sm text-zinc-500">
					{hiddenPickerExerciseCount} more matches hidden while you type.
				</p>
			{/if}

			{#if canCreateCustomExercise}
				<form class="mt-5 border-t border-white/10 pt-5" onsubmit={onCreateExercise}>
					<p class="text-xs font-semibold tracking-[0.18em] text-accent-soft uppercase">
						Create custom
					</p>
					<label class="mt-3 block" for="custom-picker-exercise-name">
						<span class="mb-2 block text-sm font-medium text-zinc-300">Exercise name</span>
						<input
							id="custom-picker-exercise-name"
							class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-accent/60"
							value={newExerciseName}
							autocomplete="off"
							placeholder="Create a custom exercise"
							oninput={(event) =>
								onCustomExerciseNameInput((event.currentTarget as HTMLInputElement).value)}
						/>
					</label>

					<div class="mt-3 grid grid-cols-2 gap-2">
						<button
							class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
								!isNewExerciseUnilateral
									? 'bg-accent text-on-accent'
									: 'border border-white/10 text-zinc-300'
							}`}
							type="button"
							onclick={() => onToggleUnilateral(false)}
						>
							Bilateral
						</button>
						<button
							class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
								isNewExerciseUnilateral
									? 'bg-accent text-on-accent'
									: 'border border-white/10 text-zinc-300'
							}`}
							type="button"
							onclick={() => onToggleUnilateral(true)}
						>
							Unilateral
						</button>
					</div>

					<button
						class="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-base font-semibold text-white disabled:text-zinc-500"
						type="submit"
						disabled={isSaving || !newExerciseName.trim()}
					>
						<Icon name="plus" class="h-4 w-4" />
						Create and add
					</button>
				</form>
			{/if}
		</div>

		<div class="border-t border-white/10 px-4 py-4">
			<button
				class="flex min-h-12 w-full items-center justify-center rounded-lg bg-accent px-4 text-base font-bold text-on-accent disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={isSaving || submitDisabled}
				onclick={onAddSelected}
			>
				{addSelectedLabel}
			</button>
		</div>
	</div>
</div>
