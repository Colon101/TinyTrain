<script lang="ts">
	import type { Workout } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import { trapDialogFocus } from '$lib/ui/dialog-focus';

	let {
		workouts,
		isSaving,
		onClose,
		onPickWorkout
	}: {
		workouts: Workout[];
		isSaving: boolean;
		onClose: () => void;
		onPickWorkout: (workoutId: string) => void;
	} = $props();
</script>

<div class="fixed inset-0 z-20 bg-black/60 px-4 py-5">
	<div
		class="mx-auto flex h-full w-full max-w-[430px] flex-col rounded-lg border border-white/10 bg-surface-overlay"
		role="dialog"
		aria-modal="true"
		aria-labelledby="workout-picker-title"
		tabindex="-1"
		use:trapDialogFocus={{ onEscape: onClose }}
	>
		<header class="flex items-center justify-between border-b border-white/10 px-4 py-4">
			<div>
				<p class="text-xs font-semibold tracking-[0.18em] text-accent-soft uppercase">
					Schedule workout
				</p>
				<h2 id="workout-picker-title" class="mt-2 text-xl font-semibold text-white">
					Pick today&apos;s session
				</h2>
			</div>
			<button
				class="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300"
				type="button"
				aria-label="Close workout picker"
				title="Close workout picker"
				onclick={onClose}
			>
				<Icon name="x" class="h-4 w-4" />
			</button>
		</header>

		<div class="flex-1 overflow-y-auto px-4 py-4">
			<div class="grid gap-3">
				{#each workouts as workout (workout.id)}
					<button
						class="flex min-h-14 items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-4 text-left text-white transition hover:border-accent/50"
						type="button"
						disabled={isSaving}
						onclick={() => onPickWorkout(workout.id)}
					>
						<span class="truncate text-sm font-semibold">{workout.name}</span>
						<Icon name="arrow-right" class="h-4 w-4 shrink-0 text-zinc-500" />
					</button>
				{/each}
			</div>
		</div>
	</div>
</div>
