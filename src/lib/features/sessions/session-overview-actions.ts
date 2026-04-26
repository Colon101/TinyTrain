import { writable } from 'svelte/store';
import type { SessionStatus } from '$lib/db';

export type SessionOverviewActions = {
	status: SessionStatus;
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
