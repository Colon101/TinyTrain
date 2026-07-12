import { writable } from 'svelte/store';
import type { SessionOverview, SessionStatus } from '$lib/db';

export type SessionOverviewTimerSummary = Pick<
	SessionOverview['summary'],
	'id' | 'status' | 'startedAt' | 'completedAt' | 'workoutNameSnapshot' | 'dayKey'
>;

export const SESSION_EDIT_DRAFT_PREFIX = 'tinytrain:session-edit-draft:';
export const SESSION_EDIT_DISCARD_MESSAGE =
	'Discard your edit mode changes? Unsaved time changes will be lost.';

export type SessionEditDraft = {
	startedAt: string;
	completedAt: string;
};

export function getSessionEditDraftKey(sessionId: string) {
	return `${SESSION_EDIT_DRAFT_PREFIX}${sessionId}`;
}

export function readSessionEditDraft(sessionId: string): SessionEditDraft | null {
	try {
		const rawDraft = globalThis.localStorage?.getItem(getSessionEditDraftKey(sessionId)) ?? null;
		const parsedDraft = rawDraft ? (JSON.parse(rawDraft) as Partial<SessionEditDraft>) : null;

		if (
			parsedDraft &&
			typeof parsedDraft.startedAt === 'string' &&
			typeof parsedDraft.completedAt === 'string'
		) {
			return {
				startedAt: parsedDraft.startedAt,
				completedAt: parsedDraft.completedAt
			};
		}
	} catch {
		clearSessionEditDraft(sessionId);
	}

	return null;
}

export function writeSessionEditDraft(sessionId: string, draft: SessionEditDraft) {
	try {
		globalThis.localStorage?.setItem(getSessionEditDraftKey(sessionId), JSON.stringify(draft));
	} catch {
		// Optional edit-draft persistence must not block saving or leaving edit mode.
	}
}

export function clearSessionEditDraft(sessionId: string) {
	try {
		globalThis.localStorage?.removeItem(getSessionEditDraftKey(sessionId));
	} catch {
		// Optional edit-draft cleanup must not block the underlying action.
	}
}

export type SessionOverviewActions = {
	status: SessionStatus;
	timerSummary: SessionOverviewTimerSummary;
	isEditMode: boolean;
	canEditSession: boolean;
	canEditTime: boolean;
	hasUnsavedChanges: boolean;
	isSaving: boolean;
	isSharingSession: boolean;
	onEnterEditMode: () => void;
	onSaveEditMode: () => void | Promise<void>;
	onDiscardEditMode: () => void | Promise<void>;
	onOpenTimeEditor: () => void;
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
