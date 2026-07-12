<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fly } from 'svelte/transition';
	import type { SessionSummary } from '$lib/db';
	import { buildCalendarWeek } from './calendar';

	let {
		weekDate,
		selectedDayKey,
		sessionByDayKey,
		slideDirection,
		onSelectDay,
		onShiftWeek
	}: {
		weekDate: Date;
		selectedDayKey: string;
		sessionByDayKey: Map<string, SessionSummary>;
		slideDirection: -1 | 0 | 1;
		onSelectDay: (dayKey: string) => void;
		onShiftWeek: (delta: -1 | 1) => void;
	} = $props();

	let weekCells = $derived(buildCalendarWeek(weekDate));
	let weekKey = $derived(weekCells[0]?.dayKey ?? '');
	let pointerStartX = $state<number | null>(null);
	let pointerId = $state<number | null>(null);
	let suppressNextPointerClick = false;
	let clickSuppressionTimer: ReturnType<typeof setTimeout> | null = null;
	const SWIPE_THRESHOLD = 36;

	function getStatusTone(dayKey: string) {
		const session = sessionByDayKey.get(dayKey);

		if (!session) {
			return '';
		}

		return session.status === 'completed' ? 'bg-emerald-300' : 'bg-amber-300';
	}

	function handlePointerDown(event: PointerEvent) {
		if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
			return;
		}

		pointerStartX = event.clientX;
		pointerId = event.pointerId;
		const eventTarget = event.target;
		const captureTarget =
			eventTarget instanceof Element
				? (eventTarget.closest('button') ?? (event.currentTarget as HTMLElement))
				: (event.currentTarget as HTMLElement);
		captureTarget.setPointerCapture(event.pointerId);
	}

	function handlePointerUp(event: PointerEvent) {
		if (pointerStartX === null || pointerId !== event.pointerId) {
			return;
		}

		const deltaX = event.clientX - pointerStartX;
		pointerStartX = null;
		pointerId = null;

		if (Math.abs(deltaX) < SWIPE_THRESHOLD) {
			return;
		}

		suppressNextPointerClick = true;
		if (clickSuppressionTimer !== null) {
			clearTimeout(clickSuppressionTimer);
		}
		clickSuppressionTimer = setTimeout(() => {
			suppressNextPointerClick = false;
			clickSuppressionTimer = null;
		}, 0);
		event.preventDefault();
		onShiftWeek(deltaX < 0 ? 1 : -1);
	}

	function resetSwipe() {
		pointerStartX = null;
		pointerId = null;
	}

	function selectDay(event: MouseEvent, dayKey: string) {
		if (event.detail !== 0 && suppressNextPointerClick) {
			suppressNextPointerClick = false;
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		onSelectDay(dayKey);
	}

	onDestroy(() => {
		if (clickSuppressionTimer !== null) {
			clearTimeout(clickSuppressionTimer);
		}
	});
</script>

<div
	class="overflow-hidden px-1 py-2"
	role="group"
	aria-label="Current week"
	onpointerdown={handlePointerDown}
	onpointerup={handlePointerUp}
	onpointercancel={resetSwipe}
	onlostpointercapture={resetSwipe}
>
	{#key weekKey}
		<div
			class="grid grid-cols-7 gap-2"
			in:fly={{ x: slideDirection >= 0 ? 20 : -20, duration: 160 }}
			out:fly={{ x: slideDirection >= 0 ? -20 : 20, duration: 160 }}
		>
			{#each weekCells as cell (cell.dayKey)}
				<button
					class="relative flex min-h-[52px] flex-col items-center justify-center rounded-lg px-1 text-zinc-400 transition hover:text-white"
					type="button"
					aria-label={cell.date.toLocaleDateString(undefined, {
						weekday: 'long',
						month: 'long',
						day: 'numeric'
					})}
					onclick={(event) => selectDay(event, cell.dayKey)}
				>
					<span class="text-[10px] font-medium tracking-[0.18em] uppercase opacity-70">
						{cell.date.toLocaleDateString(undefined, { weekday: 'narrow' })}
					</span>
					<span
						class={`mt-1 inline-flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-xl font-semibold ${
							cell.dayKey === selectedDayKey
								? 'bg-white text-zinc-950'
								: cell.isToday
									? 'bg-white/[0.08] text-white'
									: 'text-zinc-300'
						}`}
					>
						{cell.date.getDate()}
					</span>

					<span class="mt-1 h-1.5 w-1.5 rounded-full bg-transparent">
						{#if sessionByDayKey.has(cell.dayKey)}
							<span class={`block h-1.5 w-1.5 rounded-full ${getStatusTone(cell.dayKey)}`}></span>
						{/if}
					</span>
				</button>
			{/each}
		</div>
	{/key}
</div>
