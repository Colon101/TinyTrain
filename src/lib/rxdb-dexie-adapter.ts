import type { RxCollection, RxDocument } from 'rxdb';
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
	| 'sessionSets';
type ChangeListener = (tableName: TableName) => void;
type TransactionCallback<T> = () => Promise<T> | T;

const changeListeners = new Set<ChangeListener>();

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

function stripRxMeta<T>(doc: RxDocument<T> | null | undefined): T | undefined {
	if (!doc) {
		return undefined;
	}

	const json = doc.toMutableJSON() as Record<string, unknown>;
	delete json._attachments;
	delete json._deleted;
	delete json._meta;
	delete json._rev;
	delete json.user_id;

	return json as T;
}

function isWriteConflict(error: unknown) {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'CONFLICT'
	);
}

class ConditionalWriteConflict extends Error {}

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

	async bulkGet(ids: string[]) {
		const docsById = await this.collection.findByIds(ids).exec();
		return ids.map((id) => this.sharedDocsById.get(id) ?? stripRxMeta<T>(docsById.get(id)));
	}

	async bulkGetVersioned(
		ids: string[]
	): Promise<Array<{ document: T; version: string } | undefined>> {
		const docsById = await this.collection.findByIds(ids).exec();

		return ids.map((id) => {
			const sharedDoc = this.sharedDocsById.get(id);

			if (sharedDoc) {
				throw new Error('Shared documents do not support versioned writes.');
			}

			const doc = docsById.get(id);
			const document = stripRxMeta<T>(doc);

			if (!document) {
				return undefined;
			}
			if (!doc?.revision) {
				throw new Error('RxDB returned a document without a revision.');
			}

			return { document, version: doc.revision };
		});
	}

	async add(doc: T) {
		await this.collection.insert(this.withUserId(doc));
		return doc.id;
	}

	async bulkAdd(docs: T[]) {
		if (docs.length === 0) {
			return [];
		}

		const result = await this.collection.bulkInsert(docs.map((doc) => this.withUserId(doc)));

		if (result.error.length > 0) {
			throw result.error[0];
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

		const result = await this.collection.bulkUpsert(docs.map((doc) => this.withUserId(doc)));

		if (result.error.length > 0) {
			throw result.error[0];
		}

		return result.success.map((doc) => doc.primary);
	}

	async compareAndPut(expectedVersion: string | undefined, next: T) {
		if (this.sharedDocsById.has(next.id)) {
			return false;
		}

		const current = await this.collection.findOne(next.id).exec();

		if (!current) {
			if (expectedVersion !== undefined) {
				return false;
			}

			try {
				await this.collection.insert(this.withUserId(next));
				return true;
			} catch (error) {
				if (isWriteConflict(error)) {
					return false;
				}

				throw error;
			}
		}

		if (expectedVersion === undefined) {
			return false;
		}
		if (current.revision !== expectedVersion) {
			return false;
		}

		try {
			await current.modify(() => {
				if (current.revision !== expectedVersion) {
					throw new ConditionalWriteConflict();
				}

				return this.withUserId(next);
			});
			return true;
		} catch (error) {
			if (error instanceof ConditionalWriteConflict || isWriteConflict(error)) {
				return false;
			}

			throw error;
		}
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
		await this.collection.bulkRemove([id]);
	}

	async bulkDelete(ids: string[]) {
		if (ids.length === 0) {
			return;
		}

		await this.collection.bulkRemove(ids);
	}

	async compareAndDelete(expectedVersion: string, id: string) {
		if (this.sharedDocsById.has(id)) {
			return false;
		}

		const current = await this.collection.findOne(id).exec();

		if (!current) {
			return false;
		}

		if (current.revision !== expectedVersion) {
			return false;
		}

		try {
			await current.remove();
			return true;
		} catch (error) {
			if (error instanceof ConditionalWriteConflict || isWriteConflict(error)) {
				return false;
			}

			throw error;
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
	transaction<T>(callback: TransactionCallback<T>): Promise<T>;
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

	let transactionQueue: Promise<unknown> = Promise.resolve();

	function runSerializedTransaction<T>(callback: TransactionCallback<T>): Promise<T> {
		const run = () => Promise.resolve().then(callback);
		const nextTransaction = transactionQueue.then(run, run);

		transactionQueue = nextTransaction.then(
			() => undefined,
			() => undefined
		);

		return nextTransaction;
	}

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
		async transaction<T>(callback: TransactionCallback<T>) {
			// RxDB's Dexie storage uses one IndexedDB database per collection, so it cannot
			// provide a real cross-collection transaction here. Serializing these sections
			// at least preserves app-level write ordering for multi-table mutations.
			return runSerializedTransaction(callback);
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
