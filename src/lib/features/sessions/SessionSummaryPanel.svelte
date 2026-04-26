<script lang="ts">
	import type { SessionOverview } from '$lib/db';

	type ProgressTone = 'positive' | 'negative' | 'neutral';
	type SummaryMetric = {
		label: string;
		value: string;
		comparison: string;
		tone: ProgressTone;
	};

	let {
		overview,
		isSaving,
		onStartSession
	}: {
		overview: SessionOverview;
		isSaving: boolean;
		onStartSession: () => void;
	} = $props();

	let metrics = $derived(createSummaryMetrics(overview));

	function createSummaryMetrics(overview: SessionOverview): SummaryMetric[] {
		const { summary, previousSummary } = overview;

		return [
			{
				label: 'Volume',
				value: formatNumber(summary.totalVolume),
				...getNumberComparison(summary.totalVolume, previousSummary?.totalVolume ?? null)
			},
			{
				label: 'Exercises',
				value: formatNumber(summary.totalExercises),
				...getNumberComparison(summary.totalExercises, previousSummary?.totalExercises ?? null)
			},
			{
				label: 'Sets',
				value: formatNumber(summary.totalSets),
				...getNumberComparison(summary.totalSets, previousSummary?.totalSets ?? null)
			},
			{
				label: 'Reps',
				value: formatNumber(summary.totalReps),
				...getNumberComparison(summary.totalReps, previousSummary?.totalReps ?? null)
			}
		];
	}

	function getNumberComparison(current: number, previous: number | null) {
		if (previous === null) {
			return {
				comparison: 'No previous session',
				tone: 'neutral' as const
			};
		}

		const diff = current - previous;

		if (diff === 0) {
			return {
				comparison: 'Same as previous',
				tone: 'neutral' as const
			};
		}

		return {
			comparison: formatSignedNumber(diff),
			tone: diff > 0 ? ('positive' as const) : ('negative' as const)
		};
	}

	function formatNumber(value: number) {
		return new Intl.NumberFormat('en-US', {
			maximumFractionDigits: value % 1 === 0 ? 0 : 1
		}).format(value);
	}

	function formatSignedNumber(value: number) {
		const prefix = value > 0 ? '+' : '';
		return `${prefix}${formatNumber(value)}`;
	}

	function getToneClass(tone: ProgressTone) {
		if (tone === 'positive') {
			return 'text-emerald-300';
		}

		if (tone === 'negative') {
			return 'text-red-300';
		}

		return 'text-zinc-500';
	}
</script>

{#if overview.summary.status !== 'in_progress'}
	<section class="border-y border-white/10 py-5">
		<div class="grid grid-cols-2 gap-x-5 gap-y-5">
			{#each metrics as metric (metric.label)}
				<div>
					<p class="text-xs font-semibold tracking-[0.16em] text-zinc-500 uppercase">
						{metric.label}
					</p>
					<div class="mt-1.5 flex min-h-8 items-baseline justify-between gap-2">
						<p class="min-w-0 text-lg font-semibold text-white">{metric.value}</p>
						<p class={`shrink-0 text-sm font-semibold ${getToneClass(metric.tone)}`}>
							{metric.comparison}
						</p>
					</div>
				</div>
			{/each}
		</div>

		{#if overview.summary.status === 'planned'}
			<button
				class="mt-4 flex min-h-12 w-full items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={isSaving}
				onclick={onStartSession}
			>
				Start session
			</button>
		{/if}
	</section>
{/if}
