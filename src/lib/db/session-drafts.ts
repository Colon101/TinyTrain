import { browser } from '$app/environment';
import { getResolvedAuthOwnerId } from '$lib/auth-owned-state';
import type { SessionInputField } from './models';

export type SessionInputFieldKey = `${SessionInputField}Input`;
export type SessionInputFieldBaseKey = `${SessionInputFieldKey}Base`;
export type SessionInputFieldIntentAtKey = `${SessionInputFieldKey}IntentAt`;
export type SessionInputFieldVersionKey = `${SessionInputFieldKey}Version`;
export const SESSION_INPUT_INTENT_MAX_FUTURE_MS = 1_000;

export type SessionInputDraftSet = Partial<
	Record<SessionInputFieldKey | SessionInputFieldBaseKey | SessionInputFieldVersionKey, string> &
		Record<SessionInputFieldIntentAtKey, number>
> & { updatedAt?: number };

export type SessionInputDraft = {
	sessionId: string;
	sets: Record<string, SessionInputDraftSet>;
	updatedAt: number;
};

export type SessionInputDraftFieldVersionSnapshot = {
	sessionSetId: string;
	field: SessionInputField;
	fieldVersion: string | null;
	rawValue: string;
	baseValue: string | null;
	intentAt: number | null;
};

export type SessionInputDraftVersionSnapshot = {
	sessionId: string;
	ownerId: string | null;
	scope: 'all' | 'sets';
	sessionSetIds: string[];
	fields: SessionInputDraftFieldVersionSnapshot[];
	draft: SessionInputDraft | null;
};

export type WriteSessionInputDraftFieldOptions = {
	sessionId: string;
	sessionSetId: string;
	field: SessionInputField;
	rawValue: string;
	baseValue?: string;
};

export type SessionInputDraftFieldWrite = {
	draft: SessionInputDraft;
	ownerId: string | null;
	fieldVersion: string;
	intentAt: number;
	baseValue: string;
	persisted: boolean;
	replacedField: { fieldVersion: string | null; rawValue: string } | null;
};

export type SessionInputDraftFieldClear = {
	draft: SessionInputDraft;
	cleared: boolean;
};

type SessionInputDraftFieldJournalEntry = {
	kind: 'field';
	sessionId: string;
	sessionSetId: string;
	field: SessionInputField;
	rawValue: string;
	baseValue?: string;
	intentAt: number;
	fieldVersion: string;
};

type SessionInputDraftClearJournalEntry = {
	kind: 'clear';
	sessionId: string;
	sessionSetId: string;
	field: SessionInputField;
	clearBeforeIntentAt: number;
	clearedIdentities: string[];
};

type SessionInputDraftRemovedSetJournalEntry = {
	kind: 'remove-set';
	sessionId: string;
	sessionSetId: string;
};

type SessionInputDraftJournalEntry =
	| SessionInputDraftFieldJournalEntry
	| SessionInputDraftClearJournalEntry
	| SessionInputDraftRemovedSetJournalEntry;

type SessionInputDraftFieldCandidate = {
	sessionSetId: string;
	field: SessionInputField;
	rawValue: string;
	baseValue: string | undefined;
	hasBaseValue: boolean;
	intentAt: number;
	hasIntentAt: boolean;
	fieldVersion: string | null;
	identity: string;
	storageKey: string | null;
};

type SessionInputDraftClearState = {
	clearBeforeIntentAt: number;
	clearedIdentities: Set<string>;
	storageKeys: string[];
};

type SessionInputDraftStorageState = {
	aggregateDraft: SessionInputDraft | null;
	draft: SessionInputDraft | null;
	candidatesBySlot: Map<string, SessionInputDraftFieldCandidate[]>;
	clearBySlot: Map<string, SessionInputDraftClearState>;
	journalEntries: Array<{ key: string; entry: SessionInputDraftJournalEntry }>;
};

export const SESSION_INPUT_DRAFT_CHANGE_EVENT = 'tinytrain:session-input-draft-change';
const SESSION_INPUT_DRAFT_PREFIX = 'tinytrain:session-input-draft:';
const SESSION_INPUT_DRAFT_JOURNAL_PREFIX = 'tinytrain:session-input-draft-journal:';
const SESSION_INPUT_DRAFT_MIGRATION_PREFIX = 'tinytrain:session-input-draft-migrated:';
const SESSION_INPUT_FIELDS = [
	'weight',
	'reps',
	'rir'
] as const satisfies readonly SessionInputField[];
const SESSION_INPUT_DRAFT_SET_STRING_KEYS = [
	'weightInput',
	'weightInputBase',
	'weightInputVersion',
	'repsInput',
	'repsInputBase',
	'repsInputVersion',
	'rirInput',
	'rirInputBase',
	'rirInputVersion'
] as const satisfies readonly (
	| SessionInputFieldKey
	| SessionInputFieldBaseKey
	| SessionInputFieldVersionKey
)[];
const SESSION_INPUT_DRAFT_SET_NUMBER_KEYS = [
	'weightInputIntentAt',
	'repsInputIntentAt',
	'rirInputIntentAt'
] as const satisfies readonly SessionInputFieldIntentAtKey[];
let draftFieldVersionSequence = 0;
const sessionInputDraftSnapshotOwners = new WeakMap<SessionInputDraft, string>();

function notifySessionInputDraftChange(sessionId: string) {
	window.dispatchEvent(
		new CustomEvent(SESSION_INPUT_DRAFT_CHANGE_EVENT, { detail: { sessionId } })
	);
}

function notifySessionInputDraftChangeSafely(sessionId: string) {
	try {
		notifySessionInputDraftChange(sessionId);
	} catch {
		// Persistence is still durable when a synchronous listener fails.
	}
}

export function getSessionInputDraftKey(sessionId: string) {
	const ownerId = getResolvedAuthOwnerId();

	return ownerId
		? `${SESSION_INPUT_DRAFT_PREFIX}${encodeURIComponent(ownerId)}:${sessionId}`
		: getLegacySessionInputDraftKey(sessionId);
}

export function getLegacySessionInputDraftKey(sessionId: string) {
	return `${SESSION_INPUT_DRAFT_PREFIX}${sessionId}`;
}

function getSessionInputDraftKeyForOwner(ownerId: string, sessionId: string) {
	return `${SESSION_INPUT_DRAFT_PREFIX}${encodeURIComponent(ownerId)}:${sessionId}`;
}

function getSessionInputDraftJournalPrefix(ownerId: string, sessionId: string) {
	return `${SESSION_INPUT_DRAFT_JOURNAL_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(
		sessionId
	)}:`;
}

function getLegacySessionInputDraftJournalPrefix(sessionId: string) {
	return `${SESSION_INPUT_DRAFT_JOURNAL_PREFIX}${encodeURIComponent(sessionId)}:`;
}

function getSessionInputDraftMigrationKey(ownerId: string, sessionId: string) {
	return `${SESSION_INPUT_DRAFT_MIGRATION_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(
		sessionId
	)}`;
}

export function isSessionInputDraftStorageKey(sessionId: string, storageKey: string | null) {
	const ownerId = getResolvedAuthOwnerId();

	if (!ownerId) {
		return false;
	}

	return (
		storageKey === getSessionInputDraftKeyForOwner(ownerId, sessionId) ||
		Boolean(storageKey?.startsWith(getSessionInputDraftJournalPrefix(ownerId, sessionId)))
	);
}

function getSessionInputDraftFieldKeys(field: SessionInputField) {
	const fieldKey = `${field}Input` as SessionInputFieldKey;

	return {
		fieldKey,
		baseKey: `${fieldKey}Base` as SessionInputFieldBaseKey,
		intentAtKey: `${fieldKey}IntentAt` as SessionInputFieldIntentAtKey,
		versionKey: `${fieldKey}Version` as SessionInputFieldVersionKey
	};
}

function getSessionInputDraftFieldSlot(sessionSetId: string, field: SessionInputField) {
	return `${sessionSetId}\u0000${field}`;
}

function createSessionInputDraftFieldVersion() {
	draftFieldVersionSequence += 1;
	const randomPart = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

	return `${Date.now().toString(36)}-${draftFieldVersionSequence.toString(36)}-${randomPart}`;
}

function getSessionInputDraftFieldJournalKey(
	ownerId: string,
	entry: SessionInputDraftFieldJournalEntry
) {
	return `${getSessionInputDraftJournalPrefix(ownerId, entry.sessionId)}field:${encodeURIComponent(
		entry.sessionSetId
	)}:${entry.field}:${encodeURIComponent(entry.fieldVersion)}`;
}

function getSessionInputDraftClearJournalKey(
	ownerId: string,
	entry: SessionInputDraftClearJournalEntry
) {
	return `${getSessionInputDraftJournalPrefix(ownerId, entry.sessionId)}clear:${encodeURIComponent(
		entry.sessionSetId
	)}:${entry.field}:${encodeURIComponent(createSessionInputDraftFieldVersion())}`;
}

function getSessionInputDraftRemovedSetJournalKey(
	ownerId: string,
	entry: SessionInputDraftRemovedSetJournalEntry
) {
	return `${getSessionInputDraftJournalPrefix(ownerId, entry.sessionId)}remove-set:${encodeURIComponent(
		entry.sessionSetId
	)}:${encodeURIComponent(createSessionInputDraftFieldVersion())}`;
}

export function createEmptySessionInputDraft(sessionId: string): SessionInputDraft {
	return {
		sessionId,
		sets: {},
		updatedAt: Date.now()
	};
}

export function isSessionInputDraftSet(value: unknown): value is SessionInputDraftSet {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	const hasValidStringFields = SESSION_INPUT_DRAFT_SET_STRING_KEYS.every(
		(key) => !Object.hasOwn(candidate, key) || typeof candidate[key] === 'string'
	);
	const hasValidUpdatedAt =
		!Object.hasOwn(candidate, 'updatedAt') ||
		(typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt));
	const hasValidIntentTimes = SESSION_INPUT_DRAFT_SET_NUMBER_KEYS.every(
		(key) =>
			!Object.hasOwn(candidate, key) ||
			(typeof candidate[key] === 'number' && Number.isFinite(candidate[key]))
	);

	return hasValidStringFields && hasValidUpdatedAt && hasValidIntentTimes;
}

function readAggregateSessionInputDraftAtKey(sessionId: string, storageKey: string) {
	try {
		const rawDraft = localStorage.getItem(storageKey);
		const draft = rawDraft ? (JSON.parse(rawDraft) as Partial<SessionInputDraft>) : null;

		if (
			!draft ||
			draft.sessionId !== sessionId ||
			!draft.sets ||
			typeof draft.sets !== 'object' ||
			Array.isArray(draft.sets)
		) {
			return null;
		}

		const sets = Object.fromEntries(
			Object.entries(draft.sets).filter((entry): entry is [string, SessionInputDraftSet] =>
				isSessionInputDraftSet(entry[1])
			)
		);

		return {
			sessionId,
			sets,
			updatedAt:
				typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt)
					? draft.updatedAt
					: Date.now()
		};
	} catch {
		return null;
	}
}

function readAggregateSessionInputDraft(sessionId: string, ownerId: string) {
	return readAggregateSessionInputDraftAtKey(
		sessionId,
		getSessionInputDraftKeyForOwner(ownerId, sessionId)
	);
}

function listStorageKeysWithPrefix(prefix: string) {
	try {
		if (typeof localStorage.key !== 'function' || typeof localStorage.length !== 'number') {
			return [];
		}

		const keys: string[] = [];

		for (let index = 0; index < localStorage.length; index += 1) {
			const key = localStorage.key(index);

			if (key?.startsWith(prefix)) {
				keys.push(key);
			}
		}

		return keys;
	} catch {
		return [];
	}
}

function listSessionInputDraftJournalKeys(sessionId: string, ownerId: string) {
	return listStorageKeysWithPrefix(getSessionInputDraftJournalPrefix(ownerId, sessionId));
}

function isSessionInputField(value: unknown): value is SessionInputField {
	return value === 'weight' || value === 'reps' || value === 'rir';
}

function parseSessionInputDraftJournalEntry(
	rawValue: string,
	sessionId: string
): SessionInputDraftJournalEntry | null {
	try {
		const entry = JSON.parse(rawValue) as Record<string, unknown>;

		if (!entry || entry.sessionId !== sessionId || typeof entry.sessionSetId !== 'string') {
			return null;
		}

		if (entry.kind === 'remove-set') {
			return { kind: 'remove-set', sessionId, sessionSetId: entry.sessionSetId };
		}

		if (!isSessionInputField(entry.field)) {
			return null;
		}

		if (
			entry.kind === 'field' &&
			typeof entry.rawValue === 'string' &&
			(entry.baseValue === undefined || typeof entry.baseValue === 'string') &&
			typeof entry.intentAt === 'number' &&
			Number.isFinite(entry.intentAt) &&
			typeof entry.fieldVersion === 'string'
		) {
			return {
				kind: 'field',
				sessionId,
				sessionSetId: entry.sessionSetId,
				field: entry.field,
				rawValue: entry.rawValue,
				...(typeof entry.baseValue === 'string' ? { baseValue: entry.baseValue } : {}),
				intentAt: entry.intentAt,
				fieldVersion: entry.fieldVersion
			};
		}

		if (
			entry.kind === 'clear' &&
			typeof entry.clearBeforeIntentAt === 'number' &&
			Number.isFinite(entry.clearBeforeIntentAt) &&
			Array.isArray(entry.clearedIdentities) &&
			entry.clearedIdentities.every((identity) => typeof identity === 'string')
		) {
			return {
				kind: 'clear',
				sessionId,
				sessionSetId: entry.sessionSetId,
				field: entry.field,
				clearBeforeIntentAt: entry.clearBeforeIntentAt,
				clearedIdentities: entry.clearedIdentities
			};
		}
	} catch {
		// Ignore malformed optional recovery data.
	}

	return null;
}

function readSessionInputDraftJournalEntries(sessionId: string, ownerId: string) {
	const entries: Array<{ key: string; entry: SessionInputDraftJournalEntry }> = [];

	for (const key of listSessionInputDraftJournalKeys(sessionId, ownerId)) {
		try {
			const rawEntry = localStorage.getItem(key);
			const entry = rawEntry ? parseSessionInputDraftJournalEntry(rawEntry, sessionId) : null;

			if (entry) {
				entries.push({ key, entry });
			}
		} catch {
			// One inaccessible journal entry must not hide the rest of the draft.
		}
	}

	return entries;
}

function getSessionInputDraftFieldIdentity(
	sessionSetId: string,
	field: SessionInputField,
	rawValue: string,
	baseValue: string | undefined,
	intentAt: number,
	fieldVersion: string | null
) {
	return fieldVersion
		? `version:${fieldVersion}`
		: `legacy:${JSON.stringify([sessionSetId, field, rawValue, baseValue ?? null, intentAt])}`;
}

function compareSessionInputDraftFieldCandidates(
	first: SessionInputDraftFieldCandidate,
	second: SessionInputDraftFieldCandidate
) {
	return first.intentAt - second.intentAt || first.identity.localeCompare(second.identity);
}

function isCandidateCleared(
	candidate: SessionInputDraftFieldCandidate,
	clearState: SessionInputDraftClearState | undefined
) {
	return Boolean(
		clearState &&
		(candidate.intentAt < clearState.clearBeforeIntentAt ||
			clearState.clearedIdentities.has(candidate.identity))
	);
}

function readSessionInputDraftStorageState(
	sessionId: string,
	ownerId: string
): SessionInputDraftStorageState {
	const aggregateDraft = readAggregateSessionInputDraft(sessionId, ownerId);
	const journalEntries = readSessionInputDraftJournalEntries(sessionId, ownerId);
	const removedSessionSetIds = new Set(
		journalEntries.flatMap(({ entry }) => (entry.kind === 'remove-set' ? [entry.sessionSetId] : []))
	);
	const candidatesBySlot = new Map<string, SessionInputDraftFieldCandidate[]>();
	const clearBySlot = new Map<string, SessionInputDraftClearState>();

	function addCandidate(candidate: SessionInputDraftFieldCandidate) {
		if (removedSessionSetIds.has(candidate.sessionSetId)) {
			return;
		}

		const slot = getSessionInputDraftFieldSlot(candidate.sessionSetId, candidate.field);
		const candidates = candidatesBySlot.get(slot) ?? [];
		const duplicateIndex = candidates.findIndex(
			(existingCandidate) => existingCandidate.identity === candidate.identity
		);

		if (duplicateIndex >= 0) {
			if (candidate.storageKey) {
				candidates[duplicateIndex] = candidate;
			}
		} else {
			candidates.push(candidate);
		}

		candidatesBySlot.set(slot, candidates);
	}

	for (const { key, entry } of journalEntries) {
		if (entry.kind !== 'clear' || removedSessionSetIds.has(entry.sessionSetId)) {
			continue;
		}

		const slot = getSessionInputDraftFieldSlot(entry.sessionSetId, entry.field);
		const currentClear = clearBySlot.get(slot) ?? {
			clearBeforeIntentAt: Number.NEGATIVE_INFINITY,
			clearedIdentities: new Set<string>(),
			storageKeys: []
		};
		currentClear.clearBeforeIntentAt = Math.max(
			currentClear.clearBeforeIntentAt,
			entry.clearBeforeIntentAt
		);
		entry.clearedIdentities.forEach((identity) => currentClear.clearedIdentities.add(identity));
		currentClear.storageKeys.push(key);
		clearBySlot.set(slot, currentClear);
	}

	for (const [sessionSetId, draftSet] of Object.entries(aggregateDraft?.sets ?? {})) {
		if (removedSessionSetIds.has(sessionSetId)) {
			continue;
		}

		for (const field of SESSION_INPUT_FIELDS) {
			const { fieldKey, baseKey, intentAtKey, versionKey } = getSessionInputDraftFieldKeys(field);

			if (!Object.hasOwn(draftSet, fieldKey)) {
				continue;
			}

			const rawValue = draftSet[fieldKey] ?? '';
			const baseValue = draftSet[baseKey];
			const intentAt = draftSet[intentAtKey] ?? draftSet.updatedAt ?? aggregateDraft!.updatedAt;
			const fieldVersion = draftSet[versionKey] ?? null;
			addCandidate({
				sessionSetId,
				field,
				rawValue,
				baseValue,
				hasBaseValue: Object.hasOwn(draftSet, baseKey),
				intentAt,
				hasIntentAt: Object.hasOwn(draftSet, intentAtKey),
				fieldVersion,
				identity: getSessionInputDraftFieldIdentity(
					sessionSetId,
					field,
					rawValue,
					baseValue,
					intentAt,
					fieldVersion
				),
				storageKey: null
			});
		}
	}

	for (const { key, entry } of journalEntries) {
		if (entry.kind !== 'field') {
			continue;
		}

		addCandidate({
			sessionSetId: entry.sessionSetId,
			field: entry.field,
			rawValue: entry.rawValue,
			baseValue: entry.baseValue,
			hasBaseValue: entry.baseValue !== undefined,
			intentAt: entry.intentAt,
			hasIntentAt: true,
			fieldVersion: entry.fieldVersion,
			identity: getSessionInputDraftFieldIdentity(
				entry.sessionSetId,
				entry.field,
				entry.rawValue,
				entry.baseValue,
				entry.intentAt,
				entry.fieldVersion
			),
			storageKey: key
		});
	}

	const nextSets = Object.fromEntries(
		Object.entries(aggregateDraft?.sets ?? {})
			.filter(([sessionSetId]) => !removedSessionSetIds.has(sessionSetId))
			.map(([sessionSetId, draftSet]) => [sessionSetId, { ...draftSet }])
	);
	const allSlots = new Set([...candidatesBySlot.keys(), ...clearBySlot.keys()]);
	let latestUpdatedAt = aggregateDraft?.updatedAt ?? Number.NEGATIVE_INFINITY;

	for (const slot of allSlots) {
		const candidates = candidatesBySlot.get(slot) ?? [];
		const [firstCandidate] = candidates;

		if (!firstCandidate) {
			continue;
		}

		const { sessionSetId, field } = firstCandidate;
		const { fieldKey, baseKey, intentAtKey, versionKey } = getSessionInputDraftFieldKeys(field);
		const clearState = clearBySlot.get(slot);
		const winner = candidates
			.filter((candidate) => !isCandidateCleared(candidate, clearState))
			.toSorted(compareSessionInputDraftFieldCandidates)
			.at(-1);
		const nextSet = nextSets[sessionSetId] ?? {};

		if (!winner) {
			delete nextSet[fieldKey];
			delete nextSet[baseKey];
			delete nextSet[intentAtKey];
			delete nextSet[versionKey];
		} else {
			nextSet[fieldKey] = winner.rawValue;

			if (winner.hasBaseValue) {
				nextSet[baseKey] = winner.baseValue ?? '';
			} else {
				delete nextSet[baseKey];
			}

			if (winner.hasIntentAt) {
				nextSet[intentAtKey] = winner.intentAt;
			} else {
				delete nextSet[intentAtKey];
			}

			if (winner.fieldVersion) {
				nextSet[versionKey] = winner.fieldVersion;
			} else {
				delete nextSet[versionKey];
			}

			if (winner.storageKey) {
				nextSet.updatedAt = Math.max(nextSet.updatedAt ?? winner.intentAt, winner.intentAt);
			}

			latestUpdatedAt = Math.max(latestUpdatedAt, winner.intentAt);
		}

		if (SESSION_INPUT_FIELDS.some((nextField) => Object.hasOwn(nextSet, `${nextField}Input`))) {
			nextSets[sessionSetId] = nextSet;
		} else {
			delete nextSets[sessionSetId];
		}
	}

	const draft =
		Object.keys(nextSets).length > 0
			? {
					sessionId,
					sets: nextSets,
					updatedAt: Number.isFinite(latestUpdatedAt) ? latestUpdatedAt : Date.now()
				}
			: null;

	return { aggregateDraft, draft, candidatesBySlot, clearBySlot, journalEntries };
}

export function readSessionInputDraft(sessionId: string, expectedOwnerId?: string) {
	const ownerId = expectedOwnerId ?? getResolvedAuthOwnerId();

	if (!browser || !ownerId) {
		return null;
	}

	const draft = readSessionInputDraftStorageState(sessionId, ownerId).draft;

	if (draft) {
		sessionInputDraftSnapshotOwners.set(draft, ownerId);
	}

	return draft;
}

function listSessionInputDraftFieldVersions(
	draft: SessionInputDraft | null,
	sessionSetIds?: string[]
) {
	const sessionSetIdSet = sessionSetIds ? new Set(sessionSetIds) : null;
	const fields: SessionInputDraftFieldVersionSnapshot[] = [];

	for (const [sessionSetId, draftSet] of Object.entries(draft?.sets ?? {})) {
		if (sessionSetIdSet && !sessionSetIdSet.has(sessionSetId)) {
			continue;
		}

		for (const field of SESSION_INPUT_FIELDS) {
			const { fieldKey, baseKey, intentAtKey, versionKey } = getSessionInputDraftFieldKeys(field);

			if (!Object.hasOwn(draftSet, fieldKey)) {
				continue;
			}

			fields.push({
				sessionSetId,
				field,
				fieldVersion: draftSet[versionKey] ?? null,
				rawValue: draftSet[fieldKey] ?? '',
				baseValue: Object.hasOwn(draftSet, baseKey) ? (draftSet[baseKey] ?? '') : null,
				intentAt: Object.hasOwn(draftSet, intentAtKey) ? (draftSet[intentAtKey] ?? null) : null
			});
		}
	}

	return fields.toSorted(
		(first, second) =>
			first.sessionSetId.localeCompare(second.sessionSetId) ||
			SESSION_INPUT_FIELDS.indexOf(first.field) - SESSION_INPUT_FIELDS.indexOf(second.field)
	);
}

export function captureSessionInputDraftVersionSnapshot(
	sessionId: string,
	sessionSetIds?: string[],
	expectedOwnerId?: string
): SessionInputDraftVersionSnapshot {
	const ownerId = expectedOwnerId ?? getResolvedAuthOwnerId();
	const normalizedSessionSetIds = sessionSetIds ? [...new Set(sessionSetIds)].toSorted() : [];
	const draft = browser && ownerId ? readSessionInputDraft(sessionId, ownerId) : null;

	return {
		sessionId,
		ownerId: browser ? ownerId : null,
		scope: sessionSetIds ? 'sets' : 'all',
		sessionSetIds: normalizedSessionSetIds,
		fields: listSessionInputDraftFieldVersions(
			draft,
			sessionSetIds ? normalizedSessionSetIds : undefined
		),
		draft
	};
}

export function sessionInputDraftVersionSnapshotMatches(
	snapshot: SessionInputDraftVersionSnapshot,
	expectedOwnerId?: string
) {
	if (expectedOwnerId !== undefined && snapshot.ownerId !== expectedOwnerId) {
		return false;
	}

	const current = captureSessionInputDraftVersionSnapshot(
		snapshot.sessionId,
		snapshot.scope === 'sets' ? snapshot.sessionSetIds : undefined,
		expectedOwnerId
	);

	return (
		current.ownerId === snapshot.ownerId &&
		JSON.stringify(current.fields) === JSON.stringify(snapshot.fields)
	);
}

export function finalizeSessionInputDraftSetsIfUnchanged(
	snapshot: SessionInputDraftVersionSnapshot,
	sessionSetIds: string[],
	expectedOwnerId?: string
) {
	if (!snapshot.draft) {
		return (expectedOwnerId ?? getResolvedAuthOwnerId()) === snapshot.ownerId;
	}

	const removedSessionSetIds = new Set(sessionSetIds);
	const nextSets = Object.fromEntries(
		Object.entries(snapshot.draft.sets).filter(
			([sessionSetId]) => !removedSessionSetIds.has(sessionSetId)
		)
	);
	const nextDraft = Object.keys(nextSets).length > 0 ? { ...snapshot.draft, sets: nextSets } : null;

	return finalizeSessionInputDraftIfUnchanged(snapshot.draft, nextDraft, expectedOwnerId);
}

/**
 * Claims pre-owner draft storage only after the active user's database has returned this session.
 * Each legacy event is copied to the owner's immutable journal before its unscoped key is removed.
 */
export function migrateLegacySessionInputDraftForCurrentUser(sessionId: string) {
	const ownerId = getResolvedAuthOwnerId();

	if (!browser || !ownerId) {
		return false;
	}

	const migrationKey = getSessionInputDraftMigrationKey(ownerId, sessionId);

	try {
		if (localStorage.getItem(migrationKey) === '1') {
			return false;
		}
	} catch {
		return false;
	}

	let migrated = false;
	let migrationFailed = false;
	const legacyAggregateKey = getLegacySessionInputDraftKey(sessionId);
	const legacyAggregate = readAggregateSessionInputDraftAtKey(sessionId, legacyAggregateKey);

	if (legacyAggregate) {
		let aggregateMigrated = true;

		for (const [sessionSetId, draftSet] of Object.entries(legacyAggregate.sets)) {
			for (const field of SESSION_INPUT_FIELDS) {
				const { fieldKey, baseKey, intentAtKey, versionKey } = getSessionInputDraftFieldKeys(field);

				if (!Object.hasOwn(draftSet, fieldKey)) {
					continue;
				}

				const entry: SessionInputDraftFieldJournalEntry = {
					kind: 'field',
					sessionId,
					sessionSetId,
					field,
					rawValue: draftSet[fieldKey] ?? '',
					...(Object.hasOwn(draftSet, baseKey) ? { baseValue: draftSet[baseKey] ?? '' } : {}),
					intentAt: draftSet[intentAtKey] ?? draftSet.updatedAt ?? legacyAggregate.updatedAt,
					fieldVersion:
						draftSet[versionKey] ??
						`legacy-aggregate:${legacyAggregate.updatedAt}:${sessionSetId}:${field}`
				};
				aggregateMigrated =
					writeJournalEntry(getSessionInputDraftFieldJournalKey(ownerId, entry), entry) &&
					aggregateMigrated;
			}
		}

		if (aggregateMigrated) {
			removeStorageKeysBestEffort([legacyAggregateKey]);
			migrated = true;
		} else {
			migrationFailed = true;
		}
	}

	const legacyJournalPrefix = getLegacySessionInputDraftJournalPrefix(sessionId);
	const legacyJournalKeys = listStorageKeysWithPrefix(legacyJournalPrefix).filter((key) => {
		const suffix = key.slice(legacyJournalPrefix.length);

		return (
			suffix.startsWith('field:') || suffix.startsWith('clear:') || suffix.startsWith('remove-set:')
		);
	});

	for (const legacyKey of legacyJournalKeys) {
		try {
			const rawEntry = localStorage.getItem(legacyKey);
			const entry = rawEntry ? parseSessionInputDraftJournalEntry(rawEntry, sessionId) : null;

			if (!entry) {
				continue;
			}

			const ownedKey =
				entry.kind === 'field'
					? getSessionInputDraftFieldJournalKey(ownerId, entry)
					: entry.kind === 'clear'
						? getSessionInputDraftClearJournalKey(ownerId, entry)
						: getSessionInputDraftRemovedSetJournalKey(ownerId, entry);

			if (writeJournalEntry(ownedKey, entry)) {
				removeStorageKeysBestEffort([legacyKey]);
				migrated = true;
			} else {
				migrationFailed = true;
			}
		} catch {
			// Keep the legacy event quarantined for a later confirmed migration attempt.
		}
	}

	if (!migrationFailed) {
		try {
			localStorage.setItem(migrationKey, '1');
		} catch {
			// Copied journal entries remain safe and retry with stable identities.
		}
	}

	if (migrated) {
		notifySessionInputDraftChangeSafely(sessionId);
	}

	return migrated;
}

function writeJournalEntry(key: string, entry: SessionInputDraftJournalEntry) {
	try {
		localStorage.setItem(key, JSON.stringify(entry));
		return true;
	} catch {
		return false;
	}
}

function removeStorageKeysBestEffort(keys: Iterable<string>) {
	for (const key of keys) {
		try {
			localStorage.removeItem(key);
		} catch {
			// Logical tombstones already make old journal data invisible.
		}
	}
}

export function clearSessionInputDraft(sessionId: string) {
	const ownerId = getResolvedAuthOwnerId();

	if (!browser || !ownerId) {
		return;
	}

	const journalKeys = listSessionInputDraftJournalKeys(sessionId, ownerId);

	removeStorageKeysBestEffort([
		getSessionInputDraftKeyForOwner(ownerId, sessionId),
		...journalKeys
	]);
	notifySessionInputDraftChangeSafely(sessionId);
}

export function writeSessionInputDraft(draft: SessionInputDraft) {
	const ownerId = getResolvedAuthOwnerId();

	if (!browser || !ownerId) {
		return false;
	}

	try {
		localStorage.setItem(
			getSessionInputDraftKeyForOwner(ownerId, draft.sessionId),
			JSON.stringify(draft)
		);
	} catch {
		return false;
	}

	notifySessionInputDraftChangeSafely(draft.sessionId);
	return true;
}

/**
 * Writes an immutable per-field journal entry. Separate fields and versions never share a storage
 * key, so interleaved tabs cannot overwrite one another's read/modify/write snapshots.
 */
export function writeSessionInputDraftField({
	sessionId,
	sessionSetId,
	field,
	rawValue,
	baseValue: proposedBaseValue
}: WriteSessionInputDraftFieldOptions): SessionInputDraftFieldWrite {
	const ownerId = getResolvedAuthOwnerId();

	if (!browser || !ownerId) {
		const draft = createEmptySessionInputDraft(sessionId);
		const fieldVersion = createSessionInputDraftFieldVersion();

		return {
			draft,
			ownerId: null,
			fieldVersion,
			intentAt: Date.now(),
			baseValue: proposedBaseValue ?? '',
			persisted: false,
			replacedField: null
		};
	}

	const state = readSessionInputDraftStorageState(sessionId, ownerId);
	const currentDraft = state.draft ?? createEmptySessionInputDraft(sessionId);
	const currentDraftSet = currentDraft.sets[sessionSetId];
	const { fieldKey, baseKey, intentAtKey, versionKey } = getSessionInputDraftFieldKeys(field);
	const slot = getSessionInputDraftFieldSlot(sessionSetId, field);
	const now = Date.now();
	const clearBeforeIntentAt = state.clearBySlot.get(slot)?.clearBeforeIntentAt;
	const previousIntentAt = Math.max(
		currentDraftSet?.[intentAtKey] ?? Number.NEGATIVE_INFINITY,
		clearBeforeIntentAt ?? Number.NEGATIVE_INFINITY
	);
	const intentAt =
		Number.isFinite(previousIntentAt) &&
		previousIntentAt < Number.MAX_SAFE_INTEGER &&
		previousIntentAt <= now + SESSION_INPUT_INTENT_MAX_FUTURE_MS
			? Math.max(now, previousIntentAt + 1)
			: now;
	const fieldVersion = createSessionInputDraftFieldVersion();
	const baseValue = currentDraftSet?.[baseKey] ?? proposedBaseValue ?? '';
	const replacedField =
		currentDraftSet && Object.hasOwn(currentDraftSet, fieldKey)
			? {
					fieldVersion: currentDraftSet[versionKey] ?? null,
					rawValue: currentDraftSet[fieldKey] ?? ''
				}
			: null;
	const entry: SessionInputDraftFieldJournalEntry = {
		kind: 'field',
		sessionId,
		sessionSetId,
		field,
		rawValue,
		baseValue,
		intentAt,
		fieldVersion
	};
	const persisted = writeJournalEntry(getSessionInputDraftFieldJournalKey(ownerId, entry), entry);
	const fallbackDraft: SessionInputDraft = {
		...currentDraft,
		sets: {
			...currentDraft.sets,
			[sessionSetId]: {
				...(currentDraftSet ?? {}),
				[fieldKey]: rawValue,
				[baseKey]: baseValue,
				[intentAtKey]: intentAt,
				[versionKey]: fieldVersion,
				updatedAt: intentAt
			}
		},
		updatedAt: Math.max(currentDraft.updatedAt, intentAt)
	};

	if (persisted) {
		notifySessionInputDraftChangeSafely(sessionId);
	}

	return {
		draft: persisted ? (readSessionInputDraft(sessionId) ?? fallbackDraft) : fallbackDraft,
		ownerId,
		fieldVersion,
		intentAt,
		baseValue,
		persisted,
		replacedField
	};
}

function persistSessionInputDraftFieldClear(
	state: SessionInputDraftStorageState,
	ownerId: string,
	sessionId: string,
	sessionSetId: string,
	field: SessionInputField,
	target: SessionInputDraftFieldCandidate
) {
	const slot = getSessionInputDraftFieldSlot(sessionSetId, field);
	const currentClear = state.clearBySlot.get(slot);
	const clearBeforeIntentAt = Math.max(
		currentClear?.clearBeforeIntentAt ?? Number.NEGATIVE_INFINITY,
		target.intentAt
	);
	const clearedIdentities =
		target.intentAt > (currentClear?.clearBeforeIntentAt ?? Number.NEGATIVE_INFINITY)
			? new Set<string>()
			: new Set(currentClear?.clearedIdentities ?? []);

	clearedIdentities.add(target.identity);
	const entry: SessionInputDraftClearJournalEntry = {
		kind: 'clear',
		sessionId,
		sessionSetId,
		field,
		clearBeforeIntentAt,
		clearedIdentities: [...clearedIdentities]
	};
	const persisted = writeJournalEntry(getSessionInputDraftClearJournalKey(ownerId, entry), entry);

	if (!persisted) {
		return false;
	}

	const obsoleteMutationKeys = (state.candidatesBySlot.get(slot) ?? []).flatMap((candidate) =>
		candidate.storageKey &&
		(candidate.intentAt < clearBeforeIntentAt || clearedIdentities.has(candidate.identity))
			? [candidate.storageKey]
			: []
	);
	removeStorageKeysBestEffort([...obsoleteMutationKeys, ...(currentClear?.storageKeys ?? [])]);
	notifySessionInputDraftChangeSafely(sessionId);
	return true;
}

/**
 * Tombstones the exact completed mutation. A logical watermark suppresses older journal entries,
 * while unseen same-time or newer versions remain visible and cannot be deleted by this clear.
 */
export function clearSessionInputDraftFieldIfVersion(
	sessionId: string,
	sessionSetId: string,
	field: SessionInputField,
	expectedFieldVersion: string | null,
	expectedRawValue?: string,
	expectedOwnerId?: string | null
): SessionInputDraftFieldClear {
	const ownerId = expectedOwnerId ?? getResolvedAuthOwnerId();

	if (!browser || !ownerId) {
		return { draft: createEmptySessionInputDraft(sessionId), cleared: false };
	}

	const state = readSessionInputDraftStorageState(sessionId, ownerId);
	const slot = getSessionInputDraftFieldSlot(sessionSetId, field);
	const clearState = state.clearBySlot.get(slot);
	const activeCandidates = (state.candidatesBySlot.get(slot) ?? []).filter(
		(candidate) => !isCandidateCleared(candidate, clearState)
	);
	const target = activeCandidates.find(
		(candidate) =>
			candidate.fieldVersion === expectedFieldVersion &&
			(expectedRawValue === undefined || candidate.rawValue === expectedRawValue)
	);

	if (!target) {
		return {
			draft: state.draft ?? createEmptySessionInputDraft(sessionId),
			cleared: false
		};
	}

	const winner = activeCandidates.toSorted(compareSessionInputDraftFieldCandidates).at(-1);
	const clearedCurrentField = winner?.identity === target.identity;
	const persisted = persistSessionInputDraftFieldClear(
		state,
		ownerId,
		sessionId,
		sessionSetId,
		field,
		target
	);

	return {
		draft:
			(persisted ? readSessionInputDraft(sessionId, ownerId) : state.draft) ??
			createEmptySessionInputDraft(sessionId),
		cleared: persisted && clearedCurrentField
	};
}

function draftFieldMatches(
	firstSet: SessionInputDraftSet | undefined,
	secondSet: SessionInputDraftSet | undefined,
	field: SessionInputField
) {
	const { fieldKey, baseKey, versionKey } = getSessionInputDraftFieldKeys(field);

	return Boolean(
		firstSet &&
		secondSet &&
		Object.hasOwn(firstSet, fieldKey) &&
		Object.hasOwn(secondSet, fieldKey) &&
		firstSet[fieldKey] === secondSet[fieldKey] &&
		firstSet[baseKey] === secondSet[baseKey] &&
		firstSet[versionKey] === secondSet[versionKey]
	);
}

/**
 * Finalizes exactly the flushed field versions. Journal mutations that arrived during the flush
 * use different immutable keys and remain authoritative even when the aggregate snapshot changed.
 */
export function finalizeSessionInputDraftIfUnchanged(
	snapshot: SessionInputDraft,
	nextDraft: SessionInputDraft | null,
	expectedOwnerId?: string
) {
	const ownerId = expectedOwnerId ?? getResolvedAuthOwnerId();
	const snapshotOwnerId = sessionInputDraftSnapshotOwners.get(snapshot);

	if (
		!browser ||
		!ownerId ||
		snapshotOwnerId !== ownerId ||
		(nextDraft && nextDraft.sessionId !== snapshot.sessionId)
	) {
		return false;
	}

	for (const [sessionSetId, snapshotSet] of Object.entries(snapshot.sets)) {
		for (const field of SESSION_INPUT_FIELDS) {
			const { fieldKey, versionKey } = getSessionInputDraftFieldKeys(field);

			if (
				!Object.hasOwn(snapshotSet, fieldKey) ||
				draftFieldMatches(snapshotSet, nextDraft?.sets[sessionSetId], field)
			) {
				continue;
			}

			clearSessionInputDraftFieldIfVersion(
				snapshot.sessionId,
				sessionSetId,
				field,
				snapshotSet[versionKey] ?? null,
				snapshotSet[fieldKey] ?? '',
				ownerId
			);
		}
	}

	const currentAggregate = readAggregateSessionInputDraft(snapshot.sessionId, ownerId);

	if (JSON.stringify(currentAggregate) !== JSON.stringify(snapshot)) {
		return true;
	}

	try {
		if (nextDraft) {
			localStorage.setItem(
				getSessionInputDraftKeyForOwner(ownerId, snapshot.sessionId),
				JSON.stringify(nextDraft)
			);
		} else {
			localStorage.removeItem(getSessionInputDraftKeyForOwner(ownerId, snapshot.sessionId));
		}
	} catch {
		return false;
	}

	notifySessionInputDraftChangeSafely(snapshot.sessionId);
	return true;
}

export function removeSessionInputDraftSets(sessionId: string, sessionSetIds: string[]) {
	const ownerId = getResolvedAuthOwnerId();

	if (!browser || !ownerId || sessionSetIds.length === 0) {
		return;
	}

	const state = readSessionInputDraftStorageState(sessionId, ownerId);
	const sessionSetIdSet = new Set(sessionSetIds);
	const matchedSessionSetIds = sessionSetIds.filter((sessionSetId) =>
		Object.hasOwn(state.draft?.sets ?? {}, sessionSetId)
	);

	if (matchedSessionSetIds.length === 0) {
		return;
	}

	for (const sessionSetId of matchedSessionSetIds) {
		const entry: SessionInputDraftRemovedSetJournalEntry = {
			kind: 'remove-set',
			sessionId,
			sessionSetId
		};
		writeJournalEntry(getSessionInputDraftRemovedSetJournalKey(ownerId, entry), entry);
	}

	const journalKeysToRemove = state.journalEntries.flatMap(({ key, entry }) =>
		sessionSetIdSet.has(entry.sessionSetId) ? [key] : []
	);
	removeStorageKeysBestEffort(journalKeysToRemove);

	if (state.aggregateDraft) {
		const nextAggregateSets = Object.fromEntries(
			Object.entries(state.aggregateDraft.sets).filter(
				([sessionSetId]) => !sessionSetIdSet.has(sessionSetId)
			)
		);

		try {
			if (Object.keys(nextAggregateSets).length === 0) {
				localStorage.removeItem(getSessionInputDraftKeyForOwner(ownerId, sessionId));
			} else {
				localStorage.setItem(
					getSessionInputDraftKeyForOwner(ownerId, sessionId),
					JSON.stringify({ ...state.aggregateDraft, sets: nextAggregateSets })
				);
			}
		} catch {
			// The remove-set journal still hides persisted field events.
		}
	}

	notifySessionInputDraftChangeSafely(sessionId);
}
