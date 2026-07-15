export const COMPENSATION_JOURNAL_VERSION = 1 as const;

export const COMPENSATION_JOURNAL_KINDS = [
	'session-creation',
	'session-reorder',
	'session-edit',
	'scheduled-session',
	'session-lifecycle',
	'exercise-merge'
] as const;

export type CompensationJournalKind = (typeof COMPENSATION_JOURNAL_KINDS)[number];

export type CompensationJournalEntry<T> = {
	version: typeof COMPENSATION_JOURNAL_VERSION;
	id: string;
	kind: CompensationJournalKind;
	userId: string;
	operationKey: string;
	sessionId: string;
	createdAt: number;
	payload: T;
};

export type CompensationJournalEntryInput<T> = Omit<
	CompensationJournalEntry<T>,
	'version' | 'id' | 'createdAt'
> & {
	id?: string;
	createdAt?: number;
};

export type CompensationJournalStorage = Pick<
	Storage,
	'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;

export type CompensationJournalQuery<T> = {
	userId: string;
	kind?: CompensationJournalKind;
	operationKey?: string;
	validatePayload: (payload: unknown) => payload is T;
	storage?: CompensationJournalStorage;
};

const JOURNAL_ROOT_PREFIX = 'tinytrain:compensation-journal:';
const JOURNAL_ENTRY_PREFIX = `${JOURNAL_ROOT_PREFIX}entry:v${COMPENSATION_JOURNAL_VERSION}:`;
const JOURNAL_QUARANTINE_PREFIX = `${JOURNAL_ROOT_PREFIX}quarantine:v${COMPENSATION_JOURNAL_VERSION}:`;
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_OWNER_BYTES = 4 * 1024 * 1024;
const MAX_OWNER_ENTRIES = 64;
const MAX_NEW_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const MAX_QUARANTINE_ENTRIES = 16;
const MAX_QUARANTINE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_QUARANTINE_RAW_LENGTH = 16 * 1024;

type QuarantinedCompensationJournalEntry = {
	quarantinedAt: number;
	reason: string;
	sourceKey: string;
	raw: string;
};

export class CompensationJournalStorageError extends Error {
	constructor(
		readonly operation: 'read' | 'write' | 'remove',
		message: string,
		options: ErrorOptions = {}
	) {
		super(message, options);
		this.name = 'CompensationJournalStorageError';
	}
}

function getDefaultStorage(): CompensationJournalStorage {
	try {
		if (!globalThis.localStorage) {
			throw new Error('localStorage is unavailable.');
		}

		return globalThis.localStorage;
	} catch (error) {
		throw new CompensationJournalStorageError(
			'read',
			'TinyTrain could not open durable compensation storage.',
			{ cause: error }
		);
	}
}

function encodeKeyPart(value: string) {
	return encodeURIComponent(value);
}

function getOwnerEntryPrefix(userId: string) {
	return `${JOURNAL_ENTRY_PREFIX}${encodeKeyPart(userId)}:`;
}

function getOwnerQuarantinePrefix(userId: string) {
	return `${JOURNAL_QUARANTINE_PREFIX}${encodeKeyPart(userId)}:`;
}

function getEntryStorageKey(userId: string, id: string) {
	return `${getOwnerEntryPrefix(userId)}${encodeKeyPart(id)}`;
}

function createEntryId() {
	const randomPart = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
	return `${Date.now().toString(36)}-${randomPart}`;
}

function listKeysWithPrefix(storage: CompensationJournalStorage, prefix: string) {
	const keys: string[] = [];

	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);

		if (key?.startsWith(prefix)) {
			keys.push(key);
		}
	}

	return keys;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const OMIT_UNDEFINED_OBJECT_FIELD = Symbol('omit-undefined-object-field');

function normalizeJsonValue(
	value: unknown,
	seen = new Set<object>(),
	allowUndefinedObjectField = false
): unknown | typeof OMIT_UNDEFINED_OBJECT_FIELD {
	if (value === undefined && allowUndefinedObjectField) {
		return OMIT_UNDEFINED_OBJECT_FIELD;
	}

	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	) {
		return value;
	}

	if (typeof value !== 'object' || seen.has(value)) {
		throw new Error('Compensation repair snapshots must contain only acyclic JSON values.');
	}

	if (!Array.isArray(value)) {
		const prototype = Object.getPrototypeOf(value);

		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error('Compensation repair snapshots cannot contain class instances or facades.');
		}
	}

	seen.add(value);

	try {
		if (Array.isArray(value)) {
			return value.map((item) => {
				const normalized = normalizeJsonValue(item, seen);

				if (normalized === OMIT_UNDEFINED_OBJECT_FIELD) {
					throw new Error('Undefined array values are not safe JSON snapshot data.');
				}

				return normalized;
			});
		}

		const normalized: Record<string, unknown> = {};

		for (const [key, item] of Object.entries(value)) {
			const normalizedItem = normalizeJsonValue(item, seen, true);

			if (normalizedItem !== OMIT_UNDEFINED_OBJECT_FIELD) {
				normalized[key] = normalizedItem;
			}
		}

		return normalized;
	} finally {
		seen.delete(value);
	}
}

function isCompensationJournalKind(value: unknown): value is CompensationJournalKind {
	return COMPENSATION_JOURNAL_KINDS.includes(value as CompensationJournalKind);
}

function parseEnvelope(
	raw: string,
	expectedUserId: string
): CompensationJournalEntry<unknown> | null {
	let candidate: unknown;

	try {
		candidate = JSON.parse(raw);
	} catch {
		return null;
	}

	if (
		!isRecord(candidate) ||
		candidate.version !== COMPENSATION_JOURNAL_VERSION ||
		typeof candidate.id !== 'string' ||
		candidate.id.length === 0 ||
		candidate.id.length > 200 ||
		!isCompensationJournalKind(candidate.kind) ||
		candidate.userId !== expectedUserId ||
		typeof candidate.operationKey !== 'string' ||
		candidate.operationKey.length === 0 ||
		candidate.operationKey.length > 500 ||
		typeof candidate.sessionId !== 'string' ||
		candidate.sessionId.length === 0 ||
		candidate.sessionId.length > 500 ||
		typeof candidate.createdAt !== 'number' ||
		!Number.isFinite(candidate.createdAt)
	) {
		return null;
	}

	try {
		normalizeJsonValue(candidate.payload);
	} catch {
		return null;
	}

	return candidate as CompensationJournalEntry<unknown>;
}

function pruneQuarantine(storage: CompensationJournalStorage, userId: string, now: number) {
	const quarantineKeys = listKeysWithPrefix(storage, getOwnerQuarantinePrefix(userId));
	const retained: Array<{ key: string; quarantinedAt: number }> = [];

	for (const key of quarantineKeys) {
		try {
			const raw = storage.getItem(key);
			const record = raw ? (JSON.parse(raw) as Partial<QuarantinedCompensationJournalEntry>) : null;
			const quarantinedAt =
				record && typeof record.quarantinedAt === 'number' && Number.isFinite(record.quarantinedAt)
					? record.quarantinedAt
					: Number.NEGATIVE_INFINITY;

			if (now - quarantinedAt > MAX_QUARANTINE_AGE_MS) {
				storage.removeItem(key);
			} else {
				retained.push({ key, quarantinedAt });
			}
		} catch {
			// Quarantine is diagnostic only. Never let its cleanup affect a valid repair entry.
		}
	}

	retained
		.sort((first, second) => second.quarantinedAt - first.quarantinedAt)
		.slice(MAX_QUARANTINE_ENTRIES)
		.forEach(({ key }) => {
			try {
				storage.removeItem(key);
			} catch {
				// Best effort for malformed diagnostics only.
			}
		});
}

function quarantineInvalidEntry(
	storage: CompensationJournalStorage,
	userId: string,
	sourceKey: string,
	raw: string,
	reason: string
) {
	const now = Date.now();
	const quarantineKey = `${getOwnerQuarantinePrefix(userId)}${now.toString(36)}:${encodeKeyPart(
		createEntryId()
	)}`;
	const record: QuarantinedCompensationJournalEntry = {
		quarantinedAt: now,
		reason,
		sourceKey,
		raw: raw.slice(0, MAX_QUARANTINE_RAW_LENGTH)
	};

	try {
		storage.setItem(quarantineKey, JSON.stringify(record));
		storage.removeItem(sourceKey);
		pruneQuarantine(storage, userId, now);
	} catch {
		// If quarantine cannot be made durable, retain the source for a future safe attempt.
	}
}

function toStorageError(
	operation: CompensationJournalStorageError['operation'],
	message: string,
	error: unknown
) {
	return error instanceof CompensationJournalStorageError
		? error
		: new CompensationJournalStorageError(operation, message, { cause: error });
}

export function persistCompensationJournalEntry<T>(
	input: CompensationJournalEntryInput<T>,
	storage = getDefaultStorage()
): CompensationJournalEntry<T> {
	const now = Date.now();
	const createdAt = input.createdAt ?? now;
	let normalizedPayload: T;

	try {
		const normalized = normalizeJsonValue(input.payload);

		if (normalized === OMIT_UNDEFINED_OBJECT_FIELD) {
			throw new Error('The compensation repair payload cannot be undefined.');
		}

		normalizedPayload = normalized as T;
	} catch (error) {
		throw toStorageError(
			'write',
			'TinyTrain refused to persist an invalid compensation repair snapshot.',
			error
		);
	}

	const entry: CompensationJournalEntry<T> = {
		version: COMPENSATION_JOURNAL_VERSION,
		id: input.id ?? createEntryId(),
		kind: input.kind,
		userId: input.userId,
		operationKey: input.operationKey,
		sessionId: input.sessionId,
		createdAt,
		payload: normalizedPayload
	};

	if (
		!isCompensationJournalKind(entry.kind) ||
		!entry.userId ||
		!entry.operationKey ||
		!entry.sessionId ||
		!Number.isFinite(createdAt) ||
		createdAt > now + MAX_FUTURE_SKEW_MS ||
		createdAt < now - MAX_NEW_ENTRY_AGE_MS
	) {
		throw new CompensationJournalStorageError(
			'write',
			'TinyTrain refused to persist an invalid compensation repair snapshot.'
		);
	}

	let serialized: string;

	try {
		serialized = JSON.stringify(entry);
	} catch (error) {
		throw toStorageError(
			'write',
			'TinyTrain could not serialize the compensation repair snapshot.',
			error
		);
	}

	if (serialized.length > MAX_ENTRY_BYTES) {
		throw new CompensationJournalStorageError(
			'write',
			'The compensation repair snapshot is too large to persist safely.'
		);
	}

	const storageKey = getEntryStorageKey(entry.userId, entry.id);

	try {
		const ownerKeys = listKeysWithPrefix(storage, getOwnerEntryPrefix(entry.userId));
		const existingValue = storage.getItem(storageKey);
		const existingBytes = existingValue?.length ?? 0;
		const ownerBytes = ownerKeys.reduce(
			(total, key) => total + (storage.getItem(key)?.length ?? 0),
			0
		);

		if (!existingValue && ownerKeys.length >= MAX_OWNER_ENTRIES) {
			throw new CompensationJournalStorageError(
				'write',
				'The durable compensation journal is full; unresolved repairs were preserved.'
			);
		}

		if (ownerBytes - existingBytes + serialized.length > MAX_OWNER_BYTES) {
			throw new CompensationJournalStorageError(
				'write',
				'The durable compensation journal has no safe capacity; unresolved repairs were preserved.'
			);
		}

		storage.setItem(storageKey, serialized);
		return entry;
	} catch (error) {
		throw toStorageError(
			'write',
			'TinyTrain could not save the compensation repair snapshot.',
			error
		);
	}
}

export function readCompensationJournalEntries<T>({
	userId,
	kind,
	operationKey,
	validatePayload,
	storage = getDefaultStorage()
}: CompensationJournalQuery<T>): CompensationJournalEntry<T>[] {
	try {
		const entries: CompensationJournalEntry<T>[] = [];

		for (const key of listKeysWithPrefix(storage, getOwnerEntryPrefix(userId))) {
			const raw = storage.getItem(key);

			if (raw === null) {
				continue;
			}

			const entry = parseEnvelope(raw, userId);

			if (!entry) {
				quarantineInvalidEntry(
					storage,
					userId,
					key,
					raw,
					'Malformed or unsupported journal entry.'
				);
				continue;
			}

			if ((kind && entry.kind !== kind) || (operationKey && entry.operationKey !== operationKey)) {
				continue;
			}

			if (!validatePayload(entry.payload)) {
				quarantineInvalidEntry(storage, userId, key, raw, 'Invalid compensation payload.');
				continue;
			}

			entries.push(entry as CompensationJournalEntry<T>);
		}

		return entries.sort(
			(first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id)
		);
	} catch (error) {
		throw toStorageError('read', 'TinyTrain could not read pending compensation repairs.', error);
	}
}

export function removeCompensationJournalEntry(
	entry: Pick<CompensationJournalEntry<unknown>, 'userId' | 'id'>,
	storage = getDefaultStorage()
) {
	try {
		storage.removeItem(getEntryStorageKey(entry.userId, entry.id));
	} catch (error) {
		throw toStorageError(
			'remove',
			'TinyTrain repaired the data but could not clear its durable repair marker.',
			error
		);
	}
}

export function getCompensationJournalDurabilityMessage(error: unknown) {
	const reason = error instanceof Error ? error.message : 'Durable storage is unavailable.';

	return ` Recovery could not be saved for reload safety. Keep this tab open and retry before leaving. ${reason}`;
}
