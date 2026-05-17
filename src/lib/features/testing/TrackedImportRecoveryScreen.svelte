<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import type {
		TrackedImportRecoveryPreview,
		TrackedImportRecoveryResult
	} from '$lib/tracked-import';

	type RecoveryApi = typeof import('$lib/tracked-import');

	let api = $state<RecoveryApi | null>(null);
	let selectedFile = $state<File | null>(null);
	let preview = $state<TrackedImportRecoveryPreview | null>(null);
	let result = $state<TrackedImportRecoveryResult | null>(null);
	let isLoading = $state(true);
	let isPreviewing = $state(false);
	let isApplying = $state(false);
	let errorMessage = $state('');

	let repairableRows = $derived(
		(preview?.repairableSessions ?? 0) +
			(preview?.repairableSessionExercises ?? 0) +
			(preview?.repairableSessionSets ?? 0)
	);
	let canPreview = $derived(Boolean(api && selectedFile && !isPreviewing && !isApplying));
	let canApply = $derived(
		Boolean(api && selectedFile && preview && repairableRows > 0 && !isApplying)
	);

	onMount(() => {
		let disposed = false;

		void (async () => {
			try {
				const recoveryApi = await import('$lib/tracked-import');

				if (disposed) {
					return;
				}

				api = recoveryApi;
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
			throw new Error('The recovery utility is still loading.');
		}

		return api;
	}

	function handleFileChange(event: Event) {
		selectedFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
		preview = null;
		result = null;
		errorMessage = '';
	}

	async function handlePreview() {
		if (!selectedFile || !canPreview) {
			return;
		}

		isPreviewing = true;
		preview = null;
		result = null;
		errorMessage = '';

		try {
			preview = await requireApi().previewTrackedImportTimestampRecovery(selectedFile);
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isPreviewing = false;
		}
	}

	async function handleApply() {
		if (!selectedFile || !canApply) {
			return;
		}

		isApplying = true;
		result = null;
		errorMessage = '';

		try {
			result = await requireApi().repairTrackedImportTimestamps(selectedFile);
			preview = result;
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isApplying = false;
		}
	}
</script>

<section class="box-border flex min-w-0 flex-1 flex-col px-1">
	<div class="border-b border-white/10 pb-5">
		<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Testing</p>
		<h1 class="mt-2 text-3xl font-semibold text-white">Tracked import recovery</h1>
		<p class="mt-2 text-sm leading-6 text-zinc-400">
			Repair corrupted imported Tracked timestamps from the original export zip.
		</p>
	</div>

	{#if isLoading}
		<div class="flex min-h-40 items-center justify-center text-sm text-zinc-400">
			<Icon name="loader-circle" class="mr-2 h-4 w-4 animate-spin" />
			Loading recovery utility
		</div>
	{:else}
		<div class="grid gap-5 py-5">
			<section class="grid gap-3 border-b border-white/10 pb-5">
				<label class="block" for="tracked-recovery-file">
					<span class="mb-2 block text-sm font-medium text-zinc-300">Tracked ZIP</span>
					<input
						id="tracked-recovery-file"
						class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-base text-white file:mr-3 file:rounded-md file:border-0 file:bg-emerald-300 file:px-3 file:py-2 file:text-sm file:font-bold file:text-zinc-950 focus:border-emerald-300/60 focus:outline-none disabled:text-zinc-600"
						type="file"
						accept=".zip,application/zip"
						disabled={isPreviewing || isApplying}
						onchange={handleFileChange}
					/>
				</label>

				<button
					class="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
					type="button"
					disabled={!canPreview}
					onclick={handlePreview}
				>
					{#if isPreviewing}
						<Icon name="loader-circle" class="h-5 w-5 animate-spin" />
					{:else}
						<Icon name="database" class="h-5 w-5" />
					{/if}
					Preview recovery
				</button>
			</section>

			{#if preview}
				<section class="rounded-lg border border-white/10 bg-white/[0.03]">
					<div class="border-b border-white/10 px-3 py-3">
						<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
							Preview
						</p>
						<h2 class="mt-1 truncate text-base font-semibold text-white">{preview.fileName}</h2>
					</div>

					<div class="grid gap-2 p-3 text-sm">
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Archive sessions</span>
							<span class="font-semibold text-white">{preview.sessionsFound}</span>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Importable strength sessions</span>
							<span class="font-semibold text-white">{preview.importableSessionsFound}</span>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Matched imported sessions</span>
							<span class="font-semibold text-white">{preview.matchedImportedSessions}</span>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Sessions needing repair</span>
							<span class="font-semibold text-white">{preview.repairableSessions}</span>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Already correct sessions</span>
							<span class="font-semibold text-white">{preview.alreadyCorrectSessions}</span>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Missing imported sessions</span>
							<span class="font-semibold text-white">{preview.missingImportedSessions}</span>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Session exercises matched / repairable</span>
							<span class="font-semibold text-white">
								{preview.matchedSessionExercises} / {preview.repairableSessionExercises}
							</span>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Session exercises missing</span>
							<span class="font-semibold text-white">{preview.missingSessionExercises}</span>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Session sets matched / repairable</span>
							<span class="font-semibold text-white">
								{preview.matchedSessionSets} / {preview.repairableSessionSets}
							</span>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-zinc-400">Session sets missing</span>
							<span class="font-semibold text-white">{preview.missingSessionSets}</span>
						</div>
					</div>
				</section>

				{#if preview.warnings.length > 0}
					<section class="rounded-lg border border-amber-300/25 bg-amber-500/10 px-3 py-3">
						<p class="text-sm font-semibold text-amber-100">Warnings</p>
						<ul class="mt-2 grid gap-1 text-sm leading-5 text-amber-100/80">
							{#each preview.warnings as warning, index (`${index}:${warning}`)}
								<li>{warning}</li>
							{/each}
						</ul>
					</section>
				{/if}

				<div class="grid gap-2 border-t border-white/10 pt-5">
					<button
						class="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
						type="button"
						disabled={!canApply}
						onclick={handleApply}
					>
						{#if isApplying}
							<Icon name="loader-circle" class="h-5 w-5 animate-spin" />
						{:else}
							<Icon name="rotate-ccw" class="h-5 w-5" />
						{/if}
						Apply exact recovery
					</button>

					{#if repairableRows === 0}
						<p class="text-center text-sm text-zinc-500">No timestamp repairs are needed.</p>
					{/if}
				</div>
			{/if}

			{#if result}
				<section
					class="rounded-lg border border-emerald-300/30 bg-emerald-500/10 px-3 py-3 text-sm leading-6 text-emerald-100"
				>
					<p class="font-semibold">Recovery complete</p>
					<p>Sessions repaired: {result.sessionsRepaired}</p>
					<p>Session exercises repaired: {result.sessionExercisesRepaired}</p>
					<p>Session sets repaired: {result.sessionSetsRepaired}</p>
					<p>Sync: {result.syncStatus}</p>
					{#if result.syncError}
						<p>{result.syncError}</p>
					{/if}
				</section>
			{/if}

			{#if errorMessage}
				<p
					class="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
				>
					{errorMessage}
				</p>
			{/if}
		</div>
	{/if}
</section>
