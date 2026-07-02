<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteDate } from 'svelte/reactivity';
	import { resolve } from '$app/paths';
	import Icon from '$lib/ui/Icon.svelte';
	import type {
		BackfillWorkoutSessionInput,
		SessionSetSide,
		Workout,
		WorkoutExerciseWithExercise
	} from '$lib/db';

	type DatabaseApi = typeof import('$lib/db');
	type SetDraft = {
		id: string;
		order: number;
		side: SessionSetSide;
		weightInput: string;
		repsInput: string;
		rirInput: string;
	};
	type ExerciseDraft = {
		exerciseId: string;
		name: string;
		unilateral: boolean;
		sets: SetDraft[];
	};

	let api = $state<DatabaseApi | null>(null);
	let workouts = $state<Workout[]>([]);
	let workoutExercises = $state<WorkoutExerciseWithExercise[]>([]);
	let exerciseDrafts = $state<ExerciseDraft[]>([]);
	let selectedWorkoutId = $state('');
	let dayKey = $state(getDefaultDayKey());
	let startTime = $state('18:00');
	let durationMinutesInput = $state('60');
	let savedSessionId = $state('');
	let isLoading = $state(true);
	let isSaving = $state(false);
	let message = $state('');
	let errorMessage = $state('');

	let selectedWorkout = $derived(
		workouts.find((workout) => workout.id === selectedWorkoutId) ?? null
	);
	let loggedSetCount = $derived(
		exerciseDrafts.reduce(
			(count, exercise) => count + exercise.sets.filter(hasAnySetValue).length,
			0
		)
	);
	let canSave = $derived(Boolean(selectedWorkoutId && loggedSetCount > 0 && !isSaving));

	onMount(() => {
		let disposed = false;

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (disposed) {
					return;
				}

				api = dbApi;
				await dbApi.ensureBaselineExercises();
				workouts = await dbApi.listWorkouts();
				selectedWorkoutId = workouts[0]?.id ?? '';

				if (selectedWorkoutId) {
					await loadWorkoutExercises(selectedWorkoutId);
				}
			} catch (error) {
				errorMessage = getErrorMessage(error);
			} finally {
				isLoading = false;
			}
		})();

		return () => {
			disposed = true;
		};
	});

	function getDefaultDayKey() {
		const date = new SvelteDate();
		date.setDate(date.getDate() - 1);

		return [
			String(date.getFullYear()).padStart(4, '0'),
			String(date.getMonth() + 1).padStart(2, '0'),
			String(date.getDate()).padStart(2, '0')
		].join('-');
	}

	function getErrorMessage(error: unknown) {
		return error instanceof Error ? error.message : 'Something went wrong.';
	}

	function requireApi() {
		if (!api) {
			throw new Error('The local database is still loading.');
		}

		return api;
	}

	function createSetDraft(order: number, side: SessionSetSide): SetDraft {
		return {
			id: crypto.randomUUID(),
			order,
			side,
			weightInput: '',
			repsInput: '',
			rirInput: ''
		};
	}

	function createSetDrafts(order: number, unilateral: boolean) {
		return unilateral
			? [createSetDraft(order, 'right'), createSetDraft(order, 'left')]
			: [createSetDraft(order, 'bilateral')];
	}

	function createExerciseDraft(workoutExercise: WorkoutExerciseWithExercise): ExerciseDraft {
		const unilateral = workoutExercise.exercise.unilateral;

		return {
			exerciseId: workoutExercise.exercise.id,
			name: workoutExercise.exercise.name,
			unilateral,
			sets: [1, 2, 3].flatMap((order) => createSetDrafts(order, unilateral))
		};
	}

	function hasAnySetValue(set: SetDraft) {
		return Boolean(set.weightInput.trim() || set.repsInput.trim() || set.rirInput.trim());
	}

	async function loadWorkoutExercises(workoutId: string) {
		const nextWorkoutExercises = await requireApi().listWorkoutExercises(workoutId);

		workoutExercises = nextWorkoutExercises;
		exerciseDrafts = nextWorkoutExercises.map(createExerciseDraft);
		savedSessionId = '';
		message = '';
		errorMessage = '';
	}

	function handleWorkoutChange(event: Event) {
		const workoutId = (event.currentTarget as HTMLSelectElement).value;
		selectedWorkoutId = workoutId;

		if (!workoutId) {
			workoutExercises = [];
			exerciseDrafts = [];
			return;
		}

		void loadWorkoutExercises(workoutId);
	}

	function addSet(exerciseId: string) {
		exerciseDrafts = exerciseDrafts.map((exercise) =>
			exercise.exerciseId === exerciseId
				? {
						...exercise,
						sets: [
							...exercise.sets,
							...createSetDrafts(
								Math.max(0, ...exercise.sets.map((set) => set.order)) + 1,
								exercise.unilateral
							)
						]
					}
				: exercise
		);
	}

	function removeSet(exerciseId: string, setId: string) {
		exerciseDrafts = exerciseDrafts.map((exercise) => {
			if (exercise.exerciseId !== exerciseId) {
				return exercise;
			}

			const targetSet = exercise.sets.find((set) => set.id === setId);
			const removableSetCount = exercise.unilateral ? 2 : 1;

			if (!targetSet || exercise.sets.length <= removableSetCount) {
				return exercise;
			}

			const nextSets = exercise.unilateral
				? exercise.sets.filter((set) => set.order !== targetSet.order)
				: exercise.sets.filter((set) => set.id !== setId);
			const uniqueOrders = [...new Set(nextSets.map((set) => set.order))].sort(
				(first, second) => first - second
			);
			const nextOrderByCurrentOrder = new Map(
				uniqueOrders.map((order, index) => [order, index + 1] as const)
			);

			return {
				...exercise,
				sets: nextSets.map((set) => ({
					...set,
					order: nextOrderByCurrentOrder.get(set.order) ?? set.order
				}))
			};
		});
	}

	function getSetLabel(set: SetDraft) {
		if (set.side === 'right') {
			return `R${set.order}`;
		}

		if (set.side === 'left') {
			return `L${set.order}`;
		}

		return `${set.order}`;
	}

	function updateSet(
		exerciseId: string,
		setId: string,
		field: 'weightInput' | 'repsInput' | 'rirInput',
		value: string
	) {
		exerciseDrafts = exerciseDrafts.map((exercise) => {
			if (exercise.exerciseId !== exerciseId) {
				return exercise;
			}

			return {
				...exercise,
				sets: exercise.sets.map((set) => (set.id === setId ? { ...set, [field]: value } : set))
			};
		});
	}

	function clearForm() {
		exerciseDrafts = workoutExercises.map(createExerciseDraft);
		savedSessionId = '';
		message = '';
		errorMessage = '';
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();

		if (!selectedWorkoutId || !canSave) {
			return;
		}

		isSaving = true;
		message = '';
		errorMessage = '';
		savedSessionId = '';

		try {
			const durationMinutes = Number(durationMinutesInput);
			const input: BackfillWorkoutSessionInput = {
				workoutId: selectedWorkoutId,
				dayKey,
				startTime,
				durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 60,
				exercises: exerciseDrafts.map((exercise) => ({
					exerciseId: exercise.exerciseId,
					sets: exercise.sets.map((set) => ({
						order: set.order,
						side: set.side,
						weightInput: set.weightInput,
						repsInput: set.repsInput,
						rirInput: set.rirInput
					}))
				}))
			};
			const summary = await requireApi().createBackfillWorkoutSession(input);

			savedSessionId = summary.id;
			message = `${summary.workoutNameSnapshot} saved for ${summary.dayKey}.`;
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isSaving = false;
		}
	}
</script>

<section class="box-border flex min-w-0 flex-1 flex-col px-1">
	<div class="border-b border-white/10 pb-5">
		<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Testing</p>
		<h1 class="mt-2 text-3xl font-semibold text-white">Backfill workouts</h1>
		<p class="mt-2 text-sm leading-6 text-zinc-400">
			Log a completed session from an existing workout template while you move history into
			TinyTrain.
		</p>
	</div>

	{#if isLoading}
		<div class="flex min-h-40 items-center justify-center text-sm text-zinc-400">
			<Icon name="loader-circle" class="mr-2 h-4 w-4 animate-spin" />
			Loading backfill editor
		</div>
	{:else if workouts.length === 0}
		<div class="py-5">
			<div
				class="rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-zinc-400"
			>
				Create a workout template first, then return here to backfill completed sessions.
			</div>
			<a
				class="mt-4 flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950"
				href={resolve('/workouts')}
			>
				<Icon name="dumbbell" class="h-4 w-4" />
				Open workouts
			</a>
		</div>
	{:else}
		<form class="grid gap-5 py-5" autocomplete="off" onsubmit={handleSubmit}>
			<section class="grid gap-3 border-b border-white/10 pb-5">
				<label class="block" for="backfill-workout">
					<span class="mb-2 block text-sm font-medium text-zinc-300">Workout</span>
					<select
						id="backfill-workout"
						class="min-h-12 w-full rounded-lg border border-white/10 bg-zinc-950 px-3 text-base text-white outline-none focus:border-emerald-300/60"
						value={selectedWorkoutId}
						disabled={isSaving}
						onchange={handleWorkoutChange}
					>
						{#each workouts as workout (workout.id)}
							<option value={workout.id}>{workout.name}</option>
						{/each}
					</select>
				</label>

				<div class="grid grid-cols-2 gap-3">
					<label class="block" for="backfill-date">
						<span class="mb-2 block text-sm font-medium text-zinc-300">Date</span>
						<input
							id="backfill-date"
							class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none focus:border-emerald-300/60"
							type="date"
							name="tinytrain-backfill-date"
							autocomplete="off"
							value={dayKey}
							disabled={isSaving}
							oninput={(event) => (dayKey = (event.currentTarget as HTMLInputElement).value)}
						/>
					</label>

					<label class="block" for="backfill-start">
						<span class="mb-2 block text-sm font-medium text-zinc-300">Start</span>
						<input
							id="backfill-start"
							class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none focus:border-emerald-300/60"
							type="time"
							name="tinytrain-backfill-start"
							autocomplete="off"
							value={startTime}
							disabled={isSaving}
							oninput={(event) => (startTime = (event.currentTarget as HTMLInputElement).value)}
						/>
					</label>
				</div>

				<label class="block" for="backfill-duration">
					<span class="mb-2 block text-sm font-medium text-zinc-300">Duration minutes</span>
					<input
						id="backfill-duration"
						class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none focus:border-emerald-300/60"
						type="number"
						name="tinytrain-backfill-duration"
						autocomplete="off"
						min="1"
						step="1"
						inputmode="numeric"
						value={durationMinutesInput}
						disabled={isSaving}
						oninput={(event) =>
							(durationMinutesInput = (event.currentTarget as HTMLInputElement).value)}
					/>
				</label>
			</section>

			<section class="grid gap-4">
				<div class="flex items-end justify-between gap-3">
					<div class="min-w-0">
						<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
							{selectedWorkout?.name ?? 'Workout'} log
						</p>
						<p class="mt-1 text-sm text-zinc-400">{loggedSetCount} set rows ready to save.</p>
					</div>
					<button
						class="min-h-10 rounded-lg border border-white/10 px-3 text-sm font-semibold text-zinc-300 disabled:text-zinc-600"
						type="button"
						disabled={isSaving}
						onclick={clearForm}
					>
						Clear
					</button>
				</div>

				{#each exerciseDrafts as exercise (exercise.exerciseId)}
					<section class="rounded-lg border border-white/10 bg-white/[0.03]">
						<div class="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-3">
							<div class="min-w-0">
								<h2 class="truncate text-base font-semibold text-white">{exercise.name}</h2>
								<p class="mt-0.5 text-xs text-zinc-500">
									{exercise.unilateral ? 'Unilateral' : 'Bilateral'} · {exercise.sets.filter(
										hasAnySetValue
									).length} logged
								</p>
							</div>
							<button
								class="flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-semibold text-zinc-300 disabled:text-zinc-600"
								type="button"
								disabled={isSaving}
								onclick={() => addSet(exercise.exerciseId)}
							>
								<Icon name="plus" class="h-4 w-4" />
								Set
							</button>
						</div>

						<div class="grid gap-2 p-3">
							<div
								class="grid grid-cols-[2.5rem_1fr_1fr_1fr_2.5rem] gap-2 px-1 text-xs font-semibold text-zinc-500"
							>
								<span>Set</span>
								<span>Weight</span>
								<span>Reps</span>
								<span>RIR</span>
								<span></span>
							</div>

							{#each exercise.sets as set (set.id)}
								<div class="grid grid-cols-[2.5rem_1fr_1fr_1fr_2.5rem] items-center gap-2">
									<p class="text-sm font-semibold text-zinc-400">{getSetLabel(set)}</p>
									<input
										class="min-h-11 min-w-0 rounded-lg border border-white/10 bg-zinc-950/60 px-2 text-base text-white outline-none placeholder:text-zinc-700 focus:border-emerald-300/60"
										name={`tinytrain-backfill-${set.id}-weight`}
										autocomplete="off"
										value={set.weightInput}
										inputmode="decimal"
										placeholder="-"
										disabled={isSaving}
										aria-label={`${exercise.name} ${getSetLabel(set)} weight`}
										oninput={(event) =>
											updateSet(
												exercise.exerciseId,
												set.id,
												'weightInput',
												(event.currentTarget as HTMLInputElement).value
											)}
									/>
									<input
										class="min-h-11 min-w-0 rounded-lg border border-white/10 bg-zinc-950/60 px-2 text-base text-white outline-none placeholder:text-zinc-700 focus:border-emerald-300/60"
										name={`tinytrain-backfill-${set.id}-reps`}
										autocomplete="off"
										value={set.repsInput}
										inputmode="numeric"
										placeholder="-"
										disabled={isSaving}
										aria-label={`${exercise.name} ${getSetLabel(set)} reps`}
										oninput={(event) =>
											updateSet(
												exercise.exerciseId,
												set.id,
												'repsInput',
												(event.currentTarget as HTMLInputElement).value
											)}
									/>
									<input
										class="min-h-11 min-w-0 rounded-lg border border-white/10 bg-zinc-950/60 px-2 text-base text-white outline-none placeholder:text-zinc-700 focus:border-emerald-300/60"
										name={`tinytrain-backfill-${set.id}-rir`}
										autocomplete="off"
										value={set.rirInput}
										inputmode="numeric"
										placeholder="-"
										disabled={isSaving}
										aria-label={`${exercise.name} ${getSetLabel(set)} RIR`}
										oninput={(event) =>
											updateSet(
												exercise.exerciseId,
												set.id,
												'rirInput',
												(event.currentTarget as HTMLInputElement).value
											)}
									/>
									<button
										class="flex h-11 w-10 items-center justify-center rounded-lg border border-white/10 text-zinc-500 disabled:text-zinc-700"
										type="button"
										disabled={isSaving || exercise.sets.length <= (exercise.unilateral ? 2 : 1)}
										aria-label={`Remove ${exercise.name} set ${set.order}`}
										onclick={() => removeSet(exercise.exerciseId, set.id)}
									>
										<Icon name="x" class="h-4 w-4" />
									</button>
								</div>
							{/each}
						</div>
					</section>
				{/each}
			</section>

			{#if message}
				<p
					class="rounded-lg border border-emerald-300/30 bg-emerald-500/10 px-3 py-3 text-sm leading-5 text-emerald-100"
				>
					{message}
				</p>
			{/if}

			{#if errorMessage}
				<p
					class="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
				>
					{errorMessage}
				</p>
			{/if}

			<div
				class="sticky bottom-0 -mx-1 border-t border-white/10 bg-[#070a0d]/95 px-1 py-3 backdrop-blur"
			>
				<div class="grid gap-2">
					<button
						class="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
						type="submit"
						disabled={!canSave}
					>
						{#if isSaving}
							<Icon name="loader-circle" class="h-5 w-5 animate-spin" />
						{:else}
							<Icon name="check" class="h-5 w-5" />
						{/if}
						Save backfill
					</button>

					{#if savedSessionId}
						<a
							class="flex min-h-11 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white"
							href={resolve('/(app)/sessions/[sessionId]', { sessionId: savedSessionId })}
						>
							Open saved session
						</a>
					{/if}
				</div>
			</div>
		</form>
	{/if}
</section>
