import Dexie from 'dexie';
import dexieCloud, { type DexieCloudTable } from 'dexie-cloud-addon';
import { BASELINE_EXERCISES } from './exercises';

export type SessionStatus = 'planned' | 'in_progress' | 'completed' | 'abandoned';
export type ExerciseSource = 'baseline' | 'custom';

export interface Exercise {
	id: string;
	name: string;
	normalizedName: string;
	unilateral: boolean;
	source: ExerciseSource;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Workout {
	id: string;
	name: string;
	normalizedName: string;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface WorkoutExercise {
	id: string;
	workoutId: string;
	exerciseId: string;
	order: number;
	createdAt: string;
	updatedAt: string;
}

export interface WorkoutSession {
	id: string;
	workoutId: string;
	workoutNameSnapshot: string;
	dayKey: string;
	startedAt: string;
	completedAt?: string;
	status: SessionStatus;
	createdAt: string;
	updatedAt: string;
}

export interface SessionExercise {
	id: string;
	sessionId: string;
	workoutId: string;
	exerciseId: string;
	exerciseNameSnapshot: string;
	order: number;
	performedAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface SessionSet {
	id: string;
	sessionExerciseId: string;
	exerciseId: string;
	order: number;
	weight?: number;
	reps?: number;
	rir?: number;
	createdAt: string;
	updatedAt: string;
}

export interface ExerciseResetEvent {
	id: string;
	exerciseId: string;
	resetAt: string;
	createdAt: string;
}

export type WorkoutExerciseWithExercise = WorkoutExercise & {
	exercise: Exercise;
};

export type SessionSummary = WorkoutSession & {
	totalExercises: number;
	totalSets: number;
};

export type DayOverview = {
	dayKey: string;
	session: SessionSummary | null;
};

export type ExerciseListItem = {
	exercise: Exercise;
	historyCount: number;
	lastPerformedAt?: string;
	latestResetAt?: string;
};

export type ExerciseHistoryEntry = {
	sessionId: string;
	workoutId: string;
	workoutNameSnapshot: string;
	dayKey: string;
	startedAt: string;
	completedAt?: string;
	status: SessionStatus;
	sets: SessionSet[];
};

export type SessionExerciseDetail = SessionExercise & {
	sets: SessionSet[];
};

export type SessionOverview = {
	summary: SessionSummary;
	exercises: SessionExerciseDetail[];
};

export type ExerciseDetail = {
	exercise: Exercise;
	history: ExerciseHistoryEntry[];
	resetEvents: ExerciseResetEvent[];
};

export type BackfillSeedResult = {
	workoutId: string;
	sessionId: string;
	created: boolean;
};

const STORES = {
	exercises: '&id, &normalizedName, source, archived, updatedAt',
	workouts: '&id, &normalizedName, archived, updatedAt',
	workoutExercises: '&id, workoutId, exerciseId, [workoutId+order], [workoutId+exerciseId]',
	workoutSessions:
		'&id, workoutId, dayKey, startedAt, completedAt, status, [workoutId+startedAt], [dayKey+startedAt]',
	sessionExercises:
		'&id, sessionId, workoutId, exerciseId, performedAt, [sessionId+order], [exerciseId+performedAt], [workoutId+performedAt]',
	sessionSets:
		'&id, sessionExerciseId, exerciseId, createdAt, [sessionExerciseId+order], [exerciseId+createdAt]',
	exerciseResetEvents: '&id, exerciseId, resetAt, [exerciseId+resetAt], createdAt'
};

const SYNC_SAFE_STORES = {
	...STORES,
	exercises: '&id, normalizedName, source, archived, updatedAt'
};

const EXAMPLE_WORKOUT_NAME = 'Upper Builder Demo';
const EXAMPLE_EXERCISE_NAMES = ['Barbell Bench Press', 'Wide Grip Pull-up', 'Cable Lateral Raise'];
const BASELINE_EXERCISE_BY_NAME = new Map(
	BASELINE_EXERCISES.map((exercise) => [normalizeName(exercise.name), exercise])
);

class TinyTrainDatabase extends Dexie {
	exercises!: DexieCloudTable<Exercise, 'id'>;
	workouts!: DexieCloudTable<Workout, 'id'>;
	workoutExercises!: DexieCloudTable<WorkoutExercise, 'id'>;
	workoutSessions!: DexieCloudTable<WorkoutSession, 'id'>;
	sessionExercises!: DexieCloudTable<SessionExercise, 'id'>;
	sessionSets!: DexieCloudTable<SessionSet, 'id'>;
	exerciseResetEvents!: DexieCloudTable<ExerciseResetEvent, 'id'>;

	constructor() {
		super('tinytrain', { addons: [dexieCloud] });

		this.version(1).stores({
			exercises: '&id, &normalizedName, archived, updatedAt',
			workouts: '&id, &normalizedName, archived, updatedAt',
			workoutExercises: '&id, workoutId, exerciseId, [workoutId+order], [workoutId+exerciseId]',
			workoutSessions: '&id, workoutId, startedAt, completedAt, status, [workoutId+startedAt]',
			sessionExercises:
				'&id, sessionId, workoutId, exerciseId, performedAt, [sessionId+order], [exerciseId+performedAt], [workoutId+performedAt]',
			sessionSets:
				'&id, sessionExerciseId, exerciseId, createdAt, [sessionExerciseId+order], [exerciseId+createdAt]'
		});
		this.version(2)
			.stores({
				exercises: '&id, &normalizedName, archived, updatedAt',
				workouts: '&id, &normalizedName, archived, updatedAt',
				workoutExercises: '&id, workoutId, exerciseId, [workoutId+order], [workoutId+exerciseId]',
				workoutSessions: '&id, workoutId, startedAt, completedAt, status, [workoutId+startedAt]',
				sessionExercises:
					'&id, sessionId, workoutId, exerciseId, performedAt, [sessionId+order], [exerciseId+performedAt], [workoutId+performedAt]',
				sessionSets:
					'&id, sessionExerciseId, exerciseId, createdAt, [sessionExerciseId+order], [exerciseId+createdAt]'
			})
			.upgrade((transaction) => {
				return transaction
					.table('exercises')
					.toCollection()
					.modify((exercise: Partial<Exercise>) => {
						exercise.unilateral = Boolean(exercise.unilateral);
					});
			});
		this.version(3).stores({
			exercises: '&id, &normalizedName, archived, updatedAt',
			workouts: '&id, &normalizedName, archived, updatedAt',
			workoutExercises: '&id, workoutId, exerciseId, [workoutId+order], [workoutId+exerciseId]',
			workoutSessions: '&id, workoutId, startedAt, completedAt, status, [workoutId+startedAt]',
			sessionExercises:
				'&id, sessionId, workoutId, exerciseId, performedAt, [sessionId+order], [exerciseId+performedAt], [workoutId+performedAt]',
			sessionSets:
				'&id, sessionExerciseId, exerciseId, createdAt, [sessionExerciseId+order], [exerciseId+createdAt]'
		});
		this.version(4)
			.stores(STORES)
			.upgrade(async (transaction) => {
				await transaction
					.table('exercises')
					.toCollection()
					.modify((exercise: Partial<Exercise> & { name?: string; normalizedName?: string }) => {
						exercise.unilateral = Boolean(exercise.unilateral);
						exercise.normalizedName = normalizeName(exercise.name ?? exercise.normalizedName ?? '');
						exercise.source = inferExerciseSource(
							exercise.normalizedName || exercise.name || '',
							exercise.source
						);
					});

				await transaction
					.table('workoutSessions')
					.toCollection()
					.modify((session: Partial<WorkoutSession>) => {
						session.dayKey = toDayKey(session.startedAt ?? session.createdAt ?? new Date());
					});
			});
		this.version(5)
			.stores(STORES)
			.upgrade(async (transaction) => {
				await transaction
					.table('sessionSets')
					.toCollection()
					.modify(
						(
							sessionSet: Partial<SessionSet> & {
								weight?: unknown;
								reps?: unknown;
								rir?: unknown;
							}
						) => {
							const weight = toOptionalNumber(sessionSet.weight);
							const reps = toOptionalNumber(sessionSet.reps);
							const rir = toOptionalNumber(sessionSet.rir);

							if (weight === undefined) {
								delete sessionSet.weight;
							} else {
								sessionSet.weight = weight;
							}

							if (reps === undefined) {
								delete sessionSet.reps;
							} else {
								sessionSet.reps = reps;
							}

							if (rir === undefined) {
								delete sessionSet.rir;
							} else {
								sessionSet.rir = rir;
							}
						}
					);
			});
		this.version(6)
			.stores(SYNC_SAFE_STORES)
			.upgrade(async (transaction) => {
				await transaction
					.table('exercises')
					.toCollection()
					.modify((exercise: Partial<Exercise> & { name?: string; normalizedName?: string }) => {
						exercise.normalizedName = normalizeName(exercise.name ?? exercise.normalizedName ?? '');
						exercise.source = inferExerciseSource(
							exercise.normalizedName || exercise.name || '',
							exercise.source
						);
					});
			});

		this.cloud.configure({
			databaseUrl: 'https://zpai2umlq.dexie.cloud',
			nameSuffix: false,
			tryUseServiceWorker: true,
			periodicSync: {
				minInterval: 6 * 60 * 60 * 1000
			}
		});
	}
}

export const db = new TinyTrainDatabase();
let dbOpenPromise: Promise<TinyTrainDatabase> | null = null;

export type PersistentStorageStatus = 'persisted' | 'promptable' | 'denied' | 'unsupported';

export async function getPersistentStorageStatus(): Promise<PersistentStorageStatus> {
	if (!globalThis.navigator?.storage?.persisted) {
		return 'unsupported';
	}

	return (await navigator.storage.persisted()) ? 'persisted' : 'promptable';
}

export async function requestPersistentStorage(): Promise<PersistentStorageStatus> {
	if (!globalThis.navigator?.storage?.persisted || !globalThis.navigator.storage.persist) {
		return 'unsupported';
	}

	if (await navigator.storage.persisted()) {
		return 'persisted';
	}

	return (await navigator.storage.persist()) ? 'persisted' : 'denied';
}

export async function loginWithGoogle(redirectPath = '/') {
	await db.cloud.login({ provider: 'google', redirectPath });
}

export async function ensureDbOpen() {
	if (!dbOpenPromise) {
		dbOpenPromise = db
			.open()
			.then(() => db)
			.catch((error) => {
				dbOpenPromise = null;
				throw error;
			});
	}

	return dbOpenPromise;
}

export async function logoutFromCloud() {
	await ensureDbOpen();
	await db.cloud.logout();
}

export async function syncNow() {
	await ensureDbOpen();
	await db.cloud.sync();
}

export function toDayKey(input: Date | string) {
	const date = toValidDate(input);

	return [
		String(date.getFullYear()).padStart(4, '0'),
		String(date.getMonth() + 1).padStart(2, '0'),
		String(date.getDate()).padStart(2, '0')
	].join('-');
}

function toValidDate(input: Date | string) {
	const date = input instanceof Date ? new Date(input) : new Date(input);

	if (Number.isNaN(date.getTime())) {
		return new Date();
	}

	return date;
}

function requireLoggedInUser() {
	if (!db.cloud.currentUser.value?.isLoggedIn) {
		throw new Error('Sign in with Google to save workouts.');
	}
}

function timestamp(date = new Date()) {
	return date.toISOString();
}

function isDefined<T>(value: T): value is NonNullable<T> {
	return value !== undefined && value !== null;
}

function createId() {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}

	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeName(name: string) {
	return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function displayName(name: string) {
	return name.trim().replace(/\s+/g, ' ');
}

function inferExerciseSource(nameOrNormalizedName: string, source?: ExerciseSource) {
	if (source) {
		return source;
	}

	return BASELINE_EXERCISE_BY_NAME.has(normalizeName(nameOrNormalizedName)) ? 'baseline' : 'custom';
}

function withExerciseDefaults(exercise: Exercise): Exercise {
	return {
		...exercise,
		unilateral: Boolean(exercise.unilateral),
		source: inferExerciseSource(exercise.normalizedName || exercise.name, exercise.source)
	};
}

function compareExercises(first: Exercise, second: Exercise) {
	if (first.archived !== second.archived) {
		return Number(first.archived) - Number(second.archived);
	}

	if (first.source !== second.source) {
		return first.source === 'baseline' ? -1 : 1;
	}

	if (first.updatedAt !== second.updatedAt) {
		return second.updatedAt.localeCompare(first.updatedAt);
	}

	if (first.createdAt !== second.createdAt) {
		return first.createdAt.localeCompare(second.createdAt);
	}

	return first.id.localeCompare(second.id);
}

function pickPreferredExercise(exercises: Exercise[]) {
	return exercises.map(withExerciseDefaults).sort(compareExercises)[0] ?? null;
}

function dedupeExercises(exercises: Exercise[]) {
	const exerciseByNormalizedName = new Map<string, Exercise>();

	for (const exercise of exercises.map(withExerciseDefaults)) {
		const existingExercise = exerciseByNormalizedName.get(exercise.normalizedName);

		if (!existingExercise || compareExercises(exercise, existingExercise) < 0) {
			exerciseByNormalizedName.set(exercise.normalizedName, exercise);
		}
	}

	return [...exerciseByNormalizedName.values()];
}

function toOptionalNumber(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function withSessionSetDefaults(sessionSet: SessionSet): SessionSet {
	return {
		...sessionSet,
		weight: toOptionalNumber(sessionSet.weight),
		reps: toOptionalNumber(sessionSet.reps),
		rir: toOptionalNumber(sessionSet.rir)
	};
}

function createExerciseRow(
	name: string,
	unilateral = false,
	source: ExerciseSource = 'custom',
	now = timestamp(),
	id = createId()
): Exercise {
	const cleanName = displayName(name);

	return {
		id,
		name: cleanName,
		unilateral,
		source,
		normalizedName: normalizeName(cleanName),
		archived: false,
		createdAt: now,
		updatedAt: now
	};
}

function createBaselineExerciseId(normalizedName: string) {
	return `baseline:${normalizedName}`;
}

function summarizeSession(
	session: WorkoutSession,
	sessionExercises: SessionExercise[],
	sessionSets: SessionSet[]
): SessionSummary {
	return {
		...session,
		dayKey: session.dayKey || toDayKey(session.startedAt || session.createdAt),
		totalExercises: sessionExercises.length,
		totalSets: sessionSets.length
	};
}

async function getSessionSummariesByIds(sessionIds: string[]) {
	if (sessionIds.length === 0) {
		return new Map<string, SessionSummary>();
	}

	const sessions = (await db.workoutSessions.bulkGet(sessionIds)).filter(isDefined);
	const sessionExercises = await db.sessionExercises.where('sessionId').anyOf(sessionIds).toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: (await db.sessionSets
					.where('sessionExerciseId')
					.anyOf(sessionExerciseIds)
					.toArray()
			  ).map(withSessionSetDefaults);
	const sessionExercisesBySessionId = new Map<string, SessionExercise[]>();
	const sessionSetsBySessionId = new Map<string, SessionSet[]>();
	const sessionExerciseById = new Map(
		sessionExercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
	);

	for (const sessionExercise of sessionExercises) {
		const rows = sessionExercisesBySessionId.get(sessionExercise.sessionId) ?? [];
		rows.push(sessionExercise);
		sessionExercisesBySessionId.set(sessionExercise.sessionId, rows);
	}

	for (const sessionSet of sessionSets) {
		const sessionExercise = sessionExerciseById.get(sessionSet.sessionExerciseId);

		if (!sessionExercise) {
			continue;
		}

		const rows = sessionSetsBySessionId.get(sessionExercise.sessionId) ?? [];
		rows.push(sessionSet);
		sessionSetsBySessionId.set(sessionExercise.sessionId, rows);
	}

	return new Map(
		sessions.map((session) => [
			session.id,
			summarizeSession(
				session,
				sessionExercisesBySessionId.get(session.id) ?? [],
				sessionSetsBySessionId.get(session.id) ?? []
			)
		])
	);
}

export async function ensureBaselineExercises() {
	requireLoggedInUser();

	const normalizedNames = [...BASELINE_EXERCISE_BY_NAME.keys()];
	const existingExercises = await db.exercises
		.where('normalizedName')
		.anyOf(normalizedNames)
		.toArray();
	const existingNames = new Set(existingExercises.map((exercise) => exercise.normalizedName));
	const now = timestamp();
	const missingExercisesByName = new Map<string, Exercise>();

	for (const exercise of BASELINE_EXERCISES) {
		const normalizedName = normalizeName(exercise.name);

		if (existingNames.has(normalizedName) || missingExercisesByName.has(normalizedName)) {
			continue;
		}

		missingExercisesByName.set(
			normalizedName,
			createExerciseRow(
				exercise.name,
				exercise.unilateral,
				'baseline',
				now,
				createBaselineExerciseId(normalizedName)
			)
		);
	}

	const missingExercises = [...missingExercisesByName.values()];

	if (missingExercises.length > 0) {
		await db.exercises.bulkAdd(missingExercises);
	}
}

export async function listExercises() {
	const exercises = dedupeExercises(await db.exercises.toArray());

	return exercises
		.filter((exercise) => !exercise.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function listCustomExercises() {
	const exercises = dedupeExercises(await db.exercises.toArray());

	return exercises
		.filter((exercise) => !exercise.archived && exercise.source === 'custom')
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function listCustomExerciseItems(): Promise<ExerciseListItem[]> {
	const exercises = await listCustomExercises();
	const exerciseIds = exercises.map((exercise) => exercise.id);

	if (exerciseIds.length === 0) {
		return [];
	}

	const [sessionExercises, resetEvents] = await Promise.all([
		db.sessionExercises.where('exerciseId').anyOf(exerciseIds).toArray(),
		db.exerciseResetEvents.where('exerciseId').anyOf(exerciseIds).toArray()
	]);

	const historyByExerciseId = new Map<string, Set<string>>();
	const lastPerformedAtByExerciseId = new Map<string, string>();
	const latestResetAtByExerciseId = new Map<string, string>();

	for (const sessionExercise of sessionExercises) {
		const historySessions =
			historyByExerciseId.get(sessionExercise.exerciseId) ?? new Set<string>();
		historySessions.add(sessionExercise.sessionId);
		historyByExerciseId.set(sessionExercise.exerciseId, historySessions);

		const currentValue = lastPerformedAtByExerciseId.get(sessionExercise.exerciseId);

		if (!currentValue || currentValue < sessionExercise.performedAt) {
			lastPerformedAtByExerciseId.set(sessionExercise.exerciseId, sessionExercise.performedAt);
		}
	}

	for (const resetEvent of resetEvents) {
		const currentValue = latestResetAtByExerciseId.get(resetEvent.exerciseId);

		if (!currentValue || currentValue < resetEvent.resetAt) {
			latestResetAtByExerciseId.set(resetEvent.exerciseId, resetEvent.resetAt);
		}
	}

	return exercises.map((exercise) => ({
		exercise,
		historyCount: historyByExerciseId.get(exercise.id)?.size ?? 0,
		lastPerformedAt: lastPerformedAtByExerciseId.get(exercise.id),
		latestResetAt: latestResetAtByExerciseId.get(exercise.id)
	}));
}

export async function getExercise(exerciseId: string) {
	const exercise = await db.exercises.get(exerciseId);

	return exercise ? withExerciseDefaults(exercise) : null;
}

export async function createExercise(name: string, unilateral = false) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	const existingExercise = pickPreferredExercise(
		await db.exercises.where('normalizedName').equals(normalizedName).toArray()
	);

	if (existingExercise) {
		if (existingExercise.archived) {
			const updatedAt = timestamp();
			await db.exercises.update(existingExercise.id, {
				archived: false,
				unilateral,
				updatedAt
			});

			return withExerciseDefaults({ ...existingExercise, archived: false, unilateral, updatedAt });
		}

		return withExerciseDefaults(existingExercise);
	}

	const exercise = createExerciseRow(cleanName, unilateral, inferExerciseSource(normalizedName));
	await db.exercises.add(exercise);

	return exercise;
}

export async function createCustomExercise(name: string, unilateral = false) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	const matchingExercises = (await db.exercises.where('normalizedName').equals(normalizedName).toArray()).map(
		withExerciseDefaults
	);
	const existingExercise = pickPreferredExercise(matchingExercises);

	if (matchingExercises.some((exercise) => exercise.source === 'baseline')) {
		throw new Error('That name already belongs to a built-in exercise.');
	}

	if (existingExercise) {
		if (existingExercise.archived) {
			const updatedAt = timestamp();
			await db.exercises.update(existingExercise.id, {
				archived: false,
				unilateral,
				updatedAt
			});

			return withExerciseDefaults({ ...existingExercise, archived: false, unilateral, updatedAt });
		}

		return withExerciseDefaults(existingExercise);
	}

	const exercise = createExerciseRow(cleanName, unilateral, 'custom');
	await db.exercises.add(exercise);

	return exercise;
}

export async function setExerciseUnilateral(exerciseId: string, unilateral: boolean) {
	requireLoggedInUser();

	const exercise = await db.exercises.get(exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const updatedAt = timestamp();
	await db.exercises.update(exerciseId, { unilateral, updatedAt });

	return withExerciseDefaults({ ...exercise, unilateral, updatedAt });
}

export async function recordExerciseReset(exerciseId: string) {
	requireLoggedInUser();

	const exercise = await db.exercises.get(exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const now = timestamp();
	const resetEvent: ExerciseResetEvent = {
		id: createId(),
		exerciseId,
		resetAt: now,
		createdAt: now
	};

	await db.exerciseResetEvents.add(resetEvent);

	return resetEvent;
}

export async function listExerciseResetEvents(exerciseId: string) {
	const resetEvents = await db.exerciseResetEvents.where('exerciseId').equals(exerciseId).toArray();

	return resetEvents.sort((first, second) => second.resetAt.localeCompare(first.resetAt));
}

export async function listExerciseHistory(exerciseId: string): Promise<ExerciseHistoryEntry[]> {
	const sessionExercises = await db.sessionExercises
		.where('exerciseId')
		.equals(exerciseId)
		.toArray();

	if (sessionExercises.length === 0) {
		return [];
	}

	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const [sessions, sessionSets] = await Promise.all([
		db.workoutSessions.bulkGet(sessionIds),
		db.sessionSets
			.where('sessionExerciseId')
			.anyOf(sessionExercises.map((sessionExercise) => sessionExercise.id))
			.toArray()
			.then((rows) => rows.map(withSessionSetDefaults))
	]);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of sessionSets) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	const historyBySessionId = new Map<string, ExerciseHistoryEntry>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (!session) {
			continue;
		}

		const sets = (setsBySessionExerciseId.get(sessionExercise.id) ?? []).sort(
			(first, second) => first.order - second.order
		);
		const existing = historyBySessionId.get(session.id);

		if (existing) {
			existing.sets = [...existing.sets, ...sets].sort(
				(first, second) => first.order - second.order
			);
			continue;
		}

		historyBySessionId.set(session.id, {
			sessionId: session.id,
			workoutId: session.workoutId,
			workoutNameSnapshot: session.workoutNameSnapshot,
			dayKey: session.dayKey || toDayKey(session.startedAt || session.createdAt),
			startedAt: session.startedAt,
			completedAt: session.completedAt,
			status: session.status,
			sets
		});
	}

	return [...historyBySessionId.values()].sort((first, second) =>
		second.startedAt.localeCompare(first.startedAt)
	);
}

export async function getExerciseDetail(exerciseId: string): Promise<ExerciseDetail | null> {
	const [exercise, history, resetEvents] = await Promise.all([
		getExercise(exerciseId),
		listExerciseHistory(exerciseId),
		listExerciseResetEvents(exerciseId)
	]);

	if (!exercise) {
		return null;
	}

	return {
		exercise,
		history,
		resetEvents
	};
}

export async function listWorkouts() {
	const workouts = await db.workouts.toArray();

	return workouts
		.filter((workout) => !workout.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function createWorkout(name: string) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Workout name is required.');
	}

	const existingWorkout = await db.workouts.where('normalizedName').equals(normalizedName).first();

	if (existingWorkout) {
		if (existingWorkout.archived) {
			const updatedAt = timestamp();
			await db.workouts.update(existingWorkout.id, { archived: false, updatedAt });

			return { ...existingWorkout, archived: false, updatedAt };
		}

		return existingWorkout;
	}

	const now = timestamp();
	const workout: Workout = {
		id: createId(),
		name: cleanName,
		normalizedName,
		archived: false,
		createdAt: now,
		updatedAt: now
	};

	await db.workouts.add(workout);

	return workout;
}

export async function listWorkoutExercises(workoutId: string) {
	const workoutExerciseRows = await db.workoutExercises
		.where('workoutId')
		.equals(workoutId)
		.sortBy('order');
	const exercises = await db.exercises.bulkGet(
		workoutExerciseRows.map((workoutExercise) => workoutExercise.exerciseId)
	);
	const exerciseById = new Map(
		exercises
			.filter(isDefined)
			.map((exercise) => withExerciseDefaults(exercise))
			.map((exercise) => [exercise.id, exercise])
	);

	return workoutExerciseRows
		.map<WorkoutExerciseWithExercise | null>((workoutExercise) => {
			const exercise = exerciseById.get(workoutExercise.exerciseId);

			if (!exercise || exercise.archived) {
				return null;
			}

			return { ...workoutExercise, exercise };
		})
		.filter((workoutExercise): workoutExercise is WorkoutExerciseWithExercise =>
			Boolean(workoutExercise)
		);
}

export async function addExerciseToWorkout(workoutId: string, exerciseId: string) {
	requireLoggedInUser();

	return db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const existingWorkoutExercise = await db.workoutExercises
			.where('[workoutId+exerciseId]')
			.equals([workoutId, exerciseId])
			.first();

		if (existingWorkoutExercise) {
			return existingWorkoutExercise;
		}

		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutId)
			.toArray();
		const nextOrder =
			workoutExercises.reduce(
				(highestOrder, workoutExercise) => Math.max(highestOrder, workoutExercise.order),
				0
			) + 1;
		const now = timestamp();
		const workoutExercise: WorkoutExercise = {
			id: createId(),
			workoutId,
			exerciseId,
			order: nextOrder,
			createdAt: now,
			updatedAt: now
		};

		await db.workoutExercises.add(workoutExercise);
		await db.workouts.update(workoutId, { updatedAt: now });

		return workoutExercise;
	});
}

export async function reorderWorkoutExercises(
	workoutId: string,
	orderedWorkoutExerciseIds: string[]
) {
	requireLoggedInUser();

	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutId)
			.toArray();
		const workoutExerciseById = new Map(
			workoutExercises.map((workoutExercise) => [workoutExercise.id, workoutExercise])
		);
		const orderedIds = orderedWorkoutExerciseIds.filter((id) => workoutExerciseById.has(id));
		const orderedIdSet = new Set(orderedIds);
		const missingIds = workoutExercises
			.filter((workoutExercise) => !orderedIdSet.has(workoutExercise.id))
			.sort((first, second) => first.order - second.order)
			.map((workoutExercise) => workoutExercise.id);
		const nextIds = [...orderedIds, ...missingIds];
		const now = timestamp();

		await Promise.all(
			nextIds.map((id, index) =>
				db.workoutExercises.update(id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workouts.update(workoutId, { updatedAt: now });
	});
}

export async function moveWorkoutExercise(workoutExerciseId: string, direction: 'up' | 'down') {
	requireLoggedInUser();

	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercise = await db.workoutExercises.get(workoutExerciseId);

		if (!workoutExercise) {
			return;
		}

		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutExercise.workoutId)
			.sortBy('order');
		const currentIndex = workoutExercises.findIndex((row) => row.id === workoutExerciseId);
		const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

		if (currentIndex < 0 || targetIndex < 0 || targetIndex >= workoutExercises.length) {
			return;
		}

		const currentRow = workoutExercises[currentIndex];
		const targetRow = workoutExercises[targetIndex];
		const now = timestamp();

		await Promise.all([
			db.workoutExercises.update(currentRow.id, { order: targetRow.order, updatedAt: now }),
			db.workoutExercises.update(targetRow.id, { order: currentRow.order, updatedAt: now }),
			db.workouts.update(workoutExercise.workoutId, { updatedAt: now })
		]);
	});
}

export async function removeWorkoutExercise(workoutExerciseId: string) {
	requireLoggedInUser();

	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercise = await db.workoutExercises.get(workoutExerciseId);

		if (!workoutExercise) {
			return;
		}

		const now = timestamp();

		await db.workoutExercises.delete(workoutExerciseId);

		const remainingWorkoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutExercise.workoutId)
			.sortBy('order');

		await Promise.all(
			remainingWorkoutExercises.map((remainingWorkoutExercise, index) =>
				db.workoutExercises.update(remainingWorkoutExercise.id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workouts.update(workoutExercise.workoutId, { updatedAt: now });
	});
}

export async function listSessionSummariesForMonth(monthDate: Date) {
	const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
	const end = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
	const sessions = await db.workoutSessions
		.where('dayKey')
		.between(toDayKey(start), toDayKey(end), true, true)
		.toArray();

	return [...(await getSessionSummariesByIds(sessions.map((session) => session.id))).values()].sort(
		(first, second) => first.startedAt.localeCompare(second.startedAt)
	);
}

export async function getDayOverview(dayKey: string): Promise<DayOverview> {
	const sessions = await db.workoutSessions.where('dayKey').equals(dayKey).sortBy('startedAt');
	const latestSession = sessions.at(-1) ?? null;

	if (!latestSession) {
		return {
			dayKey,
			session: null
		};
	}

	const summaries = await getSessionSummariesByIds([latestSession.id]);

	return {
		dayKey,
		session: summaries.get(latestSession.id) ?? null
	};
}

export async function getSessionOverview(sessionId: string): Promise<SessionOverview | null> {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	const sessionExercises = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.sortBy('order');
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: (await db.sessionSets
					.where('sessionExerciseId')
					.anyOf(sessionExerciseIds)
					.toArray()
			  ).map(withSessionSetDefaults);
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of sessionSets) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	return {
		summary: summarizeSession(session, sessionExercises, sessionSets),
		exercises: sessionExercises.map((sessionExercise) => ({
			...sessionExercise,
			sets: (setsBySessionExerciseId.get(sessionExercise.id) ?? []).sort(
				(first, second) => first.order - second.order
			)
		}))
	};
}

function createExampleStartedAt(daysAgo: number, hours: number, minutes: number) {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(hours, minutes, 0, 0);

	return date;
}

export async function seedExampleBackfill(): Promise<BackfillSeedResult> {
	requireLoggedInUser();

	await ensureBaselineExercises();

	const workout = await createWorkout(EXAMPLE_WORKOUT_NAME);
	const normalizedNames = EXAMPLE_EXERCISE_NAMES.map((name) => normalizeName(name));
	const exercises = await db.exercises.where('normalizedName').anyOf(normalizedNames).toArray();
	const exerciseByName = new Map(exercises.map((exercise) => [exercise.normalizedName, exercise]));

	for (const name of EXAMPLE_EXERCISE_NAMES) {
		const exercise = exerciseByName.get(normalizeName(name));

		if (exercise) {
			await addExerciseToWorkout(workout.id, exercise.id);
		}
	}

	const startedAtDate = createExampleStartedAt(2, 18, 10);
	const completedAtDate = createExampleStartedAt(2, 18, 58);
	const dayKey = toDayKey(startedAtDate);
	const existingSession = (await db.workoutSessions.where('dayKey').equals(dayKey).toArray()).find(
		(session) =>
			session.workoutId === workout.id && session.workoutNameSnapshot === EXAMPLE_WORKOUT_NAME
	);

	if (existingSession) {
		return {
			workoutId: workout.id,
			sessionId: existingSession.id,
			created: false
		};
	}

	const startedAt = timestamp(startedAtDate);
	const completedAt = timestamp(completedAtDate);
	const sessionId = createId();
	const session: WorkoutSession = {
		id: sessionId,
		workoutId: workout.id,
		workoutNameSnapshot: workout.name,
		dayKey,
		startedAt,
		completedAt,
		status: 'completed',
		createdAt: startedAt,
		updatedAt: completedAt
	};

	await db.workoutSessions.add(session);

	const pickedExercises = EXAMPLE_EXERCISE_NAMES.map((name) =>
		exerciseByName.get(normalizeName(name))
	).filter(isDefined);
	const sessionExercises: SessionExercise[] = pickedExercises.map((exercise, index) => ({
		id: createId(),
		sessionId,
		workoutId: workout.id,
		exerciseId: exercise.id,
		exerciseNameSnapshot: exercise.name,
		order: index + 1,
		performedAt: timestamp(new Date(startedAtDate.getTime() + index * 12 * 60 * 1000)),
		createdAt: startedAt,
		updatedAt: completedAt
	}));

	await db.sessionExercises.bulkAdd(sessionExercises);

	const setsByExercise = [
		[
			{ weight: 60, reps: 8 },
			{ weight: 65, reps: 8 },
			{ weight: 67.5, reps: 6 }
		],
		[
			{ weight: 0, reps: 10 },
			{ weight: 0, reps: 9 },
			{ weight: 0, reps: 8 }
		],
		[
			{ weight: 10, reps: 15 },
			{ weight: 12.5, reps: 12 },
			{ weight: 12.5, reps: 12 }
		]
	];

	await db.sessionSets.bulkAdd(
		sessionExercises.flatMap((sessionExercise, exerciseIndex) =>
			(setsByExercise[exerciseIndex] ?? []).map((set, setIndex) => ({
				id: createId(),
				sessionExerciseId: sessionExercise.id,
				exerciseId: sessionExercise.exerciseId,
				order: setIndex + 1,
				weight: set.weight,
				reps: set.reps,
				createdAt: timestamp(
					new Date(startedAtDate.getTime() + (exerciseIndex * 12 + setIndex * 3) * 60 * 1000)
				),
				updatedAt: completedAt
			}))
		)
	);

	return {
		workoutId: workout.id,
		sessionId,
		created: true
	};
}
