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

	let labelHeaderClass = $derived(
		variant === 'compact' ? 'w-20 px-2 text-left' : 'w-24 px-3 text-left'
	);
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
</script>

{#if sets.length > 0}
	<table class="mt-4 w-full table-fixed border-separate border-spacing-y-2">
		<thead>
			<tr class="text-[11px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">
				<th class={labelHeaderClass}></th>
				<th class="px-2 text-center">Weight</th>
				<th class="px-2 text-center">Reps</th>
				<th class="px-2 text-center">RIR</th>
			</tr>
		</thead>
		<tbody>
			{#each sets as set (set.id)}
				<tr>
					<td class={labelCellClass}>
						<span class="block text-xs font-medium tracking-[0.12em] text-zinc-400 uppercase">
							Set
						</span>
						<span class={labelValueClass}>
							{set.label.replace('Set ', '')}
						</span>
					</td>
					<td
						class="bg-white/[0.04] px-2 py-3 text-center align-middle text-base font-semibold text-white"
					>
						<div class="flex flex-col items-center gap-1">
							<span>{formatSetCellValue(set.weight)}</span>
							{#if set.weightDelta.label}
								<span class={`text-xs font-semibold ${getDeltaToneClass(set.weightDelta.state)}`}>
									{set.weightDelta.label}
								</span>
							{/if}
						</div>
					</td>
					<td
						class="bg-white/[0.04] px-2 py-3 text-center align-middle text-base font-semibold text-white"
					>
						<div class="flex flex-col items-center gap-1">
							<span>{formatSetCellValue(set.reps)}</span>
							{#if set.repsDelta.label}
								<span class={`text-xs font-semibold ${getDeltaToneClass(set.repsDelta.state)}`}>
									{set.repsDelta.label}
								</span>
							{/if}
						</div>
					</td>
					<td
						class="rounded-r-md bg-white/[0.04] px-2 py-3 text-center align-middle text-base font-semibold text-white"
					>
						<div class="flex flex-col items-center gap-1">
							<span>{formatSetCellValue(set.rir)}</span>
							{#if set.rirDelta.label}
								<span class={`text-xs font-semibold ${getDeltaToneClass(set.rirDelta.state)}`}>
									{set.rirDelta.label}
								</span>
							{/if}
						</div>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
