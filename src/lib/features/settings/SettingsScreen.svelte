<script lang="ts">
	import { onMount } from 'svelte';
	import type {
		DatabaseUploadSummary,
		Exercise,
		ExerciseMergeOption,
		ExerciseMergeResult,
		LocalDatabaseStats
	} from '$lib/db';
	import type {
		TrackedImportPhase,
		TrackedImportSummary,
		TrackedLimbPriority
	} from '$lib/tracked-import';
	import {
		DEFAULT_PROGRESS_INDICATOR_POSITION,
		PROGRESS_INDICATOR_POSITIONS,
		initializeProgressIndicatorPreference,
		progressIndicatorPosition,
		saveProgressIndicatorPosition,
		type ProgressIndicatorPosition
	} from '$lib/progress-indicator-preference';
	import ExercisePickerSheet from '$lib/features/workouts/ExercisePickerSheet.svelte';
	import Icon from '$lib/ui/Icon.svelte';

	type DatabaseApi = typeof import('$lib/db');
	type TrackedImportApi = typeof import('$lib/tracked-import');

	let api = $state<DatabaseApi | null>(null);
	let trackedImportApi = $state<TrackedImportApi | null>(null);
	let stats = $state<LocalDatabaseStats | null>(null);
	let summary = $state<DatabaseUploadSummary | null>(null);
	let mergeOptions = $state<ExerciseMergeOption[]>([]);
	let mergeResult = $state<ExerciseMergeResult | null>(null);
	let trackedSummary = $state<TrackedImportSummary | null>(null);
	let trackedFile = $state<File | null>(null);
	let trackedLimbPriorities = $state<Record<string, TrackedLimbPriority>>({});
	let mainMergeExerciseId = $state('');
	let secondaryMergeExerciseId = $state('');
	let mergeExerciseName = $state('');
	let mergePickerTarget = $state<'main' | 'secondary' | null>(null);
	let mergeExerciseSearch = $state('');
	let selectedMergePickerExerciseIds = $state<string[]>([]);
	let isLoading = $state(true);
	let isUploading = $state(false);
	let isMergingExercises = $state(false);
	let isPreviewingTracked = $state(false);
	let isImportingTracked = $state(false);
	let trackedImportPhase = $state<TrackedImportPhase>('reading');
	let errorMessage = $state('');
	let statusMessage = $state('');
	let mergeStatusMessage = $state('');
	let preferenceErrorMessage = $state('');
	let isDataOperationRunning = $derived(isUploading || isMergingExercises || isImportingTracked);
	let selectedProgressIndicatorPosition = $derived(
		$progressIndicatorPosition ?? DEFAULT_PROGRESS_INDICATOR_POSITION
	);

	let selectedMainMergeOption = $derived(
		mergeOptions.find((option) => option.exercise.id === mainMergeExerciseId) ?? null
	);
	let selectedSecondaryMergeOption = $derived(
		mergeOptions.find((option) => option.exercise.id === secondaryMergeExerciseId) ?? null
	);
	let mergeExerciseOptions = $derived(mergeOptions.map((option) => option.exercise));
	let cleanMergeExerciseSearch = $derived(mergeExerciseSearch.trim().replace(/\s+/g, ' '));
	let normalizedMergeExerciseSearch = $derived(cleanMergeExerciseSearch.toLocaleLowerCase());
	let mergeOptionByExerciseId = $derived(
		new Map(mergeOptions.map((option) => [option.exercise.id, option]))
	);
	let filteredMergePickerExercises = $derived(
		(cleanMergeExerciseSearch
			? mergeExerciseOptions.filter((exercise) =>
					exercise.normalizedName.includes(normalizedMergeExerciseSearch)
				)
			: mergeExerciseOptions
		)
			.filter((exercise) =>
				mergePickerTarget === 'secondary' ? exercise.id !== mainMergeExerciseId : true
			)
			.toSorted(compareMergeExercisePreference)
	);
	let visibleMergePickerExercises = $derived(
		filteredMergePickerExercises.slice(0, cleanMergeExerciseSearch ? 80 : 60)
	);
	let hiddenMergePickerExerciseCount = $derived(
		Math.max(filteredMergePickerExercises.length - visibleMergePickerExercises.length, 0)
	);
	let selectedMergePickerExerciseIdSet = $derived(new Set(selectedMergePickerExerciseIds));
	let disabledMergePickerExerciseIds = $derived(
		new Set(mergePickerTarget === 'secondary' && mainMergeExerciseId ? [mainMergeExerciseId] : [])
	);
	let mergePickerSubmitLabel = $derived(
		mergePickerTarget === 'main' ? 'Use as main exercise' : 'Use as secondary exercise'
	);
	let hasValidMergeExerciseName = $derived(
		!selectedMainMergeOption?.canRename || Boolean(mergeExerciseName.trim())
	);
	let canSubmitExerciseMerge = $derived(
		Boolean(
			api &&
			mainMergeExerciseId &&
			secondaryMergeExerciseId &&
			mainMergeExerciseId !== secondaryMergeExerciseId &&
			hasValidMergeExerciseName &&
			!isDataOperationRunning
		)
	);

	onMount(() => {
		let disposed = false;
		initializeProgressIndicatorPreference();

		void (async () => {
			try {
				const [dbApi, importApi] = await Promise.all([
					import('$lib/db'),
					import('$lib/tracked-import')
				]);

				if (disposed) {
					return;
				}

				api = dbApi;
				trackedImportApi = importApi;
				await dbApi.ensureDbOpen();

				if (!disposed) {
					[stats, mergeOptions] = await Promise.all([
						dbApi.getLocalDatabaseStats(),
						dbApi.listExerciseMergeOptions()
					]);
				}
			} catch (error) {
				if (!disposed) {
					errorMessage = error instanceof Error ? error.message : 'Settings failed to load.';
				}
			} finally {
				if (!disposed) {
					isLoading = false;
				}
			}
		})();

		return () => {
			disposed = true;
		};
	});

	function selectProgressIndicatorPosition(position: ProgressIndicatorPosition) {
		preferenceErrorMessage = saveProgressIndicatorPosition(position)
			? ''
			: 'The preview changed, but this browser could not save the preference.';
	}

	function getPreviewDeltaPositionClass(position: ProgressIndicatorPosition) {
		switch (position) {
			case 'top-left':
				return 'top-1 left-1.5 text-left';
			case 'top-center':
				return 'top-1 left-1/2 -translate-x-1/2 text-center';
			case 'top-right':
				return 'top-1 right-1.5 text-right';
			case 'bottom-center':
				return 'bottom-1 left-1/2 -translate-x-1/2 text-center';
			case 'bottom-right':
				return 'right-1.5 bottom-1 text-right';
			case 'bottom-left':
			default:
				return 'bottom-1 left-1.5 text-left';
		}
	}

	async function uploadLocalDatabase() {
		if (!api || isDataOperationRunning) {
			return;
		}

		const confirmed = window.confirm(
			'Upload this device to cloud? This device wins conflicts. Cloud-only rows are kept.'
		);

		if (!confirmed) {
			return;
		}

		isUploading = true;
		errorMessage = '';
		statusMessage = 'Uploading this device.';

		try {
			try {
				summary = await api.uploadLocalDatabaseToCloud();
				statusMessage = 'Upload finished.';
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Upload failed.';
				statusMessage = '';
				return;
			}

			try {
				stats = await api.getLocalDatabaseStats();
			} catch (error) {
				const refreshError = error instanceof Error ? `: ${error.message}` : '';
				errorMessage = `Upload finished, but database statistics could not be refreshed${refreshError}`;
			}
		} finally {
			isUploading = false;
		}
	}

	function selectMainMergeExercise(nextExerciseId: string) {
		const nextOption = mergeOptions.find((option) => option.exercise.id === nextExerciseId) ?? null;

		mainMergeExerciseId = nextExerciseId;
		mergeExerciseName = nextOption?.exercise.name ?? '';
		mergeResult = null;
		mergeStatusMessage = '';

		if (secondaryMergeExerciseId === nextExerciseId) {
			secondaryMergeExerciseId = '';
		}
	}

	function selectSecondaryMergeExercise(nextExerciseId: string) {
		secondaryMergeExerciseId = nextExerciseId;
		mergeResult = null;
		mergeStatusMessage = '';
	}

	function openMergeExercisePicker(target: 'main' | 'secondary') {
		mergePickerTarget = target;
		mergeExerciseSearch = '';
		selectedMergePickerExerciseIds =
			target === 'main'
				? mainMergeExerciseId
					? [mainMergeExerciseId]
					: []
				: secondaryMergeExerciseId
					? [secondaryMergeExerciseId]
					: [];
	}

	function closeMergeExercisePicker() {
		mergePickerTarget = null;
		mergeExerciseSearch = '';
		selectedMergePickerExerciseIds = [];
	}

	function handleMergeExerciseSearchInput(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		mergeExerciseSearch = target.value;
	}

	function toggleMergePickerExercise(exerciseId: string) {
		if (disabledMergePickerExerciseIds.has(exerciseId)) {
			return;
		}

		selectedMergePickerExerciseIds = selectedMergePickerExerciseIdSet.has(exerciseId)
			? []
			: [exerciseId];
	}

	function applyMergePickerExercise() {
		const selectedExerciseId = selectedMergePickerExerciseIds[0];

		if (!selectedExerciseId || !mergePickerTarget) {
			return;
		}

		if (mergePickerTarget === 'main') {
			selectMainMergeExercise(selectedExerciseId);
		} else {
			selectSecondaryMergeExercise(selectedExerciseId);
		}

		closeMergeExercisePicker();
	}

	async function mergeExercises() {
		if (!api || !canSubmitExerciseMerge) {
			return;
		}

		isMergingExercises = true;
		errorMessage = '';
		mergeStatusMessage = 'Copying secondary history onto the main exercise.';
		mergeResult = null;

		try {
			try {
				mergeResult = await api.mergeExerciseHistory({
					mainExerciseId: mainMergeExerciseId,
					secondaryExerciseId: secondaryMergeExerciseId,
					mainExerciseName: selectedMainMergeOption?.canRename
						? mergeExerciseName.trim()
						: undefined
				});
				mergeExerciseName = mergeResult.mainExercise.name;
				mergeStatusMessage =
					mergeResult.syncStatus === 'synced'
						? 'Exercise history merge finished and synced.'
						: 'Exercise history merge finished locally. Sync failed.';
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Exercise merge failed.';
				mergeStatusMessage = '';
				return;
			}

			try {
				[stats, mergeOptions] = await Promise.all([
					api.getLocalDatabaseStats(),
					api.listExerciseMergeOptions()
				]);
			} catch (error) {
				const refreshError = error instanceof Error ? `: ${error.message}` : '';
				errorMessage = `Exercise history was merged, but settings data could not be refreshed${refreshError}`;
			}
		} finally {
			isMergingExercises = false;
		}
	}

	async function onTrackedFileChange(event: Event) {
		if (!trackedImportApi || isPreviewingTracked || isDataOperationRunning) {
			return;
		}

		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0] ?? null;

		trackedFile = file;
		trackedSummary = null;
		errorMessage = '';
		statusMessage = '';

		if (!file) {
			return;
		}

		isPreviewingTracked = true;
		statusMessage = 'Reading Tracked export.';

		try {
			trackedSummary = await trackedImportApi.previewTrackedArchive(file);
			trackedLimbPriorities = Object.fromEntries(
				trackedSummary.exerciseLimbPriorities.map((exercise) => [
					exercise.normalizedName,
					exercise.limbPriority
				])
			);
			statusMessage = 'Tracked export is ready to import.';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Tracked export could not be read.';
			statusMessage = '';
			trackedFile = null;
			input.value = '';
		} finally {
			isPreviewingTracked = false;
		}
	}

	async function importTrackedFile() {
		if (!trackedImportApi || !trackedFile || isDataOperationRunning) {
			return;
		}

		isImportingTracked = true;
		trackedImportPhase = 'reading';
		errorMessage = '';
		statusMessage = 'Importing Tracked workouts.';

		try {
			try {
				trackedSummary = await trackedImportApi.importTrackedArchive(trackedFile, {
					limbPriorities: trackedLimbPriorities,
					onProgress: (phase) => {
						trackedImportPhase = phase;
					}
				});
				statusMessage =
					trackedSummary.syncStatus === 'synced'
						? 'Tracked import finished and synced.'
						: 'Tracked import finished locally. Sync failed.';
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Tracked import failed.';
				statusMessage = '';
				return;
			}

			if (api) {
				try {
					stats = await api.getLocalDatabaseStats();
				} catch (error) {
					const refreshError = error instanceof Error ? `: ${error.message}` : '';
					errorMessage = `Tracked import finished, but database statistics could not be refreshed${refreshError}`;
				}
			}
		} finally {
			isImportingTracked = false;
		}
	}

	function formatNumber(value: number) {
		return new Intl.NumberFormat().format(value);
	}

	function formatLastWorkout(value?: string) {
		if (!value) {
			return 'None';
		}

		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		}).format(new Date(value));
	}

	function compareOptionalRecency(first?: string, second?: string) {
		if (first && second && first !== second) {
			return second.localeCompare(first);
		}

		if (first && !second) {
			return -1;
		}

		if (!first && second) {
			return 1;
		}

		return 0;
	}

	function formatExerciseMergeMetadata(exercise: Exercise) {
		const option = mergeOptionByExerciseId.get(exercise.id);

		if (!option) {
			return '';
		}

		const lastPerformedLabel = option.lastPerformedAt
			? `last ${formatLastWorkout(option.lastPerformedAt)}`
			: 'no history';

		return `${formatNumber(option.historyCount)} session${
			option.historyCount === 1 ? '' : 's'
		}, ${lastPerformedLabel}`;
	}

	function compareMergeExercisePreference(first: Exercise, second: Exercise) {
		const firstOption = mergeOptionByExerciseId.get(first.id);
		const secondOption = mergeOptionByExerciseId.get(second.id);

		return (
			compareOptionalRecency(firstOption?.lastPerformedAt, secondOption?.lastPerformedAt) ||
			(secondOption?.historyCount ?? 0) - (firstOption?.historyCount ?? 0) ||
			first.name.localeCompare(second.name)
		);
	}

	function getMergePickerExercisePosition(exerciseId: string) {
		return selectedMergePickerExerciseIdSet.has(exerciseId) ? 1 : null;
	}

	function formatFileList(files: string[]) {
		return files.length > 0 ? files.join(', ') : 'None';
	}

	function formatTrackedImportPhase(phase: TrackedImportPhase) {
		switch (phase) {
			case 'reading':
				return 'Reading Tracked zip';
			case 'planning':
				return 'Checking CSVs and matching exercises';
			case 'writing':
				return 'Writing workouts locally';
			case 'syncing':
				return 'Syncing imported data to cloud';
		}
	}

	function setTrackedExerciseLimbPriority(
		normalizedName: string,
		limbPriority: TrackedLimbPriority
	) {
		trackedLimbPriorities = {
			...trackedLimbPriorities,
			[normalizedName]: limbPriority
		};
	}
</script>

<svelte:head>
	<title>Settings | TinyTrain</title>
</svelte:head>

{#if isImportingTracked}
	<div
		class="fixed inset-0 z-50 grid place-items-center bg-zinc-950/85 px-5 backdrop-blur-md"
		role="dialog"
		aria-modal="true"
		aria-labelledby="tracked-import-title"
	>
		<div
			class="grid w-full max-w-sm gap-5 rounded-2xl border border-sky-200/20 bg-zinc-950 p-6 text-center shadow-2xl shadow-sky-950/30"
		>
			<div
				class="mx-auto grid h-16 w-16 place-items-center rounded-full border border-sky-200/25 bg-sky-300/10 text-sky-100"
			>
				<Icon name="loader-circle" class="h-8 w-8 animate-spin" />
			</div>
			<div class="grid gap-2">
				<p id="tracked-import-title" class="text-xl font-semibold text-white">
					{formatTrackedImportPhase(trackedImportPhase)}
				</p>
				<p class="text-sm leading-6 text-zinc-300">
					Keep this page open. Large Tracked exports can take a few minutes because TinyTrain is
					merging the local database and then pushing the new rows to Supabase.
				</p>
			</div>
			<div class="h-1.5 overflow-hidden rounded-full bg-white/10">
				<div class="h-full w-1/2 animate-pulse rounded-full bg-sky-300"></div>
			</div>
		</div>
	</div>
{/if}

<section class="flex flex-1 flex-col gap-5 px-1 pb-6">
	<div class="flex items-start gap-4 pt-3">
		<div
			class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
		>
			<Icon name="settings" class="h-5 w-5" />
		</div>
		<div class="min-w-0">
			<p class="text-sm font-medium tracking-[0.18em] text-zinc-500 uppercase">TinyTrain</p>
			<h1 class="mt-1 text-3xl font-semibold text-white">Settings</h1>
		</div>
	</div>

	{#if errorMessage}
		<p
			class="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
			role="alert"
		>
			{errorMessage}
		</p>
	{/if}

	<section class="grid gap-4 rounded-lg border border-white/10 bg-white/[0.04] p-4">
		<div class="flex items-start gap-3">
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
			>
				<Icon name="sparkles" class="h-5 w-5" />
			</div>
			<div class="min-w-0">
				<p class="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">Appearance</p>
				<h2 class="mt-1 text-lg font-semibold text-white">Workout inputs</h2>
				<p class="mt-1 text-sm leading-5 text-zinc-400">
					Choose where changes from your previous session appear inside Weight, Reps, and RIR.
				</p>
			</div>
		</div>

		<fieldset class="grid gap-3">
			<legend class="text-sm font-semibold text-white">Comparison indicator position</legend>
			<p class="text-xs font-medium text-emerald-200">
				Current: {PROGRESS_INDICATOR_POSITIONS.find(
					(position) => position.value === selectedProgressIndicatorPosition
				)?.label ?? 'Bottom left'}
			</p>

			<div class="grid grid-cols-3 gap-2">
				{#each PROGRESS_INDICATOR_POSITIONS as position (position.value)}
					<label class="relative min-w-0 cursor-pointer">
						<input
							class="peer sr-only"
							type="radio"
							name="progress-indicator-position"
							value={position.value}
							checked={selectedProgressIndicatorPosition === position.value}
							onchange={() => selectProgressIndicatorPosition(position.value)}
						/>
						<span
							class={`grid min-h-24 gap-2 rounded-lg border p-2 transition peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-200 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#080b0d] ${
								selectedProgressIndicatorPosition === position.value
									? 'border-emerald-300/60 bg-emerald-300/10'
									: 'border-white/10 bg-black/20 hover:border-white/20'
							}`}
						>
							<span class="flex min-h-8 min-w-0 items-start justify-between gap-1">
								<span class="text-[10px] leading-4 font-semibold text-zinc-200">
									{position.label}
								</span>
								{#if selectedProgressIndicatorPosition === position.value}
									<span
										class="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-300 text-zinc-950"
									>
										<Icon name="check" class="h-2.5 w-2.5" />
									</span>
								{/if}
							</span>
							<span
								class="relative block h-11 min-w-0 overflow-hidden rounded-md border-2 border-emerald-500 bg-white text-black"
								aria-hidden="true"
							>
								<strong
									class="absolute inset-0 grid place-items-center text-base font-bold tabular-nums"
								>
									10
								</strong>
								<span
									class={`absolute z-10 max-w-[calc(100%-0.75rem)] overflow-hidden text-[9px] leading-none font-bold text-ellipsis whitespace-nowrap text-emerald-700 tabular-nums ${getPreviewDeltaPositionClass(position.value)}`}
								>
									+2
								</span>
							</span>
						</span>
					</label>
				{/each}
			</div>
		</fieldset>

		<p class="text-xs leading-5 text-zinc-500">
			Saved automatically on this device. Default: Bottom left.
		</p>
		{#if preferenceErrorMessage}
			<p class="text-xs leading-5 text-red-200" role="alert">{preferenceErrorMessage}</p>
		{/if}
	</section>

	<div class="flex items-center gap-3 pt-1">
		<div
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-zinc-300"
		>
			<Icon name="database" class="h-4 w-4" />
		</div>
		<div>
			<p class="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">Data and sync</p>
			<h2 class="mt-0.5 text-xl font-semibold text-white">Database</h2>
		</div>
	</div>

	{#if isLoading}
		<section class="flex flex-1 flex-col justify-center">
			<div class="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
				<div class="h-full w-1/2 animate-pulse rounded-full bg-emerald-300"></div>
			</div>
			<h2 class="mt-5 text-2xl font-semibold text-white">Loading</h2>
		</section>
	{:else}
		<section class="grid gap-3">
			<div class="grid grid-cols-2 gap-3">
				<div class="rounded-lg border border-white/10 bg-white/[0.04] p-4">
					<p class="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">
						Previous workouts
					</p>
					<p class="mt-3 text-3xl font-semibold text-white">
						{formatNumber(stats?.previousWorkouts ?? 0)}
					</p>
				</div>
				<div class="rounded-lg border border-white/10 bg-white/[0.04] p-4">
					<p class="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">Filled sets</p>
					<p class="mt-3 text-3xl font-semibold text-white">
						{formatNumber(stats?.filledSessionSets ?? 0)}
					</p>
				</div>
			</div>

			<div class="rounded-lg border border-white/10 bg-white/[0.04] p-4">
				<dl class="grid gap-3 text-sm">
					<div class="flex items-center justify-between gap-4">
						<dt class="text-zinc-400">Splits</dt>
						<dd class="font-semibold text-white">{formatNumber(stats?.workouts ?? 0)}</dd>
					</div>
					<div class="flex items-center justify-between gap-4">
						<dt class="text-zinc-400">Completed workouts</dt>
						<dd class="font-semibold text-white">
							{formatNumber(stats?.previousWorkouts ?? 0)}
						</dd>
					</div>
					<div class="flex items-center justify-between gap-4">
						<dt class="text-zinc-400">Custom exercises</dt>
						<dd class="font-semibold text-white">{formatNumber(stats?.customExercises ?? 0)}</dd>
					</div>
					<div class="flex items-center justify-between gap-4">
						<dt class="text-zinc-400">Session exercises</dt>
						<dd class="font-semibold text-white">
							{formatNumber(stats?.sessionExercises ?? 0)}
						</dd>
					</div>
					<div class="flex items-center justify-between gap-4">
						<dt class="text-zinc-400">Session sets</dt>
						<dd class="font-semibold text-white">{formatNumber(stats?.sessionSets ?? 0)}</dd>
					</div>
					<div class="flex items-center justify-between gap-4">
						<dt class="text-zinc-400">Last workout</dt>
						<dd class="font-semibold text-white">{formatLastWorkout(stats?.lastWorkoutAt)}</dd>
					</div>
				</dl>
			</div>
		</section>

		<section
			class="grid min-w-0 gap-3 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] p-4"
		>
			<div class="flex items-start gap-3">
				<div
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
				>
					<Icon name="history" class="h-5 w-5" />
				</div>
				<div class="min-w-0">
					<p class="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">
						Merge exercises
					</p>
					<p class="mt-1 max-w-full text-sm leading-5 break-words text-zinc-300">
						Copy history from one exercise onto a main exercise. Original rows stay unchanged, and
						existing main history wins conflicts.
					</p>
				</div>
			</div>

			<div class="grid min-w-0 gap-3">
				<div class="grid min-w-0 gap-2 text-sm font-semibold text-white">
					Main exercise
					<button
						class="flex min-h-[3.25rem] w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-white/10 bg-zinc-950 px-3 py-2 text-left text-sm font-medium text-zinc-200"
						type="button"
						disabled={!api || isDataOperationRunning || mergeOptions.length < 2}
						onclick={() => openMergeExercisePicker('main')}
					>
						<span class="min-w-0 flex-1">
							<span class="block truncate">
								{selectedMainMergeOption?.exercise.name ?? 'Select main exercise'}
							</span>
							{#if selectedMainMergeOption}
								<span class="mt-1 block truncate text-xs text-zinc-500">
									{formatExerciseMergeMetadata(selectedMainMergeOption.exercise)}
								</span>
							{/if}
						</span>
						<Icon name="chevron-right" class="h-4 w-4 shrink-0 text-zinc-500" />
					</button>
				</div>

				<div class="grid min-w-0 gap-2 text-sm font-semibold text-white">
					Secondary exercise
					<button
						class="flex min-h-[3.25rem] w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-white/10 bg-zinc-950 px-3 py-2 text-left text-sm font-medium text-zinc-200"
						type="button"
						disabled={!api || isDataOperationRunning || !mainMergeExerciseId}
						onclick={() => openMergeExercisePicker('secondary')}
					>
						<span class="min-w-0 flex-1">
							<span class="block truncate">
								{selectedSecondaryMergeOption?.exercise.name ?? 'Select secondary exercise'}
							</span>
							{#if selectedSecondaryMergeOption}
								<span class="mt-1 block truncate text-xs text-zinc-500">
									{formatExerciseMergeMetadata(selectedSecondaryMergeOption.exercise)}
								</span>
							{/if}
						</span>
						<Icon name="chevron-right" class="h-4 w-4 shrink-0 text-zinc-500" />
					</button>
				</div>

				{#if selectedMainMergeOption}
					<label class="grid min-w-0 gap-2 text-sm font-semibold text-white">
						Main exercise name
						<input
							class="min-h-[3.25rem] w-full min-w-0 rounded-lg border border-white/10 bg-zinc-950 px-3 text-sm font-medium text-zinc-200 disabled:text-zinc-500"
							type="text"
							disabled={!selectedMainMergeOption.canRename || isDataOperationRunning}
							required={selectedMainMergeOption.canRename}
							minlength="1"
							bind:value={mergeExerciseName}
						/>
					</label>

					{#if !selectedMainMergeOption.canRename}
						<p class="text-xs leading-5 text-zinc-500">
							Built-in exercise names cannot be renamed here.
						</p>
					{/if}
				{/if}

				{#if selectedMainMergeOption && selectedSecondaryMergeOption}
					<div class="grid min-w-0 gap-2 rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
						<div class="flex items-center justify-between gap-3">
							<span class="text-zinc-400">Main keeps</span>
							<span class="min-w-0 text-right font-semibold break-words text-white">
								{selectedMainMergeOption.exercise.name}
							</span>
						</div>
						<div class="flex items-center justify-between gap-3">
							<span class="text-zinc-400">Copy from</span>
							<span class="min-w-0 text-right font-semibold break-words text-white">
								{selectedSecondaryMergeOption.exercise.name}
							</span>
						</div>
					</div>
				{/if}

				<button
					class="flex min-h-[3.25rem] w-full min-w-0 items-center justify-center gap-3 rounded-lg bg-emerald-300 px-4 text-base font-bold whitespace-normal text-zinc-950 transition disabled:bg-zinc-700 disabled:text-zinc-400"
					type="button"
					disabled={!canSubmitExerciseMerge}
					onclick={mergeExercises}
				>
					{#if isMergingExercises}
						<Icon name="loader-circle" class="h-5 w-5 animate-spin" />
						Merging
					{:else}
						<Icon name="history" class="h-5 w-5" />
						Merge exercise history
					{/if}
				</button>
			</div>

			{#if mergeStatusMessage}
				<p class="text-center text-sm font-medium text-emerald-100">{mergeStatusMessage}</p>
			{/if}

			{#if mergeResult}
				<div class="grid gap-2 rounded-lg border border-white/10 bg-black/20 p-3">
					<dl class="grid grid-cols-2 gap-3 text-sm">
						<div>
							<dt class="text-zinc-500">Copied exercises</dt>
							<dd class="font-semibold text-white">
								{formatNumber(mergeResult.copiedSessionExercises)}
							</dd>
						</div>
						<div>
							<dt class="text-zinc-500">Copied sets</dt>
							<dd class="font-semibold text-white">
								{formatNumber(mergeResult.copiedSessionSets)}
							</dd>
						</div>
						<div>
							<dt class="text-zinc-500">Main conflicts</dt>
							<dd class="font-semibold text-white">
								{formatNumber(mergeResult.skippedConflicts)}
							</dd>
						</div>
						<div>
							<dt class="text-zinc-500">Rename</dt>
							<dd class="font-semibold text-white">
								{mergeResult.renamed ? 'Updated' : 'Unchanged'}
							</dd>
						</div>
					</dl>

					{#if mergeResult.syncStatus === 'failed'}
						<p class="text-xs leading-5 text-red-100">Sync failed: {mergeResult.syncError}</p>
					{/if}
				</div>
			{/if}
		</section>

		<section class="grid gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-4">
			<div class="flex items-start gap-3">
				<div
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-sky-300/25 bg-sky-300/10 text-sky-100"
				>
					<Icon name="download" class="h-5 w-5" />
				</div>
				<div class="min-w-0">
					<p class="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">
						Import from Tracked
					</p>
					<p class="mt-1 text-sm leading-5 text-zinc-300">
						Upload the Tracked zip export. TinyTrain imports workout history, merges matching
						exercises, ignores unsupported data, and syncs after import.
					</p>
				</div>
			</div>

			<label class="grid gap-2 text-sm font-semibold text-white">
				Tracked zip file
				<input
					class="rounded-lg border border-white/10 bg-zinc-950 px-3 py-3 text-sm font-medium text-zinc-200 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-sm file:font-bold file:text-white"
					type="file"
					accept=".zip,application/zip"
					disabled={!trackedImportApi || isPreviewingTracked || isDataOperationRunning}
					onchange={onTrackedFileChange}
				/>
			</label>

			{#if isPreviewingTracked}
				<p class="text-sm font-medium text-sky-100">Reading zip and validating CSVs.</p>
			{/if}

			{#if trackedSummary}
				<div class="grid gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
					<dl class="grid grid-cols-2 gap-3 text-sm">
						<div>
							<dt class="text-zinc-500">Sessions</dt>
							<dd class="font-semibold text-white">
								{formatNumber(trackedSummary.sessionsImportable)} / {formatNumber(
									trackedSummary.sessionsFound
								)}
							</dd>
						</div>
						<div>
							<dt class="text-zinc-500">Strength rows</dt>
							<dd class="font-semibold text-white">
								{formatNumber(trackedSummary.strengthSetRowsImportable)} / {formatNumber(
									trackedSummary.strengthSetRowsFound
								)}
							</dd>
						</div>
						<div>
							<dt class="text-zinc-500">Exercises merge</dt>
							<dd class="font-semibold text-white">
								{formatNumber(trackedSummary.exercisesMatched)} matched,
								{formatNumber(trackedSummary.exercisesCreated)} new
							</dd>
						</div>
						<div>
							<dt class="text-zinc-500">Workouts</dt>
							<dd class="font-semibold text-white">
								{formatNumber(trackedSummary.workoutsMatched)} matched,
								{formatNumber(trackedSummary.workoutsCreated)} new
							</dd>
						</div>
					</dl>

					<p class="text-xs leading-5 text-zinc-400">
						Required CSVs: {formatFileList(trackedSummary.requiredFilesPresent)}. Optional CSVs: {formatFileList(
							trackedSummary.optionalFilesPresent
						)}.
					</p>
					<p class="text-xs leading-5 text-zinc-400">
						Ignored files: {formatFileList(trackedSummary.ignoredFiles)}.
					</p>
					<p class="text-xs leading-5 text-zinc-400">
						Unsupported data not imported: {trackedSummary.unsupportedCategories.join(', ')}.
					</p>

					{#if trackedSummary.exerciseLimbPriorities.length > 0}
						<div class="grid gap-2 rounded-lg border border-sky-300/15 bg-sky-300/[0.06] p-3">
							<div>
								<p class="text-sm font-semibold text-white">Side mapping for Tracked limb data</p>
								<p class="mt-1 text-xs leading-5 text-zinc-400">
									Tracked does not export which side primary means. Default assumes primary is
									right. Flip only the exercises where primary should import as left.
								</p>
							</div>

							<div class="grid max-h-72 gap-2 overflow-y-auto pr-1">
								{#each trackedSummary.exerciseLimbPriorities as exercise (exercise.normalizedName)}
									<div class="grid gap-2 rounded-lg border border-white/10 bg-black/20 p-3">
										<div class="flex items-start justify-between gap-3">
											<p class="text-sm font-semibold text-white">{exercise.name}</p>
											<p class="shrink-0 text-xs text-zinc-500">
												{formatNumber(exercise.setsWithSecondaryValues)} sided sets
											</p>
										</div>
										<div class="grid grid-cols-2 gap-2 text-xs font-semibold">
											<button
												class={`rounded-md px-3 py-2 transition ${
													(trackedLimbPriorities[exercise.normalizedName] ?? 'primary-right') ===
													'primary-right'
														? 'bg-sky-300 text-zinc-950'
														: 'bg-white/10 text-zinc-300'
												}`}
												type="button"
												disabled={isImportingTracked}
												onclick={() =>
													setTrackedExerciseLimbPriority(exercise.normalizedName, 'primary-right')}
											>
												Primary = right
											</button>
											<button
												class={`rounded-md px-3 py-2 transition ${
													trackedLimbPriorities[exercise.normalizedName] === 'primary-left'
														? 'bg-sky-300 text-zinc-950'
														: 'bg-white/10 text-zinc-300'
												}`}
												type="button"
												disabled={isImportingTracked}
												onclick={() =>
													setTrackedExerciseLimbPriority(exercise.normalizedName, 'primary-left')}
											>
												Primary = left
											</button>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if trackedSummary.warnings.length > 0}
						<ul class="grid gap-1 text-xs leading-5 text-amber-100">
							{#each trackedSummary.warnings as warning (warning)}
								<li>{warning}</li>
							{/each}
						</ul>
					{/if}

					{#if trackedSummary.sessionsImported > 0 || trackedSummary.sessionsSkipped > 0}
						<p class="text-xs leading-5 text-emerald-100">
							Imported {formatNumber(trackedSummary.sessionsImported)} sessions and
							{formatNumber(trackedSummary.sessionSetsImported)} set rows. Skipped
							{formatNumber(trackedSummary.sessionsSkipped)} existing sessions.
						</p>
					{/if}

					{#if trackedSummary.syncStatus === 'failed'}
						<p class="text-xs leading-5 text-red-100">
							Sync failed: {trackedSummary.syncError}
						</p>
					{/if}
				</div>
			{/if}

			<button
				class="flex min-h-[3.25rem] items-center justify-center gap-3 rounded-lg bg-sky-300 px-4 text-base font-bold text-zinc-950 transition disabled:bg-zinc-700 disabled:text-zinc-400"
				type="button"
				disabled={!trackedImportApi ||
					!trackedFile ||
					isPreviewingTracked ||
					isDataOperationRunning}
				onclick={importTrackedFile}
			>
				{#if isImportingTracked}
					<Icon name="loader-circle" class="h-5 w-5 animate-spin" />
					Importing
				{:else}
					<Icon name="download" class="h-5 w-5" />
					Import Tracked zip
				{/if}
			</button>
		</section>

		<section class="mt-auto grid gap-3 border-t border-white/10 pt-5">
			<div
				class="flex items-start gap-3 rounded-lg border border-amber-300/20 bg-amber-300/[0.08] p-4"
			>
				<Icon name="shield-alert" class="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
				<p class="text-sm leading-5 text-amber-50/90">
					Use this on the device with the correct workout history. Local rows win conflicts.
				</p>
			</div>

			<button
				class="flex min-h-[3.25rem] items-center justify-center gap-3 rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 transition disabled:bg-zinc-700 disabled:text-zinc-400"
				type="button"
				disabled={!api || isDataOperationRunning}
				onclick={uploadLocalDatabase}
			>
				{#if isUploading}
					<Icon name="loader-circle" class="h-5 w-5 animate-spin" />
					Uploading
				{:else}
					<Icon name="upload-cloud" class="h-5 w-5" />
					Upload this device
				{/if}
			</button>

			{#if statusMessage}
				<p class="text-center text-sm font-medium text-emerald-100">{statusMessage}</p>
			{/if}

			{#if summary}
				<p class="text-center text-xs leading-5 text-zinc-400">
					Uploaded {formatNumber(summary.uploadedRows)} rows. Local kept {formatNumber(
						summary.localWins
					)} rows.
				</p>
			{/if}
		</section>
	{/if}
</section>

{#if mergePickerTarget}
	<ExercisePickerSheet
		exerciseSearch={mergeExerciseSearch}
		newExerciseName=""
		isNewExerciseUnilateral={false}
		visiblePickerExercises={visibleMergePickerExercises}
		hiddenPickerExerciseCount={hiddenMergePickerExerciseCount}
		selectedPickerExerciseIdSet={selectedMergePickerExerciseIdSet}
		selectedExerciseIds={disabledMergePickerExerciseIds}
		addSelectedLabel={mergePickerSubmitLabel}
		submitDisabled={selectedMergePickerExerciseIds.length !== 1}
		canCreateCustomExercise={false}
		isSaving={isDataOperationRunning}
		sheetEyebrow={mergePickerTarget === 'main' ? 'Main exercise' : 'Secondary exercise'}
		sheetTitle={mergePickerTarget === 'main' ? 'Pick the head exercise' : 'Pick history to copy'}
		onClose={closeMergeExercisePicker}
		onExerciseSearchInput={handleMergeExerciseSearchInput}
		onCustomExerciseNameInput={() => {}}
		onTogglePickerExercise={toggleMergePickerExercise}
		onToggleUnilateral={() => {}}
		onCreateExercise={(event) => event.preventDefault()}
		onAddSelected={applyMergePickerExercise}
		isPreviouslyUsedExercise={(exercise) =>
			(mergeOptionByExerciseId.get(exercise.id)?.historyCount ?? 0) > 0}
		getPickerExercisePosition={getMergePickerExercisePosition}
		getExerciseMetadata={formatExerciseMergeMetadata}
	/>
{/if}
