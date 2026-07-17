import { writable } from 'svelte/store';
import type { SessionOverview, SessionStatus } from '$lib/db';
import { getResolvedAuthOwnerId, type AuthOwnedStateIdentity } from '$lib/auth-owned-state';

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
	const ownerId = getResolvedAuthOwnerId();

	return ownerId ? `${SESSION_EDIT_DRAFT_PREFIX}${encodeURIComponent(ownerId)}:${sessionId}` : null;
}

export function getLegacySessionEditDraftKey(sessionId: string) {
	return `${SESSION_EDIT_DRAFT_PREFIX}${sessionId}`;
}

function parseSessionEditDraft(rawDraft: string | null): SessionEditDraft | null {
	try {
		const parsedDraft = rawDraft ? (JSON.parse(rawDraft) as Partial<SessionEditDraft>) : null;

		return parsedDraft &&
			typeof parsedDraft.startedAt === 'string' &&
			typeof parsedDraft.completedAt === 'string'
			? { startedAt: parsedDraft.startedAt, completedAt: parsedDraft.completedAt }
			: null;
	} catch {
		return null;
	}
}

export function readSessionEditDraft(sessionId: string): SessionEditDraft | null {
	try {
		const draftKey = getSessionEditDraftKey(sessionId);

		if (!draftKey) {
			return null;
		}

		return parseSessionEditDraft(globalThis.localStorage?.getItem(draftKey) ?? null);
	} catch {
		clearSessionEditDraft(sessionId);
	}

	return null;
}

/** Claims the old unscoped recovery copy only after the current user's DB confirms the session. */
export function migrateLegacySessionEditDraftForCurrentUser(sessionId: string) {
	const draftKey = getSessionEditDraftKey(sessionId);

	if (!draftKey) {
		return false;
	}

	try {
		if (parseSessionEditDraft(globalThis.localStorage?.getItem(draftKey) ?? null)) {
			return false;
		}

		const legacyKey = getLegacySessionEditDraftKey(sessionId);
		const legacyDraft = parseSessionEditDraft(globalThis.localStorage?.getItem(legacyKey) ?? null);

		if (!legacyDraft) {
			return false;
		}

		globalThis.localStorage?.setItem(draftKey, JSON.stringify(legacyDraft));
		globalThis.localStorage?.removeItem(legacyKey);
		return true;
	} catch {
		return false;
	}
}

export function writeSessionEditDraft(sessionId: string, draft: SessionEditDraft) {
	try {
		const draftKey = getSessionEditDraftKey(sessionId);

		if (draftKey) {
			globalThis.localStorage?.setItem(draftKey, JSON.stringify(draft));
		}
	} catch {
		// Optional edit-draft persistence must not block saving or leaving edit mode.
	}
}

export function clearSessionEditDraft(sessionId: string) {
	try {
		const draftKey = getSessionEditDraftKey(sessionId);

		if (draftKey) {
			globalThis.localStorage?.removeItem(draftKey);
		}
	} catch {
		// Optional edit-draft cleanup must not block the underlying action.
	}
}

export type SessionOverviewActions = {
	ownerIdentity: AuthOwnedStateIdentity;
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
