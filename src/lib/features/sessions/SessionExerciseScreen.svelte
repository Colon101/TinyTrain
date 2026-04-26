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
		SessionSetSide,
		SessionSetOverview
	} from '$lib/db';
	import ExercisePickerSheet from '$lib/features/workouts/ExercisePickerSheet.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	// import { formatSessionStatus, formatSessionTime } from './session-format';

	type DatabaseApi = typeof import('$lib/db');
	type PickerMode = 'add' | 'swap';

	const setEditorGridClass = 'grid grid-cols-[3.2rem_repeat(3,minmax(0,1fr))_2rem] gap-2';
	const setInputBaseClass =
		'h-10 w-full rounded-md border px-2 py-0 text-center text-[1.0625rem] leading-none font-semibold outline-none placeholder:text-zinc-500';

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

	function formatPlaceholder(value?: number) {
		return typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(2))}` : '';
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

	function formatSetBadgeValue(side: SessionSetSide, order: number) {
		const paddedOrder = String(order).padStart(2, '0');

		if (side === 'right') {
			return `R${order}`;
		}

		if (side === 'left') {
			return `L${order}`;
		}

		return paddedOrder;
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

	function getDeltaToneClass(state: SessionFieldDelta['state']) {
		if (state === 'improved') {
			return 'text-emerald-700';
		}

		if (state === 'regressed') {
			return 'text-red-700';
		}

		return 'text-zinc-500';
	}

	function getFieldInputClass(state: SessionFieldDelta['state']) {
		if (state === 'improved') {
			return 'border-2 border-emerald-500 bg-white text-black';
		}

		if (state === 'regressed') {
			return 'border-red-500 bg-white text-black';
		}

		return 'border-zinc-300 bg-white text-black';
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
		<div class="sticky top-0 z-10 bg-[#080b0d] pb-3">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
						Exercise {exerciseIndex + 1} / {overview.exercises.length}
					</p>
					<h1
						class="mt-1.5 line-clamp-2 text-2xl leading-tight font-semibold break-words text-white"
					>
						{activeExercise.exerciseNameSnapshot}
					</h1>
					<p class="mt-1.5 text-xs leading-5 text-zinc-400">
						{overview.summary.workoutNameSnapshot} ·
						{activeExercise.exercise?.unilateral ? 'Unilateral' : 'Bilateral'}
					</p>
				</div>

				<div class="relative flex shrink-0 items-start gap-2">
					<button
						class="flex h-9 min-w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 text-sm font-semibold text-zinc-300"
						type="button"
						onclick={() => (isMenuOpen = !isMenuOpen)}
					>
						···
					</button>

					{#if isMenuOpen}
						<div
							class="absolute top-12 right-0 z-10 grid min-w-44 gap-2 rounded-lg border border-white/10 bg-[#0f1519] p-2 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
						>
							<a
								class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
								href={resolve('/(app)/sessions/[sessionId]', { sessionId })}
							>
								Session overview
							</a>
							<button
								class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
								type="button"
								disabled={isSaving}
								onclick={handleAddSet}
							>
								Add set
							</button>
							<button
								class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
								type="button"
								disabled={isSaving}
								onclick={() => openExercisePicker('swap')}
							>
								Swap exercise
							</button>
							<button
								class="rounded-lg px-3 py-2 text-left text-sm font-medium text-red-200"
								type="button"
								disabled={isSaving}
								onclick={handleRemoveExercise}
							>
								Remove exercise
							</button>
						</div>
					{/if}
				</div>
			</div>
			<!-- 			<div class="mt-2 flex items-center justify-between gap-3 text-[11px] text-zinc-500">
				<span>{activeExercise.sets.length} logged row{activeExercise.sets.length === 1 ? '' : 's'}</span>
				<span>Placeholders show your last matching set</span>
			</div> -->
		</div>

		<section class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
			{#if activeExercise.sets.length > 0}
				<div
					class={`${setEditorGridClass} mb-1.5 px-2.5 text-[10px] font-semibold tracking-[0.16em] text-zinc-500 uppercase`}
				>
					<span>Set</span>
					<span class="text-center">Weight</span>
					<span class="text-center">Reps</span>
					<span class="text-center">RIR</span>
					<span class="sr-only">Remove</span>
				</div>

				<div class="grid gap-1.5">
					{#each activeExercise.sets as set (set.id)}
						<div
							class={`${setEditorGridClass} items-center rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2`}
						>
							<div class="flex min-w-0 items-center justify-center">
								<button
									class="flex w-full flex-col items-center justify-center rounded-md leading-none transition hover:bg-white/[0.06] disabled:opacity-50"
									type="button"
									title="Fill from previous session"
									disabled={!set.previousReference || isSaving}
									onclick={() => autofillPreviousSet(set)}
								>
									<p class="text-[10px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">
										Set
									</p>
									<p class="mt-1 text-xl font-bold text-white tabular-nums">
										{formatSetBadgeValue(set.side, set.order)}
									</p>
								</button>
							</div>

							<div class="relative w-full max-w-[7.25rem] justify-self-center">
								<input
									class={`${setInputBaseClass} ${getFieldInputClass(set.weightDelta.state)}`}
									type="text"
									inputmode="decimal"
									enterkeyhint="next"
									data-session-set-input="true"
									value={set.weightInput ?? ''}
									placeholder={formatPlaceholder(set.previousReference?.weight)}
									oninput={(event) => handleSetInput(set.id, 'weight', event)}
									onkeydown={handleSetInputKeydown}
								/>
								{#if set.weightDelta.label}
									<span
										class={`pointer-events-none absolute bottom-1 left-2 text-[9px] leading-none font-semibold ${getDeltaToneClass(set.weightDelta.state)}`}
									>
										{set.weightDelta.label}
									</span>
								{/if}
							</div>

							<div class="relative w-full max-w-[7.25rem] justify-self-center">
								<input
									class={`${setInputBaseClass} ${getFieldInputClass(set.repsDelta.state)}`}
									type="text"
									inputmode="numeric"
									pattern="[0-9]*"
									enterkeyhint="next"
									data-session-set-input="true"
									value={set.repsInput ?? ''}
									placeholder={formatPlaceholder(set.previousReference?.reps)}
									oninput={(event) => handleSetInput(set.id, 'reps', event)}
									onkeydown={handleSetInputKeydown}
								/>
								{#if set.repsDelta.label}
									<span
										class={`pointer-events-none absolute bottom-1 left-2 text-[9px] leading-none font-semibold ${getDeltaToneClass(set.repsDelta.state)}`}
									>
										{set.repsDelta.label}
									</span>
								{/if}
							</div>

							<div class="relative w-full max-w-[7.25rem] justify-self-center">
								<input
									class={`${setInputBaseClass} ${getFieldInputClass(set.rirDelta.state)}`}
									type="text"
									inputmode="numeric"
									pattern="[0-9]*"
									enterkeyhint="next"
									data-session-set-input="true"
									value={set.rirInput ?? ''}
									placeholder={formatPlaceholder(set.previousReference?.rir)}
									oninput={(event) => handleSetInput(set.id, 'rir', event)}
									onkeydown={handleSetInputKeydown}
								/>
								{#if set.rirDelta.label}
									<span
										class={`pointer-events-none absolute bottom-1 left-2 text-[9px] leading-none font-semibold ${getDeltaToneClass(set.rirDelta.state)}`}
									>
										{set.rirDelta.label}
									</span>
								{/if}
							</div>

							<div class="flex items-center justify-center">
								<button
									class="flex h-10 w-8 items-center justify-center rounded-md text-zinc-400 transition hover:bg-red-400/10 hover:text-red-100 disabled:opacity-50"
									type="button"
									title={activeExercise.exercise?.unilateral ? 'Remove set pair' : 'Remove set'}
									disabled={isSaving}
									onclick={() => handleRemoveSet(set.id)}
								>
									<Icon name="x" class="h-4 w-4" />
								</button>
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<div
					class="rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-zinc-400"
				>
					This exercise has no sets yet. Add a set to begin logging.
				</div>
			{/if}

			<button
				class="mt-2.5 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white disabled:text-zinc-500"
				type="button"
				disabled={isSaving}
				onclick={handleAddSet}
			>
				<Icon name="plus" class="h-4 w-4" />
				Add set
			</button>
		</section>

		<div
			class="sticky bottom-0 z-10 mt-2 grid shrink-0 gap-2.5 border-t border-white/10 bg-[#080b0d] pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"
		>
			<!-- 			<a
				class="flex min-h-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white"
				href={resolve('/(app)/sessions/[sessionId]', { sessionId })}
			>
				Session overview
			</a> -->

			<div class="grid grid-cols-2 gap-2.5">
				<button
					class="flex min-h-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white disabled:text-zinc-500"
					type="button"
					disabled={isSaving || !previousExercise}
					onclick={goToPreviousExercise}
				>
					Previous
				</button>
				<button
					class="flex min-h-10 items-center justify-center rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
					type="button"
					disabled={isSaving || !nextExercise}
					onclick={goToNextExercise}
				>
					Next
				</button>
			</div>

			{#if isLastExercise}
				<button
					class="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white disabled:text-zinc-500"
					type="button"
					disabled={isSaving}
					onclick={() => openExercisePicker('add')}
				>
					<Icon name="plus" class="h-4 w-4" />
					Add exercise
				</button>
				<button
					class="flex min-h-10 items-center justify-center rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
					type="button"
					disabled={isSaving}
					onclick={handleEndSession}
				>
					End session
				</button>
			{/if}
		</div>
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
