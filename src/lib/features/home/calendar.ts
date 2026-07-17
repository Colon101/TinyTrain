import { toDayKey } from '$lib/db';

export type CalendarCell = {
	date: Date;
	dayKey: string;
	isInMonth: boolean;
	isToday: boolean;
};

function getSafeDate(date?: Date | null) {
	if (date instanceof Date && !Number.isNaN(date.getTime())) {
		return date;
	}

	return new Date();
}

function atNoon(date?: Date | null) {
	const safeDate = getSafeDate(date);

	return new Date(safeDate.getFullYear(), safeDate.getMonth(), safeDate.getDate(), 12);
}

export function fromDayKey(dayKey: string) {
	return atNoon(new Date(`${dayKey}T12:00:00`));
}

export function startOfMonth(date?: Date | null) {
	const safeDate = getSafeDate(date);

	return atNoon(new Date(safeDate.getFullYear(), safeDate.getMonth(), 1));
}

export function addMonths(date: Date | null | undefined, delta: number) {
	const safeDate = getSafeDate(date);

	return atNoon(new Date(safeDate.getFullYear(), safeDate.getMonth() + delta, 1));
}

export function addDays(date: Date | null | undefined, delta: number) {
	const safeDate = getSafeDate(date);

	return atNoon(new Date(safeDate.getFullYear(), safeDate.getMonth(), safeDate.getDate() + delta));
}

export function startOfWeek(date?: Date | null) {
	const nextDate = atNoon(date);
	nextDate.setDate(nextDate.getDate() - nextDate.getDay());
	return nextDate;
}

export function addWeeks(date: Date | null | undefined, delta: number) {
	return addDays(date, delta * 7);
}

export function getMonthCacheKey(date?: Date | null) {
	const safeDate = getSafeDate(date);

	return `${safeDate.getFullYear()}-${String(safeDate.getMonth() + 1).padStart(2, '0')}`;
}

export function buildCalendarWeek(date?: Date | null) {
	const weekStart = startOfWeek(date);
	const todayKey = toDayKey(new Date());

	return Array.from({ length: 7 }, (_, dayIndex) => {
		const cellDate = addDays(weekStart, dayIndex);

		return {
			date: cellDate,
			dayKey: toDayKey(cellDate),
			isInMonth: true,
			isToday: toDayKey(cellDate) === todayKey
		};
	});
}

export function buildCalendarMonth(date?: Date | null) {
	const monthStart = startOfMonth(date);
	const firstVisible = atNoon(new Date(monthStart));
	firstVisible.setDate(monthStart.getDate() - monthStart.getDay());

	const cells: CalendarCell[] = [];
	const todayKey = toDayKey(new Date());

	for (let index = 0; index < 42; index += 1) {
		const cellDate = atNoon(new Date(firstVisible));
		cellDate.setDate(firstVisible.getDate() + index);
		cells.push({
			date: cellDate,
			dayKey: toDayKey(cellDate),
			isInMonth: cellDate.getMonth() === monthStart.getMonth(),
			isToday: toDayKey(cellDate) === todayKey
		});
	}

	return Array.from({ length: 6 }, (_, weekIndex) => cells.slice(weekIndex * 7, weekIndex * 7 + 7));
}
