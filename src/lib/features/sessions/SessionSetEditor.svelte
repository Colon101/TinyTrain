<script lang="ts">
	import { onMount } from 'svelte';
	import type {
		SessionFieldDelta,
		SessionInputField,
		SessionSetOverview,
		SessionSetSide
	} from '$lib/db';
	import {
		DEFAULT_PROGRESS_INDICATOR_POSITION,
		initializeProgressIndicatorPreference,
		progressIndicatorPosition,
		type ProgressIndicatorPosition
	} from '$lib/progress-indicator-preference';
	import Icon from '$lib/ui/Icon.svelte';

	const setEditorGridClass = 'grid grid-cols-[3.2rem_repeat(3,minmax(0,1fr))_2rem] gap-2';
	const setInputBaseClass =
		'h-11 w-full rounded-md border px-2 py-0 text-center text-[1.0625rem] leading-none font-semibold outline-none placeholder:text-zinc-500 focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#080b0d]';
	const deltaIndicatorBaseClass =
		'pointer-events-none absolute z-10 max-w-[calc(100%-1rem)] overflow-hidden text-[9px] leading-none font-semibold whitespace-nowrap text-ellipsis tabular-nums';

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

	onMount(() => {
		initializeProgressIndicatorPreference();
	});

	function formatPlaceholder(value?: number) {
		return typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(2))}` : '';
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
			return 'border-2 border-red-500 bg-white text-black';
		}

		return 'border-zinc-300 bg-white text-black';
	}

	function getDeltaPositionClass(position: ProgressIndicatorPosition) {
		switch (position) {
			case 'top-left':
				return 'top-1 left-2 text-left';
			case 'top-center':
				return 'top-1 left-1/2 -translate-x-1/2 text-center';
			case 'top-right':
				return 'top-1 right-2 text-right';
			case 'bottom-center':
				return 'bottom-1 left-1/2 -translate-x-1/2 text-center';
			case 'bottom-right':
				return 'right-2 bottom-1 text-right';
			case 'bottom-left':
			default:
				return 'bottom-1 left-2 text-left';
		}
	}

	function getDeltaDescription(delta: SessionFieldDelta) {
		if (!delta.label || delta.state === 'empty' || delta.state === 'matched') {
			return '';
		}

		const value = delta.label.replace(/^[+-]/, '');
		return `${value} ${delta.state === 'improved' ? 'higher' : 'lower'} than the previous session`;
	}

	function getDeltaDescriptionId(setId: string, field: SessionInputField) {
		return `set-${setId}-${field}-comparison`;
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
				{@const indicatorPosition =
					$progressIndicatorPosition ?? DEFAULT_PROGRESS_INDICATOR_POSITION}
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

					<div
						class="relative w-full max-w-[7.25rem] min-w-0 justify-self-center"
						data-delta-position={indicatorPosition}
					>
						<input
							class={`${setInputBaseClass} ${getFieldInputClass(set.weightDelta.state)}`}
							type="text"
							name={`tinytrain-set-${set.id}-weight`}
							autocomplete="off"
							inputmode="decimal"
							enterkeyhint="next"
							data-session-set-input="true"
							aria-label={getSetInputLabel(set, 'weight')}
							aria-describedby={set.weightDelta.label
								? getDeltaDescriptionId(set.id, 'weight')
								: undefined}
							value={set.weightInput ?? ''}
							placeholder={formatPlaceholder(set.previousReference?.weight)}
							oninput={(event) => onSetInput(set.id, 'weight', event)}
							onkeydown={onSetInputKeydown}
						/>
						{#if set.weightDelta.label}
							<span
								class={`${deltaIndicatorBaseClass} ${getDeltaPositionClass(indicatorPosition)} ${getDeltaToneClass(set.weightDelta.state)}`}
								aria-hidden="true"
							>
								{set.weightDelta.label}
							</span>
							<span id={getDeltaDescriptionId(set.id, 'weight')} class="sr-only">
								{getDeltaDescription(set.weightDelta)}
							</span>
						{/if}
					</div>

					<div
						class="relative w-full max-w-[7.25rem] min-w-0 justify-self-center"
						data-delta-position={indicatorPosition}
					>
						<input
							class={`${setInputBaseClass} ${getFieldInputClass(set.repsDelta.state)}`}
							type="text"
							name={`tinytrain-set-${set.id}-reps`}
							autocomplete="off"
							inputmode="numeric"
							pattern="[0-9]*"
							enterkeyhint="next"
							data-session-set-input="true"
							aria-label={getSetInputLabel(set, 'reps')}
							aria-describedby={set.repsDelta.label
								? getDeltaDescriptionId(set.id, 'reps')
								: undefined}
							value={set.repsInput ?? ''}
							placeholder={formatPlaceholder(set.previousReference?.reps)}
							oninput={(event) => onSetInput(set.id, 'reps', event)}
							onkeydown={onSetInputKeydown}
						/>
						{#if set.repsDelta.label}
							<span
								class={`${deltaIndicatorBaseClass} ${getDeltaPositionClass(indicatorPosition)} ${getDeltaToneClass(set.repsDelta.state)}`}
								aria-hidden="true"
							>
								{set.repsDelta.label}
							</span>
							<span id={getDeltaDescriptionId(set.id, 'reps')} class="sr-only">
								{getDeltaDescription(set.repsDelta)}
							</span>
						{/if}
					</div>

					<div
						class="relative w-full max-w-[7.25rem] min-w-0 justify-self-center"
						data-delta-position={indicatorPosition}
					>
						<input
							class={`${setInputBaseClass} ${getFieldInputClass(set.rirDelta.state)}`}
							type="text"
							name={`tinytrain-set-${set.id}-rir`}
							autocomplete="off"
							inputmode="numeric"
							pattern="[0-9]*"
							enterkeyhint="next"
							data-session-set-input="true"
							aria-label={getSetInputLabel(set, 'RIR')}
							aria-describedby={set.rirDelta.label
								? getDeltaDescriptionId(set.id, 'rir')
								: undefined}
							value={set.rirInput ?? ''}
							placeholder={formatPlaceholder(set.previousReference?.rir)}
							oninput={(event) => onSetInput(set.id, 'rir', event)}
							onkeydown={onSetInputKeydown}
						/>
						{#if set.rirDelta.label}
							<span
								class={`${deltaIndicatorBaseClass} ${getDeltaPositionClass(indicatorPosition)} ${getDeltaToneClass(set.rirDelta.state)}`}
								aria-hidden="true"
							>
								{set.rirDelta.label}
							</span>
							<span id={getDeltaDescriptionId(set.id, 'rir')} class="sr-only">
								{getDeltaDescription(set.rirDelta)}
							</span>
						{/if}
					</div>

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
