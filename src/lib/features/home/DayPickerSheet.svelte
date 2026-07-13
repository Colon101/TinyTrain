<script lang="ts">
	import type { SessionSummary } from '$lib/db';
	import { formatMonthHeading } from '$lib/features/sessions/session-format';
	import Icon from '$lib/ui/Icon.svelte';
	import { trapDialogFocus } from '$lib/ui/dialog-focus';
	import { buildCalendarMonth } from './calendar';

	let {
		monthDate,
		selectedDayKey,
		sessionByDayKey,
		onSelectDay,
		onClose,
		onPreviousMonth,
		onNextMonth
	}: {
		monthDate: Date;
		selectedDayKey: string;
		sessionByDayKey: Map<string, SessionSummary>;
		onSelectDay: (dayKey: string) => void | Promise<void>;
		onClose: () => void;
		onPreviousMonth: () => void;
		onNextMonth: () => void;
	} = $props();

	const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	let weeks = $derived(buildCalendarMonth(monthDate));
	let isSelecting = $state(false);
	let selectionError = $state('');

	function getStatusTone(dayKey: string) {
		const session = sessionByDayKey.get(dayKey);

		if (!session) {
			return '';
		}

		return session.status === 'completed' ? 'bg-emerald-300' : 'bg-amber-300';
	}

	async function chooseDay(dayKey: string) {
		if (isSelecting) {
			return;
		}

		isSelecting = true;
		selectionError = '';

		try {
			await onSelectDay(dayKey);
			onClose();
		} catch (error) {
			selectionError =
				error instanceof Error && error.message
					? error.message
					: 'Could not select that day. Please try again.';
		} finally {
			isSelecting = false;
		}
	}
</script>

<div class="fixed inset-0 z-30 px-4 py-5">
	<button
		class="absolute inset-0 bg-black/60"
		type="button"
		aria-label="Close date picker"
		onclick={onClose}
	></button>

	<div
		class="relative mx-auto flex max-h-full w-full max-w-[430px] flex-col rounded-lg border border-white/10 bg-[#0e1417]"
		role="dialog"
		aria-modal="true"
		aria-label="Choose a day"
		aria-busy={isSelecting}
		tabindex="-1"
		use:trapDialogFocus={{ onEscape: onClose }}
	>
		<header class="flex items-center justify-between border-b border-white/10 px-4 py-4">
			<div>
				<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">Choose day</p>
				<h2 class="mt-2 text-xl font-semibold text-white">{formatMonthHeading(monthDate)}</h2>
			</div>

			<button
				class="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300"
				type="button"
				title="Close date picker"
				onclick={onClose}
			>
				<Icon name="x" class="h-4 w-4" />
			</button>
		</header>

		<div class="overflow-y-auto px-4 py-4">
			{#if selectionError}
				<p
					class="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
					role="alert"
				>
					{selectionError}
				</p>
			{/if}

			<div class="flex items-center justify-between">
				<button
					class="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-200 transition hover:border-emerald-300/50 hover:bg-white/[0.08]"
					type="button"
					title="Previous month"
					onclick={onPreviousMonth}
				>
					<Icon name="chevron-left" class="h-4 w-4" />
				</button>
				<p class="text-sm font-medium text-zinc-300">{formatMonthHeading(monthDate)}</p>
				<button
					class="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-200 transition hover:border-emerald-300/50 hover:bg-white/[0.08]"
					type="button"
					title="Next month"
					onclick={onNextMonth}
				>
					<Icon name="chevron-right" class="h-4 w-4" />
				</button>
			</div>

			<div
				class="mt-5 grid grid-cols-7 gap-1 text-center text-[11px] font-medium tracking-[0.18em] text-zinc-500 uppercase"
			>
				{#each weekdayLabels as label (label)}
					<div class="py-1">{label}</div>
				{/each}
			</div>

			<div class="mt-2 grid gap-1">
				{#each weeks as week (week[0].dayKey)}
					<div class="grid grid-cols-7 gap-1">
						{#each week as cell (cell.dayKey)}
							<button
								class={`relative aspect-square rounded-lg border text-left transition ${
									cell.dayKey === selectedDayKey
										? 'border-emerald-300 bg-emerald-300/15 text-white'
										: cell.isInMonth
											? 'border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]'
											: 'border-transparent bg-transparent text-zinc-700'
								}`}
								type="button"
								disabled={isSelecting}
								onclick={() => void chooseDay(cell.dayKey)}
							>
								<span
									class={`absolute top-2 left-2 text-sm font-medium ${
										cell.isToday && cell.dayKey !== selectedDayKey ? 'text-emerald-200' : ''
									}`}
								>
									{cell.date.getDate()}
								</span>

								{#if sessionByDayKey.has(cell.dayKey)}
									<span
										class={`absolute right-2 bottom-2 h-2.5 w-2.5 rounded-full ${getStatusTone(cell.dayKey)}`}
									></span>
								{/if}
							</button>
						{/each}
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
