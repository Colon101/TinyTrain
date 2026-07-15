import type { RxCollection, RxDocument, RxDocumentData } from 'rxdb';
import {
	getTinyTrainRxDatabase,
	reopenTinyTrainRxDatabase,
	startSupabaseReplication
} from './rxdb';
import { BASELINE_EXERCISE_ROWS } from './exercises';

type PlainDoc = Record<string, unknown> & { id: string; user_id?: string };
type Selector = Record<string, unknown>;
type TableName =
	| 'exercises'
	| 'workouts'
	| 'workoutExercises'
	| 'workoutSessions'
	| 'sessionExercises'
	| 'sessionSets'
	| 'exerciseResetEvents';
type ChangeListener = (tableName: TableName) => void;
type TransactionCallback<T> = () => Promise<T> | T;
type TableSyncState<T> = { row?: T; deleted: boolean } | undefined;

class BulkMutationCompensationError extends Error {
	readonly compensationError: unknown;

	constructor(operation: string, originalError: unknown, compensationError: unknown) {
		super(`${operation} failed and its partial-write compensation also failed.`, {
			cause: originalError
		});
		this.name = 'BulkMutationCompensationError';
		this.compensationError = compensationError;
	}
}

const changeListeners = new Set<ChangeListener>();
const localTransactionQueuesByUserId = new Map<string, Promise<void>>();

function getTransactionLockManager() {
	if (typeof navigator === 'undefined') {
		return undefined;
	}

	const lockManager = navigator.locks;
	return lockManager && typeof lockManager.request === 'function' ? lockManager : undefined;
}

function runWithLocalTransactionQueue<T>(
	userId: string,
	callback: TransactionCallback<T>
): Promise<T> {
	const previousTransaction = localTransactionQueuesByUserId.get(userId) ?? Promise.resolve();
	const run = () => Promise.resolve().then(callback);
	const nextTransaction = previousTransaction.then(run, run);
	const queueTail = nextTransaction.then(
		() => undefined,
		() => undefined
	);

	localTransactionQueuesByUserId.set(userId, queueTail);
	void queueTail.then(() => {
		if (localTransactionQueuesByUserId.get(userId) === queueTail) {
			localTransactionQueuesByUserId.delete(userId);
		}
	});

	return nextTransaction;
}

function createTransactionRunner(userId: string) {
	const lockManager = getTransactionLockManager();
	const lockName = `tinytrain:rxdb-transaction:${userId}`;

	return function runSerializedTransaction<T>(callback: TransactionCallback<T>): Promise<T> {
		if (lockManager) {
			return lockManager.request(lockName, { mode: 'exclusive' }, () =>
				Promise.resolve().then(callback)
			);
		}

		return runWithLocalTransactionQueue(userId, callback);
	};
}

export function subscribeToRxDexieChanges(listener: ChangeListener) {
	changeListeners.add(listener);

	return {
		unsubscribe() {
			changeListeners.delete(listener);
		}
	};
}

function notifyTableChanged(tableName: TableName) {
	for (const listener of changeListeners) {
		listener(tableName);
	}
}

function stripRxDataMeta<T>(source: Record<string, unknown>): T {
	const json = { ...source };
	delete json._attachments;
	delete json._deleted;
	delete json._meta;
	delete json._rev;

	return json as T;
}

function stripRxMeta<T>(doc: RxDocument<T> | null | undefined): T | undefined {
	return doc ? stripRxDataMeta<T>(doc.toMutableJSON() as Record<string, unknown>) : undefined;
}

function stripUndefinedValues<T extends Record<string, unknown>>(doc: T) {
	const cleanDoc = { ...doc };

	for (const [key, value] of Object.entries(cleanDoc)) {
		if (value === undefined) {
			delete cleanDoc[key];
		}
	}

	return cleanDoc;
}

function compareValues(first: unknown, second: unknown) {
	if (typeof first === 'number' && typeof second === 'number') {
		return first - second;
	}

	return String(first ?? '').localeCompare(String(second ?? ''));
}

function compareRangeValues(first: unknown, second: unknown): number | null {
	if (typeof first === 'number' && typeof second === 'number') {
		if (Number.isNaN(first) || Number.isNaN(second)) {
			return null;
		}

		return first === second ? 0 : first < second ? -1 : 1;
	}

	if (typeof first === 'string' && typeof second === 'string') {
		return first === second ? 0 : first < second ? -1 : 1;
	}

	return null;
}

function getFieldValue(doc: PlainDoc, field: string) {
	const compoundMatch = field.match(/^\[(.+)\]$/);

	if (!compoundMatch) {
		return doc[field];
	}

	return compoundMatch[1].split('+').map((part) => doc[part]);
}

function matchesSelector(doc: PlainDoc, selector: Selector) {
	return Object.entries(selector).every(([key, value]) => {
		const actual = getFieldValue(doc, key);

		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const operators = value as Record<string, unknown>;

			if ('$eq' in operators) {
				return actual === operators.$eq;
			}

			if ('$in' in operators && Array.isArray(operators.$in)) {
				return operators.$in.some((candidate) =>
					Array.isArray(candidate) && Array.isArray(actual)
						? JSON.stringify(candidate) === JSON.stringify(actual)
						: candidate === actual
				);
			}

			if ('$gt' in operators || '$gte' in operators || '$lt' in operators || '$lte' in operators) {
				const comparisons = [
					['$gt', (comparison: number) => comparison > 0],
					['$gte', (comparison: number) => comparison >= 0],
					['$lt', (comparison: number) => comparison < 0],
					['$lte', (comparison: number) => comparison <= 0]
				] as const;

				return comparisons.every(([operator, matches]) => {
					if (!(operator in operators)) {
						return true;
					}

					const comparison = compareRangeValues(actual, operators[operator]);
					return comparison !== null && matches(comparison);
				});
			}
		}

		return Array.isArray(value) && Array.isArray(actual)
			? JSON.stringify(value) === JSON.stringify(actual)
			: actual === value;
	});
}

class RxWhereQuery<T extends PlainDoc> {
	constructor(
		private readonly table: RxTableAdapter<T>,
		private readonly field: string
	) {}

	equals(value: unknown) {
		return new RxCollectionQuery<T>(this.table, { [this.field]: value });
	}

	anyOf(values: unknown[]) {
		return new RxCollectionQuery<T>(this.table, { [this.field]: { $in: values } });
	}

	between(lower: unknown, upper: unknown, includeLower = true, includeUpper = true) {
		return new RxCollectionQuery<T>(this.table, {
			[this.field]: {
				...(includeLower ? { $gte: lower } : { $gt: lower }),
				...(includeUpper ? { $lte: upper } : { $lt: upper })
			}
		});
	}
}

class RxCollectionQuery<T extends PlainDoc> {
	constructor(
		private readonly table: RxTableAdapter<T>,
		private readonly selector: Selector
	) {}

	async toArray() {
		return this.table.findBySelector(this.selector);
	}

	async first() {
		return (await this.toArray())[0];
	}

	async sortBy(field: string) {
		return (await this.toArray()).sort((first, second) =>
			compareValues(first[field], second[field])
		);
	}
}

export class RxTableAdapter<T extends PlainDoc> {
	private readonly sharedDocsById: Map<string, T>;

	constructor(
		private readonly collection: RxCollection<T>,
		private readonly userId: string,
		tableName: TableName,
		sharedDocs: T[] = []
	) {
		this.sharedDocsById = new Map(sharedDocs.map((doc) => [doc.id, doc]));
		this.collection.$.subscribe(() => notifyTableChanged(tableName));
	}

	private withUserId(doc: Partial<T>) {
		return stripUndefinedValues({
			...doc,
			user_id: this.userId
		} as T);
	}

	private async getSyncStates(ids: string[]) {
		const states = new Map<string, TableSyncState<T>>();
		const storageIds: string[] = [];

		for (const id of new Set(ids)) {
			const sharedDoc = this.sharedDocsById.get(id);

			if (sharedDoc) {
				states.set(id, { row: sharedDoc, deleted: false });
			} else {
				storageIds.push(id);
			}
		}

		if (storageIds.length === 0) {
			return states;
		}

		const storedDocs = await this.collection.storageInstance.findDocumentsById(storageIds, true);
		const storedDocsById = new Map(
			storedDocs
				.filter((doc) => (doc as Record<string, unknown>).user_id === this.userId)
				.map((doc) => [doc.id, doc])
		);

		for (const id of storageIds) {
			const storedDoc = storedDocsById.get(id) as RxDocumentData<T> | undefined;

			states.set(
				id,
				storedDoc
					? {
							row: stripRxDataMeta<T>(storedDoc as unknown as Record<string, unknown>),
							deleted: storedDoc._deleted === true
						}
					: undefined
			);
		}

		return states;
	}

	private async compensateSuccessfulBatch(
		successfulIds: string[],
		previousStates: Map<string, TableSyncState<T>>,
		mutation: 'write' | 'delete'
	) {
		const restoreRows: T[] = [];
		const removeIds: string[] = [];

		for (const id of new Set(successfulIds)) {
			const previousState = previousStates.get(id);

			if (previousState && !previousState.deleted && previousState.row) {
				restoreRows.push(this.withUserId(previousState.row));
			} else if (mutation === 'write') {
				removeIds.push(id);
			}
		}

		const compensationErrors: unknown[] = [];

		if (restoreRows.length > 0) {
			try {
				const restoreResult = await this.collection.bulkUpsert(restoreRows);
				compensationErrors.push(...restoreResult.error);
			} catch (error) {
				compensationErrors.push(error);
			}
		}

		if (removeIds.length > 0) {
			try {
				const removeResult = await this.collection.bulkRemove(removeIds);
				compensationErrors.push(...removeResult.error);
			} catch (error) {
				compensationErrors.push(error);
			}
		}

		if (compensationErrors.length === 1) {
			throw compensationErrors[0];
		}

		if (compensationErrors.length > 1) {
			throw new AggregateError(compensationErrors, 'Multiple partial-write compensations failed.');
		}
	}

	private async rejectPartialBatch(
		operation: string,
		originalError: unknown,
		successfulIds: string[],
		previousStates: Map<string, TableSyncState<T>>,
		mutation: 'write' | 'delete'
	): Promise<never> {
		try {
			await this.compensateSuccessfulBatch(successfulIds, previousStates, mutation);
		} catch (compensationError) {
			throw new BulkMutationCompensationError(operation, originalError, compensationError);
		}

		throw originalError;
	}

	async toArray() {
		const docs = await this.collection.find({ selector: { user_id: this.userId } as never }).exec();
		return [
			...this.sharedDocsById.values(),
			...docs.map((doc) => stripRxMeta<T>(doc)).filter((doc): doc is T => Boolean(doc))
		];
	}

	async findBySelector(selector: Selector) {
		const pushdownSelector = Object.fromEntries(
			Object.entries(selector).filter(([field]) => !field.match(/^\[(.+)\]$/))
		);
		const sharedDocs = [...this.sharedDocsById.values()].filter((doc) =>
			matchesSelector(doc, selector)
		);
		const docs = await this.collection
			.find({
				selector: {
					user_id: this.userId,
					...pushdownSelector
				} as never
			})
			.exec();

		return [
			...sharedDocs,
			...docs
				.map((doc) => stripRxMeta<T>(doc))
				.filter((doc): doc is T => Boolean(doc))
				.filter((doc) => matchesSelector(doc, selector))
		];
	}

	async get(id: string) {
		const sharedDoc = this.sharedDocsById.get(id);

		if (sharedDoc) {
			return sharedDoc;
		}

		return stripRxMeta<T>(await this.collection.findOne(id).exec()) ?? undefined;
	}

	/**
	 * Sync-only lookup that can distinguish true absence from an RxDB tombstone. Normal table
	 * reads intentionally continue to hide deleted documents.
	 */
	async getSyncState(id: string) {
		return (await this.getSyncStates([id])).get(id);
	}

	async bulkGet(ids: string[]) {
		const docsById = await this.collection.findByIds(ids).exec();
		return ids.map((id) => this.sharedDocsById.get(id) ?? stripRxMeta<T>(docsById.get(id)));
	}

	async add(doc: T) {
		await this.collection.insert(this.withUserId(doc));
		return doc.id;
	}

	async bulkAdd(docs: T[]) {
		if (docs.length === 0) {
			return [];
		}

		const previousStates = await this.getSyncStates(docs.map((doc) => doc.id));
		const result = await this.collection.bulkInsert(docs.map((doc) => this.withUserId(doc)));

		if (result.error.length > 0) {
			return this.rejectPartialBatch(
				'Bulk insert',
				result.error[0],
				result.success.map((doc) => doc.primary),
				previousStates,
				'write'
			);
		}

		return result.success.map((doc) => doc.primary);
	}

	async put(doc: T) {
		await this.collection.upsert(this.withUserId(doc));
		return doc.id;
	}

	async bulkPut(docs: T[]) {
		if (docs.length === 0) {
			return [];
		}

		const previousStates = await this.getSyncStates(docs.map((doc) => doc.id));
		const result = await this.collection.bulkUpsert(docs.map((doc) => this.withUserId(doc)));

		if (result.error.length > 0) {
			return this.rejectPartialBatch(
				'Bulk upsert',
				result.error[0],
				result.success.map((doc) => doc.primary),
				previousStates,
				'write'
			);
		}

		return result.success.map((doc) => doc.primary);
	}

	async update(id: string, patch: Partial<T>) {
		const doc = await this.collection.findOne(id).exec();

		if (!doc) {
			return 0;
		}

		const nextPatch = {
			...patch,
			user_id: this.userId
		} as Record<string, unknown>;

		await doc.incrementalModify((docData) => {
			const mutableDocData = docData as Record<string, unknown>;

			for (const [key, value] of Object.entries(nextPatch)) {
				if (value === undefined) {
					delete mutableDocData[key];
				} else {
					mutableDocData[key] = value;
				}
			}

			return docData;
		});
		return 1;
	}

	async delete(id: string) {
		const result = await this.collection.bulkRemove([id]);

		if (result.error.length > 0) {
			throw result.error[0];
		}
	}

	async bulkDelete(ids: string[]) {
		if (ids.length === 0) {
			return;
		}

		const previousStates = await this.getSyncStates(ids);
		const result = await this.collection.bulkRemove(ids);

		if (result.error.length > 0) {
			return this.rejectPartialBatch(
				'Bulk delete',
				result.error[0],
				result.success.map((doc) => doc.primary),
				previousStates,
				'delete'
			);
		}
	}

	where(field: string) {
		return new RxWhereQuery<T>(this, field);
	}
}

export type RxDexieLikeDatabase = {
	exercises: RxTableAdapter<PlainDoc>;
	workouts: RxTableAdapter<PlainDoc>;
	workoutExercises: RxTableAdapter<PlainDoc>;
	workoutSessions: RxTableAdapter<PlainDoc>;
	sessionExercises: RxTableAdapter<PlainDoc>;
	sessionSets: RxTableAdapter<PlainDoc>;
	exerciseResetEvents: RxTableAdapter<PlainDoc>;
	transaction<T>(mode: string, ...args: unknown[]): Promise<T>;
};

const adaptersByUserId = new Map<string, Promise<RxDexieLikeDatabase>>();

function cacheAdapterPromise(userId: string, promise: Promise<RxDexieLikeDatabase>) {
	adaptersByUserId.set(userId, promise);
	void promise.catch(() => {
		if (adaptersByUserId.get(userId) === promise) {
			adaptersByUserId.delete(userId);
		}
	});

	return promise;
}

async function createRxDexieLikeDatabase(
	userId: string,
	options: { reopen?: boolean } = {}
): Promise<RxDexieLikeDatabase> {
	const database = options.reopen
		? await reopenTinyTrainRxDatabase(userId)
		: await getTinyTrainRxDatabase(userId);

	await startSupabaseReplication(userId);

	const runSerializedTransaction = createTransactionRunner(userId);

	return {
		exercises: new RxTableAdapter(
			database.exercises as unknown as RxCollection<PlainDoc>,
			userId,
			'exercises',
			BASELINE_EXERCISE_ROWS as PlainDoc[]
		),
		workouts: new RxTableAdapter(
			database.workouts as unknown as RxCollection<PlainDoc>,
			userId,
			'workouts'
		),
		workoutExercises: new RxTableAdapter(
			database.workoutExercises as unknown as RxCollection<PlainDoc>,
			userId,
			'workoutExercises'
		),
		workoutSessions: new RxTableAdapter(
			database.workoutSessions as unknown as RxCollection<PlainDoc>,
			userId,
			'workoutSessions'
		),
		sessionExercises: new RxTableAdapter(
			database.sessionExercises as unknown as RxCollection<PlainDoc>,
			userId,
			'sessionExercises'
		),
		sessionSets: new RxTableAdapter(
			database.sessionSets as unknown as RxCollection<PlainDoc>,
			userId,
			'sessionSets'
		),
		exerciseResetEvents: new RxTableAdapter(
			database.exerciseResetEvents as unknown as RxCollection<PlainDoc>,
			userId,
			'exerciseResetEvents'
		),
		async transaction<T>(_mode: string, ...args: unknown[]) {
			const callback = args.at(-1);

			if (typeof callback !== 'function') {
				return undefined as T;
			}

			// RxDB's Dexie storage uses one IndexedDB database per collection, so it cannot
			// provide a real cross-collection transaction here. The user-scoped Web Lock
			// preserves app-level write ordering across every tab for multi-table mutations.
			return runSerializedTransaction(callback as TransactionCallback<T>);
		}
	};
}

export async function getRxDexieLikeDatabase(userId: string): Promise<RxDexieLikeDatabase> {
	const existing = adaptersByUserId.get(userId);

	if (existing) {
		return existing;
	}

	const next = createRxDexieLikeDatabase(userId);

	return cacheAdapterPromise(userId, next);
}

export async function reopenRxDexieLikeDatabase(userId: string): Promise<RxDexieLikeDatabase> {
	adaptersByUserId.delete(userId);

	const next = createRxDexieLikeDatabase(userId, { reopen: true });

	return cacheAdapterPromise(userId, next);
}
