import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CompensationJournalStorageError,
	persistCompensationJournalEntry,
	readCompensationJournalEntries,
	removeCompensationJournalEntry,
	type CompensationJournalStorage
} from './compensation-journal';

type TestPayload = {
	row: { id: string; value: string };
};

class MemoryStorage implements CompensationJournalStorage {
	readonly values = new Map<string, string>();
	failWrites = false;
	failRemoves = false;

	get length() {
		return this.values.size;
	}

	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}

	getItem(key: string) {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string) {
		if (this.failWrites) {
			throw new Error('storage is full');
		}

		this.values.set(key, value);
	}

	removeItem(key: string) {
		if (this.failRemoves) {
			throw new Error('storage is read-only');
		}

		this.values.delete(key);
	}
}

function isTestPayload(payload: unknown): payload is TestPayload {
	return Boolean(
		payload &&
		typeof payload === 'object' &&
		'row' in payload &&
		payload.row &&
		typeof payload.row === 'object' &&
		'id' in payload.row &&
		typeof payload.row.id === 'string' &&
		'value' in payload.row &&
		typeof payload.row.value === 'string'
	);
}

let storage: MemoryStorage;

beforeEach(() => {
	storage = new MemoryStorage();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
});

describe('compensation journal', () => {
	it('round-trips a versioned owner-scoped snapshot and removes it only by exact entry id', () => {
		const entry = persistCompensationJournalEntry(
			{
				kind: 'session-edit',
				userId: 'user-a',
				operationKey: 'user-a\u0000session-1\u0000remove-set',
				sessionId: 'session-1',
				payload: { row: { id: 'set-1', value: 'before' } }
			},
			storage
		);

		expect(
			readCompensationJournalEntries({
				userId: 'user-a',
				kind: 'session-edit',
				operationKey: entry.operationKey,
				validatePayload: isTestPayload,
				storage
			})
		).toEqual([entry]);
		expect(
			readCompensationJournalEntries({
				userId: 'user-b',
				kind: 'session-edit',
				validatePayload: isTestPayload,
				storage
			})
		).toEqual([]);

		removeCompensationJournalEntry(entry, storage);
		expect(
			readCompensationJournalEntries({
				userId: 'user-a',
				validatePayload: isTestPayload,
				storage
			})
		).toEqual([]);
	});

	it('never serializes Error objects, callbacks, or non-plain facades', () => {
		for (const payload of [
			{ error: new Error('do not persist') },
			{ callback: () => undefined },
			{ facade: new (class DatabaseFacade {})() }
		]) {
			expect(() =>
				persistCompensationJournalEntry(
					{
						kind: 'session-edit',
						userId: 'user-a',
						operationKey: 'operation-1',
						sessionId: 'session-1',
						payload
					},
					storage
				)
			).toThrow(CompensationJournalStorageError);
		}
	});

	it('quarantines malformed matching entries without touching another owner or journal kind', () => {
		const scheduledEntry = persistCompensationJournalEntry(
			{
				kind: 'scheduled-session',
				userId: 'user-a',
				operationKey: 'schedule-1',
				sessionId: 'session-1',
				payload: { scheduled: true }
			},
			storage
		);
		persistCompensationJournalEntry(
			{
				kind: 'session-edit',
				userId: 'user-b',
				operationKey: 'edit-1',
				sessionId: 'session-1',
				payload: { row: { id: 'set-1', value: 'B' } }
			},
			storage
		);
		const scheduledKey = [...storage.values.entries()].find(([, raw]) =>
			raw.includes(scheduledEntry.id)
		)?.[0];
		expect(scheduledKey).toBeTruthy();
		storage.values.set(scheduledKey!, '{not-json');

		expect(
			readCompensationJournalEntries({
				userId: 'user-a',
				kind: 'scheduled-session',
				validatePayload: isTestPayload,
				storage
			})
		).toEqual([]);
		expect([...storage.values.keys()].some((key) => key.includes('quarantine'))).toBe(true);
		expect(
			readCompensationJournalEntries({
				userId: 'user-b',
				kind: 'session-edit',
				validatePayload: isTestPayload,
				storage
			})
		).toHaveLength(1);
	});

	it('surfaces write failure and leaves existing unresolved entries untouched', () => {
		const existing = persistCompensationJournalEntry(
			{
				kind: 'session-edit',
				userId: 'user-a',
				operationKey: 'edit-1',
				sessionId: 'session-1',
				payload: { row: { id: 'set-1', value: 'before' } }
			},
			storage
		);
		storage.failWrites = true;

		expect(() =>
			persistCompensationJournalEntry(
				{
					kind: 'session-edit',
					userId: 'user-a',
					operationKey: 'edit-2',
					sessionId: 'session-2',
					payload: { row: { id: 'set-2', value: 'after' } }
				},
				storage
			)
		).toThrow('could not save the compensation repair snapshot');
		storage.failWrites = false;
		expect(
			readCompensationJournalEntries({
				userId: 'user-a',
				validatePayload: isTestPayload,
				storage
			})
		).toEqual([existing]);
	});

	it('rejects an oversized new entry instead of evicting valid unresolved repair data', () => {
		const existing = persistCompensationJournalEntry(
			{
				kind: 'session-edit',
				userId: 'user-a',
				operationKey: 'edit-1',
				sessionId: 'session-1',
				payload: { row: { id: 'set-1', value: 'before' } }
			},
			storage
		);

		expect(() =>
			persistCompensationJournalEntry(
				{
					kind: 'session-edit',
					userId: 'user-a',
					operationKey: 'edit-2',
					sessionId: 'session-2',
					payload: { row: { id: 'set-2', value: 'x'.repeat(600 * 1024) } }
				},
				storage
			)
		).toThrow('too large');
		expect(
			readCompensationJournalEntries({
				userId: 'user-a',
				validatePayload: isTestPayload,
				storage
			})
		).toEqual([existing]);
	});
});
