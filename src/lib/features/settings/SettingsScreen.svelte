<script lang="ts">
	import { onMount } from 'svelte';
	import type { DatabaseUploadSummary, LocalDatabaseStats } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';

	type DatabaseApi = typeof import('$lib/db');

	let api = $state<DatabaseApi | null>(null);
	let stats = $state<LocalDatabaseStats | null>(null);
	let summary = $state<DatabaseUploadSummary | null>(null);
	let isLoading = $state(true);
	let isUploading = $state(false);
	let errorMessage = $state('');
	let statusMessage = $state('');

	onMount(() => {
		let disposed = false;

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (disposed) {
					return;
				}

				api = dbApi;
				await dbApi.ensureDbOpen();

				if (!disposed) {
					stats = await dbApi.getLocalDatabaseStats();
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

	async function uploadLocalDatabase() {
		if (!api || isUploading) {
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
			summary = await api.uploadLocalDatabaseToCloud();
			stats = await api.getLocalDatabaseStats();
			statusMessage = 'Upload finished.';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Upload failed.';
			statusMessage = '';
		} finally {
			isUploading = false;
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
</script>

<svelte:head>
	<title>Settings | TinyTrain</title>
</svelte:head>

<section class="flex flex-1 flex-col gap-5 px-1 pb-6">
	<div class="flex items-start gap-4 pt-3">
		<div
			class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
		>
			<Icon name="database" class="h-5 w-5" />
		</div>
		<div class="min-w-0">
			<p class="text-sm font-medium tracking-[0.18em] text-zinc-500 uppercase">Settings</p>
			<h1 class="mt-1 text-3xl font-semibold text-white">Database</h1>
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
						<dt class="text-zinc-400">Workouts</dt>
						<dd class="font-semibold text-white">{formatNumber(stats?.workouts ?? 0)}</dd>
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
				disabled={!api || isUploading}
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
