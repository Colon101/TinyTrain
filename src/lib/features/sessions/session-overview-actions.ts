import { writable } from 'svelte/store';
import type { SessionOverview, SessionStatus } from '$lib/db';

export type SessionOverviewTimerSummary = Pick<
	SessionOverview['summary'],
	'id' | 'status' | 'startedAt' | 'completedAt' | 'workoutNameSnapshot' | 'dayKey'
>;

export type SessionOverviewActions = {
	status: SessionStatus;
	timerSummary: SessionOverviewTimerSummary;
	isSaving: boolean;
	isSharingSession: boolean;
	onShareSession: () => void | Promise<void>;
	onEndSession: () => void;
	onResetSession: () => void;
	onDeleteSession: () => void;
};

export const sessionOverviewActions = writable<SessionOverviewActions | null>(null);

export function setSessionOverviewActions(actions: SessionOverviewActions) {
	sessionOverviewActions.set(actions);
}

export function clearSessionOverviewActions() {
	sessionOverviewActions.set(null);
}
