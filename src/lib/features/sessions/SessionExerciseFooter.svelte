<script lang="ts">
	import type { SessionExerciseOverview } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';

	let {
		previousExercise,
		nextExercise,
		isLastExercise,
		isSaving,
		isEditMode = false,
		onPreviousExercise,
		onNextExercise,
		onAddExercise,
		onEndSession
	}: {
		previousExercise: SessionExerciseOverview | null;
		nextExercise: SessionExerciseOverview | null;
		isLastExercise: boolean;
		isSaving: boolean;
		isEditMode?: boolean;
		onPreviousExercise: () => void;
		onNextExercise: () => void;
		onAddExercise: () => void;
		onEndSession: () => void;
	} = $props();
</script>

<div
	class="sticky bottom-0 z-10 mt-2 grid shrink-0 gap-2.5 border-t border-white/10 bg-surface-app pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"
>
	<div class="grid grid-cols-2 gap-2.5">
		<button
			class="flex min-h-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white disabled:text-zinc-500"
			type="button"
			disabled={isSaving || !previousExercise}
			onclick={onPreviousExercise}
		>
			Previous
		</button>
		<button
			class="flex min-h-10 items-center justify-center rounded-lg bg-accent px-4 text-sm font-bold text-on-accent disabled:bg-white/10 disabled:text-zinc-500"
			type="button"
			disabled={isSaving || !nextExercise}
			onclick={onNextExercise}
		>
			Next
		</button>
	</div>

	{#if isLastExercise}
		<button
			class="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white disabled:text-zinc-500"
			type="button"
			disabled={isSaving}
			onclick={onAddExercise}
		>
			<Icon name="plus" class="h-4 w-4" />
			Add exercise
		</button>
		{#if !isEditMode}
			<button
				class="flex min-h-10 items-center justify-center rounded-lg bg-accent px-4 text-sm font-bold text-on-accent disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={isSaving}
				onclick={onEndSession}
			>
				End session
			</button>
		{/if}
	{/if}
</div>
