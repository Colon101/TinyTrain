<script lang="ts">
	import type { SessionSetOverview } from '$lib/db';
	import { formatSetCellValue, getDeltaToneClass } from './session-overview';

	let {
		sets,
		variant = 'default'
	}: {
		sets: SessionSetOverview[];
		variant?: 'compact' | 'default';
	} = $props();

	let labelCellClass = $derived(
		variant === 'compact'
			? 'rounded-l-md bg-white/[0.04] px-2 py-3 align-middle'
			: 'rounded-l-md bg-white/[0.04] px-3 py-3 align-middle'
	);
	let labelValueClass = $derived(
		variant === 'compact'
			? 'mt-1 block text-lg leading-none font-semibold text-white'
			: 'mt-1 block text-xl leading-none font-semibold text-white'
	);
	let setTableGridClass = $derived(
		variant === 'compact'
			? 'grid grid-cols-[4.75rem_repeat(3,minmax(0,1fr))]'
			: 'grid grid-cols-[5.25rem_repeat(3,minmax(0,1fr))]'
	);
	let headingClass =
		'text-center text-[10px] font-semibold tracking-[0.08em] text-zinc-500 uppercase';
	let valueCellClass =
		'flex min-w-0 flex-col items-center justify-center gap-1 bg-white/[0.04] px-1.5 py-3 text-center text-base font-semibold text-white';
</script>

{#if sets.length > 0}
	<div class="mt-4 grid gap-2">
		<div class={`${setTableGridClass} items-end`}>
			<span></span>
			<span class={headingClass}>Weight</span>
			<span class={headingClass}>Reps</span>
			<span class={headingClass}>RIR</span>
		</div>

		{#each sets as set (set.id)}
			<div class={setTableGridClass}>
				<div class={labelCellClass}>
					<span class="block text-xs font-medium tracking-[0.12em] text-zinc-400 uppercase">
						Set
					</span>
					<span class={labelValueClass}>
						{set.label.replace('Set ', '')}
					</span>
				</div>
				<div class={valueCellClass}>
					<span>{formatSetCellValue(set.weight)}</span>
					{#if set.weightDelta.label}
						<span class={`text-xs font-semibold ${getDeltaToneClass(set.weightDelta.state)}`}>
							{set.weightDelta.label}
						</span>
					{/if}
				</div>
				<div class={valueCellClass}>
					<span>{formatSetCellValue(set.reps)}</span>
					{#if set.repsDelta.label}
						<span class={`text-xs font-semibold ${getDeltaToneClass(set.repsDelta.state)}`}>
							{set.repsDelta.label}
						</span>
					{/if}
				</div>
				<div class={`${valueCellClass} rounded-r-md`}>
					<span>{formatSetCellValue(set.rir)}</span>
					{#if set.rirDelta.label}
						<span class={`text-xs font-semibold ${getDeltaToneClass(set.rirDelta.state)}`}>
							{set.rirDelta.label}
						</span>
					{/if}
				</div>
			</div>
		{/each}
	</div>
{/if}
