<script lang="ts">
	import { onMount } from 'svelte';
	import type { DayOverview, SessionSummary } from '$lib/db';
	import { toDayKey } from '$lib/db';
	import InstallPrompt from '$lib/InstallPrompt.svelte';
	import ProfileMenu from '$lib/features/app/ProfileMenu.svelte';
	import type { CloudUser } from '$lib/features/app/user';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		addMonths,
		addWeeks,
		fromDayKey,
		getMonthCacheKey,
		startOfMonth,
		startOfWeek
	} from './calendar';
	import DayOverviewPanel from './DayOverviewPanel.svelte';
	import DayPickerSheet from './DayPickerSheet.svelte';
	import HomeCalendar from './HomeCalendar.svelte';

	type DatabaseApi = typeof import('$lib/db');
	type SessionCache = Record<string, SessionSummary[]>;
	type SubscriptionLike = {
		unsubscribe(): void;
	};

	let api = $state<DatabaseApi | null>(null);
	let currentUser = $state<CloudUser>({ isLoading: true });
	let isLoading = $state(true);
	let errorMessage = $state('');
	let selectedDayKey = $state(toDayKey(new Date()));
	let visibleWeekDate = $state(startOfWeek(new Date()));
	let pickerMonthDate = $state(startOfMonth(new Date()));
	let isDayPickerOpen = $state(false);
	let weekSlideDirection = $state<-1 | 0 | 1>(0);
	let sessionsByMonthKey = $state<SessionCache>({});
	let dayOverview = $state<DayOverview | null>(null);

	let sessionByDayKey = $derived.by(() => {
		const nextMap = new Map<string, SessionSummary>();

		for (const monthSessions of Object.values(sessionsByMonthKey)) {
			for (const session of monthSessions) {
				const existing = nextMap.get(session.dayKey);

				if (!existing || existing.startedAt < session.startedAt) {
					nextMap.set(session.dayKey, session);
				}
			}
		}

		return nextMap;
	});

	onMount(() => {
		let disposed = false;
		let currentUserSubscription: SubscriptionLike | null = null;

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (disposed) {
					return;
				}

				api = dbApi;
				currentUserSubscription = dbApi.db.cloud.currentUser.subscribe((nextUser) => {
					currentUser = nextUser;
				});
				await ensureWeekLoaded(visibleWeekDate);
				dayOverview = await dbApi.getDayOverview(selectedDayKey);
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
			} finally {
				isLoading = false;
			}
		})();

		return () => {
			disposed = true;
			currentUserSubscription?.unsubscribe();
		};
	});

	async function ensureMonthLoaded(monthDate: Date) {
		if (!api) {
			return;
		}

		const monthKey = getMonthCacheKey(monthDate);

		if (sessionsByMonthKey[monthKey]) {
			return;
		}

		const sessions = await api.listSessionSummariesForMonth(monthDate);
		sessionsByMonthKey = {
			...sessionsByMonthKey,
			[monthKey]: sessions
		};
	}

	async function ensureWeekLoaded(weekDate: Date) {
		const monthStarts = new Map<string, Date>();

		for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
			const dayDate = new Date(weekDate);
			dayDate.setDate(weekDate.getDate() + dayIndex);
			const monthDate = startOfMonth(dayDate);
			monthStarts.set(getMonthCacheKey(monthDate), monthDate);
		}

		await Promise.all([...monthStarts.values()].map((monthDate) => ensureMonthLoaded(monthDate)));
	}

	async function updateSelectedDay(dayKey: string, nextSlideDirection: -1 | 0 | 1 = 0) {
		if (!api) {
			return;
		}

		const nextWeekDate = startOfWeek(fromDayKey(dayKey));
		selectedDayKey = dayKey;
		visibleWeekDate = nextWeekDate;
		pickerMonthDate = startOfMonth(fromDayKey(dayKey));
		weekSlideDirection = nextSlideDirection;

		try {
			await ensureWeekLoaded(nextWeekDate);
			dayOverview = await api.getDayOverview(dayKey);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Something went wrong.';
		}
	}

	function selectDay(dayKey: string) {
		void updateSelectedDay(dayKey);
	}

	function shiftWeek(delta: -1 | 1) {
		const nextDay = addWeeks(fromDayKey(selectedDayKey), delta);
		void updateSelectedDay(toDayKey(nextDay), delta);
	}

	function openDayPicker() {
		pickerMonthDate = startOfMonth(fromDayKey(selectedDayKey));
		isDayPickerOpen = true;
		void ensureMonthLoaded(pickerMonthDate);
	}

	function closeDayPicker() {
		isDayPickerOpen = false;
	}

	function showPreviousPickerMonth() {
		const nextMonthDate = addMonths(pickerMonthDate, -1);
		pickerMonthDate = nextMonthDate;
		void ensureMonthLoaded(nextMonthDate);
	}

	function showNextPickerMonth() {
		const nextMonthDate = addMonths(pickerMonthDate, 1);
		pickerMonthDate = nextMonthDate;
		void ensureMonthLoaded(nextMonthDate);
	}
</script>

<section class="flex flex-1 flex-col">
	<div class="flex items-center justify-between gap-3 pb-3">
		<p class="text-lg font-semibold text-white">TinyTrain</p>

		<div class="flex items-center gap-2">
			<button
				class="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-200 transition hover:border-emerald-300/40 hover:bg-white/[0.08]"
				type="button"
				title="Open calendar"
				onclick={openDayPicker}
			>
				<Icon name="calendar" class="h-4 w-4" />
			</button>
			<ProfileMenu user={currentUser} />
		</div>
	</div>

	{#if errorMessage}
		<p
			class="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
			role="alert"
		>
			{errorMessage}
		</p>
	{:else if isLoading}
		<section class="flex flex-1 flex-col justify-center">
			<div class="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
				<div class="h-full w-1/2 animate-pulse rounded-full bg-emerald-300"></div>
			</div>
			<h2 class="mt-5 text-2xl font-semibold text-white">Loading</h2>
		</section>
	{:else}
		<HomeCalendar
			weekDate={visibleWeekDate}
			{selectedDayKey}
			{sessionByDayKey}
			slideDirection={weekSlideDirection}
			onSelectDay={selectDay}
			onShiftWeek={shiftWeek}
		/>

		<DayOverviewPanel overview={dayOverview} />

		<div class="mt-auto grid gap-3 pt-4">
			<a
				class="flex min-h-12 items-center justify-between rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950"
				href="/workouts"
			>
				<span class="flex items-center gap-3">
					<Icon name="dumbbell" class="h-5 w-5" />
					Open workouts
				</span>
				<Icon name="arrow-right" class="h-4 w-4" />
			</a>
			<a
				class="flex min-h-12 items-center justify-between rounded-lg border border-white/10 bg-white/[0.04] px-4 text-base font-semibold text-white"
				href="/exercises"
			>
				<span class="flex items-center gap-3">
					<Icon name="activity" class="h-5 w-5 text-emerald-200" />
					Open exercises
				</span>
				<Icon name="arrow-right" class="h-4 w-4" />
			</a>

			<InstallPrompt />
		</div>
	{/if}
</section>

{#if isDayPickerOpen}
	<DayPickerSheet
		monthDate={pickerMonthDate}
		{selectedDayKey}
		{sessionByDayKey}
		onSelectDay={selectDay}
		onClose={closeDayPicker}
		onPreviousMonth={showPreviousPickerMonth}
		onNextMonth={showNextPickerMonth}
	/>
{/if}
