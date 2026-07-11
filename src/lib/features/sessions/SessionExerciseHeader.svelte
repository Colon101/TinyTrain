<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import type { SessionExerciseOverview } from '$lib/db';

	let {
		sessionId,
		activeExercise,
		workoutName,
		exerciseIndex,
		totalExercises,
		isSaving,
		isMenuOpen,
		isEditMode = false,
		onToggleMenu,
		onCloseMenu,
		onAddSet,
		onSwapExercise,
		onRemoveExercise
	}: {
		sessionId: string;
		activeExercise: SessionExerciseOverview;
		workoutName: string;
		exerciseIndex: number;
		totalExercises: number;
		isSaving: boolean;
		isMenuOpen: boolean;
		isEditMode?: boolean;
		onToggleMenu: () => void;
		onCloseMenu: () => void;
		onAddSet: () => void;
		onSwapExercise: () => void;
		onRemoveExercise: () => void;
	} = $props();

	let menuContainer = $state<HTMLElement | null>(null);

	onMount(() => {
		function handlePointerDown(event: PointerEvent) {
			const target = event.target as Node | null;

			if (menuContainer && target && !menuContainer.contains(target)) {
				onCloseMenu();
			}
		}

		window.addEventListener('pointerdown', handlePointerDown, { capture: true });

		return () => {
			window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
		};
	});
</script>

<div class="sticky top-0 z-10 bg-[#080b0d] pb-3">
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0">
			<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
				Exercise {exerciseIndex + 1} / {totalExercises}
			</p>
			<h1 class="mt-1.5 line-clamp-2 text-2xl leading-tight font-semibold break-words text-white">
				{activeExercise.exerciseNameSnapshot}
			</h1>
			<p class="mt-1.5 text-xs leading-5 text-zinc-400">
				{workoutName} ·
				{activeExercise.exercise?.unilateral ? 'Unilateral' : 'Bilateral'}
			</p>
		</div>

		<div class="relative flex shrink-0 items-start gap-2" bind:this={menuContainer}>
			<button
				class="flex h-9 min-w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 text-sm font-semibold text-zinc-300"
				type="button"
				onclick={onToggleMenu}
			>
				···
			</button>

			{#if isMenuOpen}
				<div
					class="absolute top-12 right-0 z-10 grid min-w-44 gap-2 rounded-lg border border-white/10 bg-[#0f1519] p-2 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
				>
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
						href={`${resolve('/(app)/sessions/[sessionId]', { sessionId })}${isEditMode ? '?edit=1' : ''}`}
					>
						Session overview
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
					<button
						class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
						type="button"
						disabled={isSaving}
						onclick={onAddSet}
					>
						Add set
					</button>
					<button
						class="rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-200"
						type="button"
						disabled={isSaving}
						onclick={onSwapExercise}
					>
						Swap exercise
					</button>
					<button
						class="rounded-lg px-3 py-2 text-left text-sm font-medium text-red-200"
						type="button"
						disabled={isSaving}
						onclick={onRemoveExercise}
					>
						Remove exercise
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>
