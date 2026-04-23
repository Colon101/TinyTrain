<script lang="ts">
	import { onMount } from 'svelte';
	import type { ExerciseDetail, ExerciseListItem } from '$lib/db';
	import {
		formatDayHeading,
		formatHistoryCount,
		formatSetLine,
		formatSessionStatus
	} from '$lib/features/sessions/session-format';
	import Icon from '$lib/ui/Icon.svelte';

	type DatabaseApi = typeof import('$lib/db');
	type DetailTab = 'summary' | 'history';

	let api = $state<DatabaseApi | null>(null);
	let items = $state<ExerciseListItem[]>([]);
	let selectedDetail = $state<ExerciseDetail | null>(null);
	let detailTab = $state<DetailTab>('summary');
	let draftName = $state('');
	let draftUnilateral = $state(false);
	let isLoading = $state(true);
	let isSaving = $state(false);
	let errorMessage = $state('');

	onMount(() => {
		let disposed = false;

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (disposed) {
					return;
				}

				api = dbApi;
				await loadItems();
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
				isLoading = false;
			}
		})();

		return () => {
			disposed = true;
		};
	});

	async function loadItems() {
		if (!api) {
			return;
		}

		isLoading = true;
		items = await api.listCustomExerciseItems();
		isLoading = false;
	}

	async function openExercise(exerciseId: string) {
		if (!api) {
			return;
		}

		errorMessage = '';
		selectedDetail = await api.getExerciseDetail(exerciseId);
		detailTab = 'summary';
	}

	async function handleCreateExercise(event: SubmitEvent) {
		event.preventDefault();

		if (!api) {
			return;
		}

		isSaving = true;
		errorMessage = '';

		try {
			const exercise = await api.createCustomExercise(draftName, draftUnilateral);
			draftName = '';
			draftUnilateral = false;
			await loadItems();
			await openExercise(exercise.id);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
		} finally {
			isSaving = false;
		}
	}

	async function toggleUnilateral(nextValue: boolean) {
		if (!api || !selectedDetail || selectedDetail.exercise.unilateral === nextValue) {
			return;
		}

		isSaving = true;
		errorMessage = '';

		try {
			await api.setExerciseUnilateral(selectedDetail.exercise.id, nextValue);
			selectedDetail = await api.getExerciseDetail(selectedDetail.exercise.id);
			await loadItems();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
		} finally {
			isSaving = false;
		}
	}

	async function resetExerciseForm() {
		if (!api || !selectedDetail) {
			return;
		}

		isSaving = true;
		errorMessage = '';

		try {
			await api.recordExerciseReset(selectedDetail.exercise.id);
			selectedDetail = await api.getExerciseDetail(selectedDetail.exercise.id);
			await loadItems();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
		} finally {
			isSaving = false;
		}
	}
</script>

<section class="flex flex-1 flex-col">
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
			<h1 class="mt-5 text-2xl font-semibold text-white">Loading exercises</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">Collecting your custom exercise library.</p>
		</section>
	{:else if selectedDetail}
		<div class="pb-5">
			<button
				class="flex min-h-10 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-medium text-zinc-300"
				type="button"
				onclick={() => (selectedDetail = null)}
			>
				<Icon name="arrow-left" class="h-4 w-4" />
				Back
			</button>
			<h1 class="mt-4 text-3xl font-semibold text-white">{selectedDetail.exercise.name}</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				Manage how this custom movement behaves in the tracker.
			</p>
		</div>

		<section class="border-y border-white/10 py-5">
			<div class="flex items-center justify-between gap-3">
				<div>
					<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Mode</p>
					<h2 class="mt-2 text-xl font-semibold text-white">
						{selectedDetail.exercise.unilateral ? 'Unilateral' : 'Bilateral'}
					</h2>
				</div>

				<button
					class="flex min-h-11 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-semibold text-zinc-200"
					type="button"
					disabled={isSaving}
					onclick={resetExerciseForm}
				>
					<Icon name="rotate-ccw" class="h-4 w-4" />
					Reset form
				</button>
			</div>

			<div class="mt-4 grid grid-cols-2 gap-2">
				<button
					class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
						!selectedDetail.exercise.unilateral
							? 'bg-emerald-300 text-zinc-950'
							: 'border border-white/10 text-zinc-300'
					}`}
					type="button"
					onclick={() => toggleUnilateral(false)}
				>
					Bilateral
				</button>
				<button
					class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
						selectedDetail.exercise.unilateral
							? 'bg-emerald-300 text-zinc-950'
							: 'border border-white/10 text-zinc-300'
					}`}
					type="button"
					onclick={() => toggleUnilateral(true)}
				>
					Unilateral
				</button>
			</div>
		</section>

		<div class="mt-5 grid grid-cols-2 gap-2">
			<button
				class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
					detailTab === 'summary'
						? 'bg-white text-zinc-950'
						: 'border border-white/10 bg-white/[0.03] text-zinc-300'
				}`}
				type="button"
				onclick={() => (detailTab = 'summary')}
			>
				Summary
			</button>
			<button
				class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
					detailTab === 'history'
						? 'bg-white text-zinc-950'
						: 'border border-white/10 bg-white/[0.03] text-zinc-300'
				}`}
				type="button"
				onclick={() => (detailTab = 'history')}
			>
				History
			</button>
		</div>

		{#if detailTab === 'summary'}
			<section class="mt-5 border-y border-white/10 py-5">
				<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
					Reset events
				</p>
				{#if selectedDetail.resetEvents.length > 0}
					<div class="mt-4 grid gap-3">
						{#each selectedDetail.resetEvents as resetEvent}
							<div class="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
								<p class="text-sm font-medium text-white">Form reset recorded</p>
								<p class="mt-1 text-sm text-zinc-400">
									{new Date(resetEvent.resetAt).toLocaleString()}
								</p>
							</div>
						{/each}
					</div>
				{:else}
					<p class="mt-4 text-sm leading-6 text-zinc-400">No reset events recorded yet.</p>
				{/if}
			</section>
		{:else}
			<section class="mt-5 border-y border-white/10 py-5">
				<p
					class="flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase"
				>
					<Icon name="history" class="h-4 w-4" />
					History
				</p>

				{#if selectedDetail.history.length > 0}
					<div class="mt-4 grid gap-3">
						{#each selectedDetail.history as entry}
							<a
								class="block rounded-lg border border-white/10 bg-white/[0.03] px-4 py-4 transition hover:border-emerald-300/50"
								href={`/sessions/${entry.sessionId}`}
							>
								<div class="flex items-start justify-between gap-3">
									<div>
										<p class="text-sm font-semibold text-white">{entry.workoutNameSnapshot}</p>
										<p class="mt-1 text-sm text-zinc-400">{formatDayHeading(entry.dayKey)}</p>
									</div>
									<span class="text-xs font-medium text-zinc-400">
										{formatSessionStatus(entry.status)}
									</span>
								</div>

								<div class="mt-3 flex flex-wrap gap-2">
									{#each entry.sets as set}
										<span
											class="rounded-full bg-white/[0.06] px-3 py-1 text-xs font-medium text-zinc-200"
										>
											{formatSetLine(set.weight, set.reps)}
										</span>
									{/each}
								</div>
							</a>
						{/each}
					</div>
				{:else}
					<p class="mt-4 text-sm leading-6 text-zinc-400">No history for this exercise yet.</p>
				{/if}
			</section>
		{/if}
	{:else}
		<div class="pb-5">
			<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">TinyTrain</p>
			<h1 class="mt-2 text-3xl font-semibold text-white">Exercises</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				Manage your custom movements without mixing them into the built-in library.
			</p>
		</div>

		<form class="border-y border-white/10 py-5" onsubmit={handleCreateExercise}>
			<label class="block" for="custom-exercise-name">
				<span class="mb-2 block text-sm font-medium text-zinc-300">Add custom exercise</span>
				<input
					id="custom-exercise-name"
					class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-emerald-300/60"
					bind:value={draftName}
					autocomplete="off"
					placeholder="Cable squeeze row, ring curl..."
				/>
			</label>

			<div class="mt-3 grid grid-cols-2 gap-2">
				<button
					class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
						!draftUnilateral
							? 'bg-emerald-300 text-zinc-950'
							: 'border border-white/10 text-zinc-300'
					}`}
					type="button"
					onclick={() => (draftUnilateral = false)}
				>
					Bilateral
				</button>
				<button
					class={`min-h-11 rounded-lg px-3 text-sm font-semibold ${
						draftUnilateral
							? 'bg-emerald-300 text-zinc-950'
							: 'border border-white/10 text-zinc-300'
					}`}
					type="button"
					onclick={() => (draftUnilateral = true)}
				>
					Unilateral
				</button>
			</div>

			<button
				class="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
				type="submit"
				disabled={isSaving || !draftName.trim()}
			>
				<Icon name="sparkles" class="h-4 w-4" />
				Create custom exercise
			</button>
		</form>

		<section class="py-5">
			<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
				Custom library
			</p>
			{#if items.length > 0}
				<div class="mt-4 grid gap-3">
					{#each items as item}
						<button
							class="flex min-h-16 items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-4 text-left transition hover:border-emerald-300/50"
							type="button"
							onclick={() => openExercise(item.exercise.id)}
						>
							<div class="min-w-0">
								<p class="truncate text-base font-semibold text-white">{item.exercise.name}</p>
								<p class="mt-1 text-sm text-zinc-400">
									{item.exercise.unilateral ? 'Unilateral' : 'Bilateral'} · {formatHistoryCount(
										item.historyCount
									)}
								</p>
							</div>
							<Icon name="arrow-right" class="h-4 w-4 shrink-0 text-zinc-500" />
						</button>
					{/each}
				</div>
			{:else}
				<div
					class="mt-4 rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-zinc-400"
				>
					You have not created any custom exercises yet.
				</div>
			{/if}
		</section>
	{/if}
</section>
