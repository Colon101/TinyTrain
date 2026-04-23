import type { SessionStatus } from '$lib/db';

function pluralize(value: number, label: string) {
	return `${value} ${label}${value === 1 ? '' : 's'}`;
}

function isValidDate(date: Date) {
	return !Number.isNaN(date.getTime());
}

export function formatTimestamp(value?: string | null) {
	if (!value) {
		return 'Unknown time';
	}

	const date = new Date(value);

	if (!isValidDate(date)) {
		return 'Unknown time';
	}

	return date.toLocaleString();
}

export function formatDuration(startedAt: string, completedAt?: string, nowMs = Date.now()) {
	const startMs = new Date(startedAt).getTime();
	const endMs = completedAt ? new Date(completedAt).getTime() : nowMs;

	if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
		return '0m';
	}

	const totalSeconds = Math.max(Math.round((endMs - startMs) / 1000), 0);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	}

	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
	}

	return `${seconds}s`;
}

export function formatDayHeading(dayKey?: string | null) {
	if (!dayKey) {
		return 'Selected day';
	}

	const date = new Date(`${dayKey}T12:00:00`);

	if (!isValidDate(date)) {
		return 'Selected day';
	}

	return new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	}).format(date);
}

export function formatMonthHeading(date?: Date | null) {
	const safeDate = date instanceof Date && isValidDate(date) ? date : new Date();

	return new Intl.DateTimeFormat('en-US', {
		month: 'long',
		year: 'numeric'
	}).format(safeDate);
}

export function formatSessionTime(startedAt?: string | null) {
	if (!startedAt) {
		return '--:--';
	}

	const date = new Date(startedAt);

	if (!isValidDate(date)) {
		return '--:--';
	}

	return new Intl.DateTimeFormat('en-US', {
		hour: 'numeric',
		minute: '2-digit'
	}).format(date);
}

export function formatSessionStatus(status: SessionStatus) {
	switch (status) {
		case 'completed':
			return 'Done';
		case 'in_progress':
			return 'Running';
		case 'abandoned':
			return 'Abandoned';
		default:
			return 'Planned';
	}
}

export function formatSetLine(weight?: number, reps?: number, rir?: number) {
	const parts: string[] = [];

	if (typeof weight === 'number' && Number.isFinite(weight)) {
		parts.push(`${weight} kg`);
	}

	if (typeof reps === 'number' && Number.isFinite(reps)) {
		parts.push(`${reps} reps`);
	}

	if (typeof rir === 'number' && Number.isFinite(rir)) {
		parts.push(`RIR ${rir}`);
	}

	return parts.join(' x ') || 'Set logged';
}

export function formatHistoryCount(count: number) {
	return pluralize(count, 'session');
}
