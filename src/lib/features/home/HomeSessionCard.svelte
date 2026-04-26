<script lang="ts">
	import { resolve } from '$app/paths';
	import type { SessionSummary } from '$lib/db';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		formatDuration,
		formatSessionStatus,
		formatSessionTime
	} from '$lib/features/sessions/session-format';

	let {
		session,
		label = '',
		nowMs = Date.now(),
		isBusy = false,
		onStart
	}: {
		session: SessionSummary;
		label?: string;
		nowMs?: number;
		isBusy?: boolean;
		onStart?: (() => void) | null;
	} = $props();

	let isPlanned = $derived(session.status === 'planned');
	let displayTime = $derived(session.startedAt ?? session.createdAt);

	function getStatusIconName() {
		if (session.status === 'completed') {
			return 'check-circle';
		}

		if (session.status === 'abandoned') {
			return 'x';
		}

		return 'activity';
	}

	function getStatusIconTone() {
		if (session.status === 'completed') {
			return 'text-emerald-300';
		}

		if (session.status === 'abandoned') {
			return 'text-red-300';
		}

		return session.status === 'planned' ? 'text-zinc-400' : 'text-amber-300';
	}
</script>

<article class="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-4">
	{#if label}
		<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">{label}</p>
	{/if}

	<div class={`flex items-start justify-between gap-4 ${label ? 'mt-2' : ''}`}>
		<div class="min-w-0">
			<p class="text-sm font-medium text-zinc-400">
				{isPlanned ? 'Scheduled' : formatSessionTime(displayTime)}
			</p>
			<h2 class="mt-1 truncate text-xl font-semibold text-white">{session.workoutNameSnapshot}</h2>
		</div>

		<span
			class="inline-flex items-center gap-2 rounded-full bg-white/[0.05] px-3 py-1 text-xs font-medium text-zinc-200"
		>
			<Icon name={getStatusIconName()} class={`h-3.5 w-3.5 ${getStatusIconTone()}`} />
			{formatSessionStatus(session.status)}
		</span>
	</div>

	<div class="mt-4 grid grid-cols-3 gap-3 border-t border-white/10 pt-4">
		<div>
			<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Time</p>
			<p class="mt-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
				<Icon name="clock-3" class="h-4 w-4 text-zinc-500" />
				{isPlanned ? 'Not started' : formatDuration(session.startedAt, session.completedAt, nowMs)}
			</p>
		</div>
		<div>
			<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Exercises</p>
			<p class="mt-2 text-sm font-medium text-zinc-200">{session.totalExercises}</p>
		</div>
		<div>
			<p class="text-xs font-medium tracking-[0.16em] text-zinc-500 uppercase">Sets</p>
			<p class="mt-2 text-sm font-medium text-zinc-200">{session.totalSets}</p>
		</div>
	</div>

	<div class="mt-4 flex gap-2">
		<a
			class="flex min-h-11 flex-1 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] px-4 text-sm font-semibold text-white"
			href={resolve('/(app)/sessions/[sessionId]', { sessionId: session.id })}
		>
			Open session
		</a>

		{#if isPlanned && onStart}
			<button
				class="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
				type="button"
				disabled={isBusy}
				onclick={onStart}
			>
				Start
			</button>
		{/if}
	</div>
</article>
