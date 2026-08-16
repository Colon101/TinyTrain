<script lang="ts">
	import type { SessionInputField, SessionSetOverview, SessionSetSide } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import SessionSetFieldInput from './SessionSetFieldInput.svelte';

	const setEditorGridClass = 'grid grid-cols-[3.2rem_repeat(3,minmax(0,1fr))_2rem] gap-2';

	let {
		sets,
		isSaving,
		isUnilateral,
		onAutofillPreviousSet,
		onSetInput,
		onSetInputKeydown,
		onAddSet,
		onRemoveSet
	}: {
		sets: SessionSetOverview[];
		isSaving: boolean;
		isUnilateral: boolean;
		onAutofillPreviousSet: (sessionSet: SessionSetOverview) => void;
		onSetInput: (sessionSetId: string, field: SessionInputField, event: Event) => void;
		onSetInputKeydown: (event: KeyboardEvent) => void;
		onAddSet: () => void;
		onRemoveSet: (sessionSetId: string) => void;
	} = $props();

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

	function getSetInputLabel(set: SessionSetOverview, field: string) {
		return `Set ${formatSetBadgeValue(set.side, set.order)} ${field}`;
	}
</script>

<section class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
	{#if sets.length > 0}
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
			{#each sets as set (set.id)}
				<div
					class={`${setEditorGridClass} items-center rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2`}
				>
					<div class="flex min-w-0 items-center justify-center">
						<button
							class="flex w-full flex-col items-center justify-center rounded-md leading-none transition hover:bg-white/[0.06] disabled:opacity-50"
							type="button"
							title="Fill from previous session"
							aria-label={`Fill ${getSetInputLabel(set, 'inputs')} from the previous session`}
							disabled={!set.previousReference || isSaving}
							onclick={() => onAutofillPreviousSet(set)}
						>
							<p class="text-[10px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">Set</p>
							<p class="mt-1 text-xl font-bold text-white tabular-nums">
								{formatSetBadgeValue(set.side, set.order)}
							</p>
						</button>
					</div>

					<SessionSetFieldInput
						setId={set.id}
						field="weight"
						inputMode="decimal"
						ariaLabel={getSetInputLabel(set, 'weight')}
						value={set.weightInput ?? ''}
						previousValue={set.previousReference?.weight}
						delta={set.weightDelta}
						disabled={isSaving}
						onInput={(event) => onSetInput(set.id, 'weight', event)}
						onKeydown={onSetInputKeydown}
					/>

					<SessionSetFieldInput
						setId={set.id}
						field="reps"
						inputMode="numeric"
						pattern="[0-9]*"
						ariaLabel={getSetInputLabel(set, 'reps')}
						value={set.repsInput ?? ''}
						previousValue={set.previousReference?.reps}
						delta={set.repsDelta}
						disabled={isSaving}
						onInput={(event) => onSetInput(set.id, 'reps', event)}
						onKeydown={onSetInputKeydown}
					/>

					<SessionSetFieldInput
						setId={set.id}
						field="rir"
						inputMode="numeric"
						pattern="[0-9]*"
						ariaLabel={getSetInputLabel(set, 'RIR')}
						value={set.rirInput ?? ''}
						previousValue={set.previousReference?.rir}
						delta={set.rirDelta}
						disabled={isSaving}
						onInput={(event) => onSetInput(set.id, 'rir', event)}
						onKeydown={onSetInputKeydown}
					/>

					<div class="flex items-center justify-center">
						<button
							class="flex h-11 w-8 items-center justify-center rounded-md text-zinc-400 transition hover:bg-red-400/10 hover:text-red-100 disabled:opacity-50"
							type="button"
							title={isUnilateral ? 'Remove set pair' : 'Remove set'}
							aria-label={`${isUnilateral ? 'Remove set pair' : 'Remove set'} ${formatSetBadgeValue(set.side, set.order)}`}
							disabled={isSaving}
							onclick={() => onRemoveSet(set.id)}
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
		onclick={onAddSet}
	>
		<Icon name="plus" class="h-4 w-4" />
		Add set
	</button>
</section>
