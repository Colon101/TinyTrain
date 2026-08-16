<script lang="ts">
	import { untrack } from 'svelte';
	import type { Exercise, ExerciseUsagePreference } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import { trapDialogFocus } from '$lib/ui/dialog-focus';

	let {
		exercises,
		exerciseUsagePreferences = [],
		disabledExerciseIds = new Set<string>(),
		initialSelectedExerciseIds = [],
		selectionMode = 'multiple',
		positionOffset,
		allowCreate = true,
		isSaving,
		sheetEyebrow = 'Exercise picker',
		sheetTitle = 'Add exercises',
		actionLabel,
		onClose,
		onCreateExercise,
		onAddSelected,
		compareExercises,
		previouslyUsed,
		getExerciseMetadata = null
	}: {
		exercises: Exercise[];
		exerciseUsagePreferences?: ExerciseUsagePreference[];
		disabledExerciseIds?: Set<string>;
		initialSelectedExerciseIds?: string[];
		selectionMode?: 'multiple' | 'single';
		positionOffset?: number;
		allowCreate?: boolean;
		isSaving: boolean;
		sheetEyebrow?: string;
		sheetTitle?: string;
		actionLabel?: string;
		onClose: () => void;
		onCreateExercise?: (name: string, unilateral: boolean) => void;
		onAddSelected: (exerciseIds: string[]) => void;
		compareExercises?: (first: Exercise, second: Exercise) => number;
		previouslyUsed?: (exercise: Exercise) => boolean;
		getExerciseMetadata?: ((exercise: Exercise) => string) | null;
	} = $props();

	let search = $state('');
	let customExerciseName = $state('');
	let isUnilateral = $state(false);
	let selectedExerciseIds = $state(
		untrack(() => initialSelectedExerciseIds.filter((id) => !disabledExerciseIds.has(id)))
	);

	let selectedExerciseIdSet = $derived(new Set(selectedExerciseIds));
	let cleanSearch = $derived(search.trim().replace(/\s+/g, ' '));
	let normalizedSearch = $derived(cleanSearch.toLocaleLowerCase());
	let usageByNormalizedName = $derived(
		new Map(exerciseUsagePreferences.map((preference) => [preference.normalizedName, preference]))
	);
	let usageById = $derived(
		new Map(
			exerciseUsagePreferences.flatMap((preference) =>
				preference.exerciseIds.map((exerciseId) => [exerciseId, preference] as const)
			)
		)
	);
	let filteredExercises = $derived(
		(cleanSearch
			? exercises.filter((exercise) => exercise.normalizedName.includes(normalizedSearch))
			: exercises
		).toSorted(compareExercises ?? comparePickerPreference)
	);
	let visibleExercises = $derived(filteredExercises.slice(0, cleanSearch ? 80 : 60));
	let hiddenExerciseCount = $derived(
		Math.max(filteredExercises.length - visibleExercises.length, 0)
	);
	let canCreateExercise = $derived(
		Boolean(
			allowCreate &&
			onCreateExercise &&
			cleanSearch &&
			filteredExercises.length < 5 &&
			!exercises.some((exercise) => exercise.normalizedName === normalizedSearch)
		)
	);
	let submitLabel = $derived(
		actionLabel ??
			(selectionMode === 'single'
				? 'Select exercise'
				: selectedExerciseIds.length === 0
					? 'Add exercise(s)'
					: `Add ${selectedExerciseIds.length} exercise${selectedExerciseIds.length === 1 ? '' : 's'}`)
	);
	let resolvedPositionOffset = $derived(
		positionOffset ?? (selectionMode === 'multiple' ? disabledExerciseIds.size : 0)
	);

	function getUsagePreference(exercise: Exercise) {
		return usageById.get(exercise.id) ?? usageByNormalizedName.get(exercise.normalizedName) ?? null;
	}

	function comparePickerPreference(first: Exercise, second: Exercise) {
		const firstUsage = getUsagePreference(first);
		const secondUsage = getUsagePreference(second);

		if (Boolean(firstUsage) !== Boolean(secondUsage)) {
			return firstUsage ? -1 : 1;
		}

		return firstUsage && secondUsage
			? secondUsage.lastPerformedAt.localeCompare(firstUsage.lastPerformedAt) ||
					secondUsage.sessionCount - firstUsage.sessionCount ||
					first.name.localeCompare(second.name)
			: first.name.localeCompare(second.name);
	}

	function isPreviouslyUsed(exercise: Exercise) {
		return previouslyUsed?.(exercise) ?? Boolean(getUsagePreference(exercise));
	}

	function handleSearchInput(event: Event) {
		const value = (event.currentTarget as HTMLInputElement).value;
		search = value;
		customExerciseName = value;
	}

	function toggleExercise(exerciseId: string) {
		if (disabledExerciseIds.has(exerciseId)) {
			return;
		}

		if (selectionMode === 'single') {
			selectedExerciseIds = selectedExerciseIdSet.has(exerciseId) ? [] : [exerciseId];
			return;
		}

		selectedExerciseIds = selectedExerciseIdSet.has(exerciseId)
			? selectedExerciseIds.filter((id) => id !== exerciseId)
			: [...selectedExerciseIds, exerciseId];
	}

	function getExercisePosition(exerciseId: string) {
		const index = selectedExerciseIds.indexOf(exerciseId);
		return index < 0 ? null : resolvedPositionOffset + index + 1;
	}

	function createExercise(event: SubmitEvent) {
		event.preventDefault();
		const name = customExerciseName.trim();

		if (name) {
			onCreateExercise?.(name, isUnilateral);
		}
	}
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
					value={search}
					autocomplete="off"
					placeholder="Bench, pull-up, row..."
					oninput={handleSearchInput}
				/>
			</label>

			<div class="mt-4 grid gap-3">
				{#each visibleExercises as exercise (exercise.id)}
					<button
						class={`flex min-h-14 w-full items-start justify-between gap-3 overflow-hidden rounded-lg border px-4 py-3 text-left transition ${
							disabledExerciseIds.has(exercise.id)
								? 'border-white/10 bg-white/[0.02] text-zinc-500'
								: selectedExerciseIdSet.has(exercise.id)
									? 'border-accent/50 bg-accent/10 text-white'
									: 'border-white/10 bg-white/[0.03] text-white'
						}`}
						type="button"
						disabled={disabledExerciseIds.has(exercise.id)}
						onclick={() => toggleExercise(exercise.id)}
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
								{#if isPreviouslyUsed(exercise)}
									<span class="text-accent-soft"> · Previously used</span>
								{/if}
							</p>
						</div>

						<div class="flex shrink-0 items-center gap-3 pt-0.5">
							{#if disabledExerciseIds.has(exercise.id)}
								<span class="text-xs font-medium text-zinc-500">Added</span>
							{:else if getExercisePosition(exercise.id)}
								<span class="text-xs font-medium text-accent-soft">
									#{getExercisePosition(exercise.id)}
								</span>
							{/if}

							{#if selectedExerciseIdSet.has(exercise.id)}
								<Icon name="check" class="h-4 w-4 text-accent-soft" />
							{/if}
						</div>
					</button>
				{/each}
			</div>

			{#if hiddenExerciseCount > 0}
				<p class="mt-3 text-sm text-zinc-500">
					{hiddenExerciseCount} more matches hidden while you type.
				</p>
			{/if}

			{#if canCreateExercise}
				<form class="mt-5 border-t border-white/10 pt-5" onsubmit={createExercise}>
					<p class="text-xs font-semibold tracking-[0.18em] text-accent-soft uppercase">
						Create custom
					</p>
					<label class="mt-3 block" for="custom-picker-exercise-name">
						<span class="mb-2 block text-sm font-medium text-zinc-300">Exercise name</span>
						<input
							id="custom-picker-exercise-name"
							class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-accent/60"
							value={customExerciseName}
							autocomplete="off"
							placeholder="Create a custom exercise"
							oninput={(event) =>
								(customExerciseName = (event.currentTarget as HTMLInputElement).value)}
						/>
					</label>

					<div class="mt-3 grid grid-cols-2 gap-2">
						<button
							class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
								!isUnilateral ? 'bg-accent text-on-accent' : 'border border-white/10 text-zinc-300'
							}`}
							type="button"
							onclick={() => (isUnilateral = false)}
						>
							Bilateral
						</button>
						<button
							class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
								isUnilateral ? 'bg-accent text-on-accent' : 'border border-white/10 text-zinc-300'
							}`}
							type="button"
							onclick={() => (isUnilateral = true)}
						>
							Unilateral
						</button>
					</div>

					<button
						class="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-base font-semibold text-white disabled:text-zinc-500"
						type="submit"
						disabled={isSaving || !customExerciseName.trim()}
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
				disabled={isSaving || selectedExerciseIds.length === 0}
				onclick={() => onAddSelected([...selectedExerciseIds])}
			>
				{submitLabel}
			</button>
		</div>
	</div>
</div>
