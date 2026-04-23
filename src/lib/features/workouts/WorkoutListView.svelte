<script lang="ts">
	import type { Workout } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';

	let {
		workouts,
		isCreatingWorkout,
		newWorkoutName,
		isSaving,
		onStartCreate,
		onCancelCreate,
		onWorkoutNameInput,
		onSubmitCreate,
		onOpenWorkout
	}: {
		workouts: Workout[];
		isCreatingWorkout: boolean;
		newWorkoutName: string;
		isSaving: boolean;
		onStartCreate: () => void;
		onCancelCreate: () => void;
		onWorkoutNameInput: (value: string) => void;
		onSubmitCreate: (event: SubmitEvent) => void;
		onOpenWorkout: (workoutId: string) => void;
	} = $props();
</script>

<section class="flex flex-1 flex-col">
	<div class="flex items-start justify-between gap-4 border-b border-white/10 pb-5">
		<div>
			<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Builder</p>
			<h1 class="mt-2 text-3xl font-semibold text-white">Workouts</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				Keep workout templates tidy before you start tracking real sessions.
			</p>
		</div>

		<button
			class="flex min-h-11 items-center gap-2 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
			type="button"
			disabled={isSaving}
			onclick={onStartCreate}
		>
			<Icon name="plus" class="h-4 w-4" />
			Add workout
		</button>
	</div>

	{#if isCreatingWorkout || workouts.length === 0}
		<form class="border-b border-white/10 py-5" onsubmit={onSubmitCreate}>
			<label class="block" for="new-workout-name">
				<span class="mb-2 block text-sm font-medium text-zinc-300">Workout name</span>
				<input
					id="new-workout-name"
					class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-emerald-300/60"
					value={newWorkoutName}
					autocomplete="off"
					placeholder="Push day, legs, upper..."
					oninput={(event) => onWorkoutNameInput((event.currentTarget as HTMLInputElement).value)}
				/>
			</label>

			<div class="mt-3 flex gap-2">
				<button
					class="min-h-11 flex-1 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
					type="submit"
					disabled={isSaving || !newWorkoutName.trim()}
				>
					Create workout
				</button>
				{#if workouts.length > 0}
					<button
						class="min-h-11 rounded-lg border border-white/10 px-4 text-sm font-semibold text-zinc-300"
						type="button"
						disabled={isSaving}
						onclick={onCancelCreate}
					>
						Cancel
					</button>
				{/if}
			</div>
		</form>
	{/if}

	<section class="py-5">
		<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Your workouts</p>

		{#if workouts.length > 0}
			<div class="mt-4 grid gap-3">
				{#each workouts as workout}
					<button
						class="flex min-h-16 items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-4 text-left transition hover:border-emerald-300/50"
						type="button"
						onclick={() => onOpenWorkout(workout.id)}
					>
						<div class="min-w-0">
							<p class="truncate text-base font-semibold text-white">{workout.name}</p>
							<p class="mt-1 text-sm text-zinc-400">Edit exercise order and library choices.</p>
						</div>
						<Icon name="arrow-right" class="h-4 w-4 shrink-0 text-zinc-500" />
					</button>
				{/each}
			</div>
		{:else}
			<div
				class="mt-4 rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-zinc-400"
			>
				Create your first workout to start building session templates.
			</div>
		{/if}
	</section>
</section>
