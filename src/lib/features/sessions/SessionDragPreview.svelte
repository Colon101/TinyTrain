<script lang="ts">
	import type { SessionExerciseOverview } from '$lib/db';

	export type DragPreview = {
		pointerId: number;
		x: number;
		y: number;
		width: number;
		height: number;
		grabX: number;
		grabY: number;
	};

	let {
		dragPreview,
		draggedSessionExercise,
		dragPreviewElement = $bindable(null)
	}: {
		dragPreview: DragPreview;
		draggedSessionExercise: SessionExerciseOverview;
		dragPreviewElement: HTMLDivElement | null;
	} = $props();
</script>

<div
	bind:this={dragPreviewElement}
	class="pointer-events-none fixed z-30 rounded-lg border border-emerald-300/40 bg-[#11171a] px-4 py-4 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
	style={`left:0; top:0; width:${dragPreview.width}px; transform:translate3d(${dragPreview.x}px, ${dragPreview.y}px, 0); will-change:transform;`}
>
	<p class="text-base font-semibold text-white">
		{draggedSessionExercise.exerciseNameSnapshot}
	</p>
	<p class="mt-1 text-sm text-zinc-400">
		{draggedSessionExercise.exercise?.unilateral ? 'Unilateral' : 'Bilateral'}
	</p>
</div>
