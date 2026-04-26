<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type {
		Exercise,
		SessionFieldDelta,
		SessionInputField,
		SessionOverview,
		SessionSetOverview
	} from '$lib/db';
	import ExercisePickerSheet from '$lib/features/workouts/ExercisePickerSheet.svelte';
	import SessionExerciseFooter from './SessionExerciseFooter.svelte';
	import SessionExerciseHeader from './SessionExerciseHeader.svelte';
	import SessionSetEditor from './SessionSetEditor.svelte';
	// import { formatSessionStatus, formatSessionTime } from './session-format';

	type DatabaseApi = typeof import('$lib/db');
	type PickerMode = 'add' | 'swap';

	let {
		sessionId,
		sessionExerciseId
	}: {
		sessionId: string;
		sessionExerciseId: string;
	} = $props();

	let api = $state<DatabaseApi | null>(null);
	let overview = $state<SessionOverview | null>(null);
	let exercises = $state<Exercise[]>([]);
	let isLoading = $state(true);
	let isSaving = $state(false);
	let errorMessage = $state('');
	let isMenuOpen = $state(false);
	let isExercisePickerOpen = $state(false);
	let pickerMode = $state<PickerMode>('add');
	let exerciseSearch = $state('');
	let selectedPickerExerciseIds = $state<string[]>([]);
	let newExerciseName = $state('');
	let isNewExerciseUnilateral = $state(false);
	let inputVersions = new SvelteMap<string, number>();

	let activeExercise = $derived(
		overview?.exercises.find((sessionExercise) => sessionExercise.id === sessionExerciseId) ?? null
	);
	let exerciseIndex = $derived(
		overview?.exercises.findIndex((sessionExercise) => sessionExercise.id === sessionExerciseId) ??
			-1
	);
	let previousExercise = $derived(
		exerciseIndex > 0 && overview ? overview.exercises[exerciseIndex - 1] : null
	);
	let nextExercise = $derived(
		exerciseIndex >= 0 && overview ? (overview.exercises[exerciseIndex + 1] ?? null) : null
	);
	let isLastExercise = $derived(
		exerciseIndex >= 0 && overview ? exerciseIndex === overview.exercises.length - 1 : false
	);
	let selectedExerciseIds = $derived(
		new Set((overview?.exercises ?? []).map((sessionExercise) => sessionExercise.exerciseId))
	);
	let selectedPickerExerciseIdSet = $derived(new Set(selectedPickerExerciseIds));
	let cleanExerciseSearch = $derived(exerciseSearch.trim().replace(/\s+/g, ' '));
	let normalizedExerciseSearch = $derived(cleanExerciseSearch.toLocaleLowerCase());
	let filteredExercises = $derived(
		cleanExerciseSearch
			? exercises.filter((exercise) => exercise.normalizedName.includes(normalizedExerciseSearch))
			: exercises
	);
	let visiblePickerExercises = $derived(filteredExercises.slice(0, cleanExerciseSearch ? 80 : 60));
	let hiddenPickerExerciseCount = $derived(
		Math.max(filteredExercises.length - visiblePickerExercises.length, 0)
	);
	let hasExactExerciseMatch = $derived(
		Boolean(cleanExerciseSearch) &&
			exercises.some((exercise) => exercise.normalizedName === normalizedExerciseSearch)
	);
	let canCreateCustomExercise = $derived(
		Boolean(cleanExerciseSearch) && filteredExercises.length < 5 && !hasExactExerciseMatch
	);
	let addSelectedLabel = $derived(
		pickerMode === 'swap'
			? 'Swap exercise'
			: selectedPickerExerciseIds.length === 0
				? 'Add exercise(s)'
				: `Add ${selectedPickerExerciseIds.length} exercise${
						selectedPickerExerciseIds.length === 1 ? '' : 's'
					}`
	);

	onMount(() => {
		let disposed = false;

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (disposed) {
					return;
				}

				api = dbApi;
				await loadData();
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

	function getErrorMessage(error: unknown) {
		return error instanceof Error ? error.message : 'Something went wrong.';
	}

	function requireApi() {
		if (!api) {
			throw new Error('The local database is still loading.');
		}

		return api;
	}

	async function loadData() {
		const dbApi = requireApi();
		await dbApi.cleanupStaleSessions();
		const [nextOverview, nextExercises] = await Promise.all([
			dbApi.getEditableSession(sessionId),
			dbApi.listExercises()
		]);

		overview = nextOverview;
		exercises = nextExercises;
		isMenuOpen = false;
	}

	async function runMutation(
		action: () => Promise<void>,
		afterSuccess?: () => Promise<void> | void
	) {
		isSaving = true;
		errorMessage = '';

		try {
			await action();
			await loadData();
			await afterSuccess?.();
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isSaving = false;
		}
	}

	function parseInputValue(rawValue: string) {
		if (!rawValue.trim()) {
			return undefined;
		}

		const nextValue = Number(rawValue.trim());

		return Number.isFinite(nextValue) ? nextValue : undefined;
	}

	function sanitizeInputValue(field: SessionInputField, rawValue: string) {
		if (field === 'reps' || field === 'rir') {
			return rawValue.replace(/\D/g, '');
		}

		const normalizedValue = rawValue.replace(',', '.').replace(/[^\d.]/g, '');
		const [whole = '', ...decimalParts] = normalizedValue.split('.');

		return decimalParts.length === 0 ? whole : `${whole}.${decimalParts.join('')}`;
	}

	function formatInputValue(value?: number) {
		return typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(2))}` : '';
	}

	function formatAutofillInputValue(field: SessionInputField, value?: number) {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			return '';
		}

		return field === 'reps' || field === 'rir' ? `${Math.round(value)}` : formatInputValue(value);
	}

	function createFieldDelta(current?: number, previous?: number): SessionFieldDelta {
		if (
			typeof current !== 'number' ||
			!Number.isFinite(current) ||
			typeof previous !== 'number' ||
			!Number.isFinite(previous)
		) {
			return {
				state: 'empty',
				label: ''
			};
		}

		const diff = Number((current - previous).toFixed(2));

		if (diff > 0) {
			return {
				state: 'improved',
				label: `+${Number(diff.toFixed(2))}`
			};
		}

		if (diff < 0) {
			return {
				state: 'regressed',
				label: `${Number(diff.toFixed(2))}`
			};
		}

		return {
			state: 'matched',
			label: ''
		};
	}

	function rebuildSetOverview(
		sessionSet: SessionSetOverview,
		overrides: Partial<SessionSetOverview>
	): SessionSetOverview {
		const nextSet = {
			...sessionSet,
			...overrides
		};

		return {
			...nextSet,
			weightDelta: createFieldDelta(nextSet.weight, nextSet.previousReference?.weight),
			repsDelta: createFieldDelta(nextSet.reps, nextSet.previousReference?.reps),
			rirDelta: createFieldDelta(nextSet.rir, nextSet.previousReference?.rir)
		};
	}

	function updateOverviewSet(
		sessionSetId: string,
		updater: (sessionSet: SessionSetOverview) => SessionSetOverview
	) {
		if (!overview) {
			return;
		}

		overview = {
			...overview,
			exercises: overview.exercises.map((sessionExercise) => {
				const sessionSets = sessionExercise.sets as SessionSetOverview[];

				return {
					...sessionExercise,
					sets: sessionSets.map((sessionSet) =>
						sessionSet.id === sessionSetId ? updater(sessionSet) : sessionSet
					)
				};
			})
		};
	}

	function applyLocalInput(sessionSetId: string, field: SessionInputField, rawValue: string) {
		const parsedValue = parseInputValue(rawValue);

		updateOverviewSet(sessionSetId, (sessionSet) => {
			if (field === 'weight') {
				return rebuildSetOverview(sessionSet, {
					weightInput: rawValue,
					weight: parsedValue
				});
			}

			if (field === 'reps') {
				return rebuildSetOverview(sessionSet, {
					repsInput: rawValue,
					reps: parsedValue
				});
			}

			return rebuildSetOverview(sessionSet, {
				rirInput: rawValue,
				rir: parsedValue
			});
		});
	}

	function handleSetInput(sessionSetId: string, field: SessionInputField, event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const rawValue = sanitizeInputValue(field, input.value);

		if (input.value !== rawValue) {
			input.value = rawValue;
		}

		const key = `${sessionSetId}:${field}`;
		const nextVersion = (inputVersions.get(key) ?? 0) + 1;
		inputVersions.set(key, nextVersion);
		applyLocalInput(sessionSetId, field, rawValue);

		void (async () => {
			try {
				const updatedSet = await requireApi().updateSessionSetInput(sessionSetId, field, rawValue);

				if (inputVersions.get(key) !== nextVersion) {
					return;
				}

				updateOverviewSet(sessionSetId, (sessionSet) => rebuildSetOverview(sessionSet, updatedSet));
			} catch (error) {
				errorMessage = getErrorMessage(error);
				await loadData();
			}
		})();
	}

	function focusNextSetInput(currentInput: HTMLInputElement) {
		const inputs = [
			...document.querySelectorAll<HTMLInputElement>('[data-session-set-input="true"]')
		];
		const currentIndex = inputs.indexOf(currentInput);
		const nextInput = inputs[currentIndex + 1];

		if (nextInput) {
			nextInput.focus();
			nextInput.select();
			return;
		}

		currentInput.blur();
	}

	function handleSetInputKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter') {
			return;
		}

		event.preventDefault();
		focusNextSetInput(event.currentTarget as HTMLInputElement);
	}

	function autofillPreviousSet(sessionSet: SessionSetOverview) {
		const previousReference = sessionSet.previousReference;

		if (!previousReference) {
			return;
		}

		const values: Array<[SessionInputField, string]> = [
			['weight', formatAutofillInputValue('weight', previousReference.weight)],
			['reps', formatAutofillInputValue('reps', previousReference.reps)],
			['rir', formatAutofillInputValue('rir', previousReference.rir)]
		];
		const versions = new Map(
			values.map(([field]) => {
				const key = `${sessionSet.id}:${field}`;
				const nextVersion = (inputVersions.get(key) ?? 0) + 1;
				inputVersions.set(key, nextVersion);

				return [field, nextVersion] as const;
			})
		);

		for (const [field, rawValue] of values) {
			applyLocalInput(sessionSet.id, field, rawValue);
		}

		void (async () => {
			try {
				let updatedSet: Awaited<ReturnType<DatabaseApi['updateSessionSetInput']>> | null = null;

				for (const [field, rawValue] of values) {
					updatedSet = await requireApi().updateSessionSetInput(sessionSet.id, field, rawValue);
				}

				for (const [field, version] of versions) {
					if (inputVersions.get(`${sessionSet.id}:${field}`) !== version) {
						return;
					}
				}

				if (updatedSet) {
					updateOverviewSet(sessionSet.id, (currentSet) =>
						rebuildSetOverview(currentSet, updatedSet)
					);
				}
			} catch (error) {
				errorMessage = getErrorMessage(error);
				await loadData();
			}
		})();
	}

	function openExercisePicker(mode: PickerMode) {
		pickerMode = mode;
		exerciseSearch = '';
		selectedPickerExerciseIds = [];
		newExerciseName = '';
		isNewExerciseUnilateral = false;
		isExercisePickerOpen = true;
		isMenuOpen = false;
	}

	function closeExercisePicker() {
		isExercisePickerOpen = false;
		selectedPickerExerciseIds = [];
		newExerciseName = '';
		isNewExerciseUnilateral = false;
	}

	function handleExerciseSearchInput(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		exerciseSearch = target.value;

		if (!newExerciseName) {
			newExerciseName = target.value;
		}
	}

	function handleCustomExerciseNameInput(value: string) {
		newExerciseName = value;
	}

	function togglePickerExercise(exerciseId: string) {
		if (selectedExerciseIds.has(exerciseId)) {
			return;
		}

		if (pickerMode === 'swap') {
			selectedPickerExerciseIds = selectedPickerExerciseIdSet.has(exerciseId) ? [] : [exerciseId];
			return;
		}

		if (selectedPickerExerciseIdSet.has(exerciseId)) {
			selectedPickerExerciseIds = selectedPickerExerciseIds.filter((id) => id !== exerciseId);
			return;
		}

		selectedPickerExerciseIds = [...selectedPickerExerciseIds, exerciseId];
	}

	function getPickerExercisePosition(exerciseId: string) {
		if (!overview || pickerMode === 'swap') {
			return null;
		}

		const queuedIndex = selectedPickerExerciseIds.indexOf(exerciseId);

		if (queuedIndex >= 0) {
			return overview.exercises.length + queuedIndex + 1;
		}

		return null;
	}

	async function applyPickedExercises(exerciseIds: string[]) {
		if (!overview || !activeExercise || exerciseIds.length === 0) {
			return;
		}

		const dbApi = requireApi();

		if (pickerMode === 'swap') {
			await dbApi.replaceSessionExercise(activeExercise.id, exerciseIds[0]);
			closeExercisePicker();
			return;
		}

		for (const exerciseId of exerciseIds) {
			await dbApi.addExerciseToSession(overview.summary.id, exerciseId);
		}

		closeExercisePicker();
	}

	function handleAddSelected() {
		const pickedIds = [...selectedPickerExerciseIds];

		void runMutation(
			async () => {
				await applyPickedExercises(pickedIds);
			},
			async () => {
				if (pickerMode === 'add' && pickedIds.length > 0 && overview) {
					const addedExercise = overview.exercises.find(
						(sessionExercise) => sessionExercise.exerciseId === pickedIds[pickedIds.length - 1]
					);

					if (addedExercise) {
						await goto(
							resolve('/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]', {
								sessionId,
								sessionExerciseId: addedExercise.id
							}),
							{ replaceState: true }
						);
					}
				}
			}
		);
	}

	function handleCreateExercise(event: SubmitEvent) {
		event.preventDefault();

		const exerciseName = (newExerciseName || cleanExerciseSearch).trim();

		if (!exerciseName) {
			return;
		}

		void runMutation(
			async () => {
				const exercise = await requireApi().createExercise(exerciseName, isNewExerciseUnilateral);
				await applyPickedExercises([exercise.id]);
			},
			async () => {
				if (pickerMode === 'add' && overview) {
					const addedExercise = overview.exercises.find(
						(sessionExercise) => sessionExercise.exerciseNameSnapshot === exerciseName
					);

					if (addedExercise) {
						await goto(
							resolve('/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]', {
								sessionId,
								sessionExerciseId: addedExercise.id
							}),
							{ replaceState: true }
						);
					}
				}
			}
		);
	}

	function handleStartSession() {
		void runMutation(async () => {
			await requireApi().startWorkoutSession(sessionId);
		});
	}

	function handleAddSet() {
		if (!activeExercise) {
			return;
		}

		void runMutation(async () => {
			await requireApi().addSessionSetRow(activeExercise.id);
		});
	}

	function handleRemoveSet(sessionSetId: string) {
		void runMutation(async () => {
			await requireApi().removeSessionSetRow(sessionSetId);
		});
	}

	function handleRemoveExercise() {
		if (!activeExercise || !overview) {
			return;
		}

		const nextRouteTarget =
			overview.exercises[exerciseIndex + 1] ?? overview.exercises[exerciseIndex - 1] ?? null;

		if (
			activeExercise.sets.some(
				(sessionSet) =>
					sessionSet.weightInput?.trim() ||
					sessionSet.repsInput?.trim() ||
					sessionSet.rirInput?.trim()
			) &&
			!window.confirm(
				`Remove ${activeExercise.exerciseNameSnapshot} and discard its logged values?`
			)
		) {
			return;
		}

		void runMutation(
			async () => {
				await requireApi().removeSessionExercise(activeExercise.id);
			},
			async () => {
				if (nextRouteTarget) {
					await goto(
						resolve('/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]', {
							sessionId,
							sessionExerciseId: nextRouteTarget.id
						}),
						{ replaceState: true }
					);
					return;
				}

				await goto(resolve('/(app)/sessions/[sessionId]', { sessionId }), { replaceState: true });
			}
		);
	}

	function handleEndSession() {
		if (!window.confirm('End this session?')) {
			return;
		}

		void runMutation(
			async () => {
				await requireApi().completeWorkoutSession(sessionId);
			},
			async () => {
				await goto(resolve('/(app)/sessions/[sessionId]', { sessionId }), { replaceState: true });
			}
		);
	}

	function goToNextExercise() {
		if (nextExercise) {
			void goto(
				resolve('/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]', {
					sessionId,
					sessionExerciseId: nextExercise.id
				})
			);
		}
	}

	function goToPreviousExercise() {
		if (previousExercise) {
			void goto(
				resolve('/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]', {
					sessionId,
					sessionExerciseId: previousExercise.id
				})
			);
		}
	}
</script>

<section class="flex min-h-0 flex-1 flex-col overflow-hidden">
	{#if errorMessage}
		<p
			class="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
			role="alert"
		>
			{errorMessage}
		</p>
	{/if}

	{#if isLoading}
		<section class="flex flex-1 flex-col justify-center">
			<div class="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
				<div class="h-full w-1/2 animate-pulse rounded-full bg-emerald-300"></div>
			</div>
			<h1 class="mt-5 text-2xl font-semibold text-white">Loading exercise</h1>
		</section>
	{:else if !overview || !activeExercise}
		<section class="flex flex-1 flex-col justify-center">
			<h1 class="text-3xl font-semibold text-white">Exercise not found</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				This exercise is not available in the current session.
			</p>
			<a
				class="mt-6 flex min-h-12 items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950"
				href={resolve('/(app)/sessions/[sessionId]', { sessionId })}
			>
				Back to session
			</a>
		</section>
	{:else if overview.summary.status !== 'in_progress'}
		<section class="flex flex-1 flex-col justify-center">
			<h1 class="text-3xl font-semibold text-white">{activeExercise.exerciseNameSnapshot}</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				Start the session before you begin logging set data.
			</p>

			<div class="mt-6 grid gap-3">
				<button
					class="flex min-h-12 items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
					type="button"
					disabled={isSaving || overview.summary.status !== 'planned'}
					onclick={handleStartSession}
				>
					Start session
				</button>
				<a
					class="flex min-h-12 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-4 text-base font-semibold text-white"
					href={resolve('/(app)/sessions/[sessionId]', { sessionId })}
				>
					Back to session
				</a>
			</div>
		</section>
	{:else}
		<SessionExerciseHeader
			{sessionId}
			{activeExercise}
			workoutName={overview.summary.workoutNameSnapshot}
			{exerciseIndex}
			totalExercises={overview.exercises.length}
			{isSaving}
			{isMenuOpen}
			onToggleMenu={() => (isMenuOpen = !isMenuOpen)}
			onAddSet={handleAddSet}
			onSwapExercise={() => openExercisePicker('swap')}
			onRemoveExercise={handleRemoveExercise}
		/>

		<SessionSetEditor
			sets={activeExercise.sets}
			{isSaving}
			isUnilateral={Boolean(activeExercise.exercise?.unilateral)}
			onAutofillPreviousSet={autofillPreviousSet}
			onSetInput={handleSetInput}
			onSetInputKeydown={handleSetInputKeydown}
			onAddSet={handleAddSet}
			onRemoveSet={handleRemoveSet}
		/>

		<SessionExerciseFooter
			{previousExercise}
			{nextExercise}
			{isLastExercise}
			{isSaving}
			onPreviousExercise={goToPreviousExercise}
			onNextExercise={goToNextExercise}
			onAddExercise={() => openExercisePicker('add')}
			onEndSession={handleEndSession}
		/>
	{/if}

	{#if isExercisePickerOpen}
		<ExercisePickerSheet
			{exerciseSearch}
			{newExerciseName}
			{isNewExerciseUnilateral}
			{visiblePickerExercises}
			{hiddenPickerExerciseCount}
			{selectedPickerExerciseIdSet}
			{selectedExerciseIds}
			{addSelectedLabel}
			submitDisabled={selectedPickerExerciseIds.length === 0}
			{canCreateCustomExercise}
			{isSaving}
			sheetEyebrow={pickerMode === 'swap' ? 'Swap exercise' : 'Exercise picker'}
			sheetTitle={pickerMode === 'swap' ? 'Pick a replacement' : 'Add exercises'}
			onClose={closeExercisePicker}
			onExerciseSearchInput={handleExerciseSearchInput}
			onCustomExerciseNameInput={handleCustomExerciseNameInput}
			onTogglePickerExercise={togglePickerExercise}
			onToggleUnilateral={(nextValue) => (isNewExerciseUnilateral = nextValue)}
			onCreateExercise={handleCreateExercise}
			onAddSelected={handleAddSelected}
			{getPickerExercisePosition}
		/>
	{/if}
</section>
