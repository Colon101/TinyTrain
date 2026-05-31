import type { RxCollection, RxDocument } from 'rxdb';
import { getTinyTrainRxDatabase, startSupabaseReplication } from './rxdb';
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

	return json as T;
}

function compareValues(first: unknown, second: unknown) {
	if (typeof first === 'number' && typeof second === 'number') {
		return first - second;
	}

	return String(first ?? '').localeCompare(String(second ?? ''));
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

			if ('$gte' in operators || '$lte' in operators) {
				const textActual = String(actual ?? '');
				const gte = operators.$gte;
				const lte = operators.$lte;

				return (
					(gte === undefined || textActual >= String(gte)) &&
					(lte === undefined || textActual <= String(lte))
				);
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
				...(includeLower ? { $gte: lower } : {}),
				...(includeUpper ? { $lte: upper } : {})
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
		return {
			...doc,
			user_id: this.userId
		} as T;
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

	async update(id: string, patch: Partial<T>) {
		const doc = await this.collection.findOne(id).exec();

		if (!doc) {
			return 0;
		}

		await doc.incrementalPatch(this.withUserId(patch));
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

export async function getRxDexieLikeDatabase(userId: string): Promise<RxDexieLikeDatabase> {
	const existing = adaptersByUserId.get(userId);

	if (existing) {
		return existing;
	}

	const next = getTinyTrainRxDatabase(userId).then(async (database) => {
		await startSupabaseReplication(userId);

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

				return (callback as () => Promise<T> | T)();
			}
		};
	});

	adaptersByUserId.set(userId, next);
	return next;
}
