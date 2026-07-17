<script lang="ts">
	import type { SessionFieldDelta, SessionInputField } from '$lib/db';
	import type { ProgressIndicatorPosition } from '$lib/progress-indicator-preference';

	const setInputBaseClass =
		'h-11 w-full rounded-md border px-2 py-0 text-center text-[1.0625rem] leading-none font-semibold outline-none placeholder:text-zinc-500';
	const deltaIndicatorBaseClass =
		'pointer-events-none absolute z-10 max-w-[calc(100%-1rem)] overflow-hidden text-[9px] leading-none font-semibold whitespace-nowrap text-ellipsis tabular-nums';

	let {
		setId,
		field,
		inputMode,
		pattern,
		ariaLabel,
		value,
		previousValue,
		delta,
		indicatorPosition,
		disabled = false,
		onInput,
		onKeydown
	}: {
		setId: string;
		field: SessionInputField;
		inputMode: 'decimal' | 'numeric';
		pattern?: string;
		ariaLabel: string;
		value?: string;
		previousValue?: number;
		delta: SessionFieldDelta;
		indicatorPosition: ProgressIndicatorPosition;
		disabled?: boolean;
		onInput: (event: Event) => void;
		onKeydown: (event: KeyboardEvent) => void;
	} = $props();

	function formatPlaceholder(previous?: number) {
		return typeof previous === 'number' && Number.isFinite(previous)
			? `${Number(previous.toFixed(2))}`
			: '';
	}

	function getDeltaToneClass(state: SessionFieldDelta['state']) {
		if (state === 'improved') {
			return 'text-positive-on-light';
		}

		if (state === 'regressed') {
			return 'text-red-700';
		}

		return 'text-zinc-500';
	}

	function getFieldInputClass(state: SessionFieldDelta['state']) {
		if (state === 'improved') {
			return 'border-2 border-positive-border bg-white text-black';
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

	function getDeltaDescription(fieldDelta: SessionFieldDelta) {
		if (!fieldDelta.label || fieldDelta.state === 'empty' || fieldDelta.state === 'matched') {
			return '';
		}

		const comparisonValue = fieldDelta.label.replace(/^[+-]/, '');
		return `${comparisonValue} ${fieldDelta.state === 'improved' ? 'higher' : 'lower'} than the previous session`;
	}

	const deltaDescriptionId = $derived(`set-${setId}-${field}-comparison`);
</script>

<div
	class="relative w-full max-w-[7.25rem] min-w-0 justify-self-center"
	data-delta-position={indicatorPosition}
>
	<input
		class={`${setInputBaseClass} ${getFieldInputClass(delta.state)}`}
		type="text"
		name={`tinytrain-set-${setId}-${field}`}
		autocomplete="off"
		inputmode={inputMode}
		{pattern}
		enterkeyhint="next"
		data-session-set-input="true"
		aria-label={ariaLabel}
		aria-describedby={delta.label ? deltaDescriptionId : undefined}
		{value}
		placeholder={formatPlaceholder(previousValue)}
		{disabled}
		oninput={onInput}
		onkeydown={onKeydown}
	/>
	{#if delta.label}
		<span
			class={`${deltaIndicatorBaseClass} ${getDeltaPositionClass(indicatorPosition)} ${getDeltaToneClass(delta.state)}`}
			aria-hidden="true"
		>
			{delta.label}
		</span>
		<span id={deltaDescriptionId} class="sr-only">
			{getDeltaDescription(delta)}
		</span>
	{/if}
</div>
