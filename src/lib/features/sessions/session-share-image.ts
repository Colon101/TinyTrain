import type { SessionExerciseOverview, SessionOverview, SessionSetOverview } from '$lib/db';
import { formatDayHeading, formatDuration, formatSessionTime } from './session-format';
import { formatSetCellValue, getPerformedSets } from './session-overview';

type Point = {
	x: number;
	y: number;
};

type DrawnCell = {
	main: string;
	delta: string;
	tone: 'up' | 'down' | 'muted';
};

const IMAGE_WIDTH = 560;
const OUTER_PADDING = 24;
const HEADER_HEIGHT = 252;
const FOOTER_HEIGHT = 52;
const CARD_PADDING = 18;
const CARD_RADIUS = 16;
const EXERCISE_GAP = 14;
const TABLE_ROW_HEIGHT = 40;
const STAT_PILL_GAP = 14;
const STAT_PILL_WIDTH = (IMAGE_WIDTH - OUTER_PADDING * 2 - STAT_PILL_GAP) / 2;
const COLORS = {
	page: '#070a0d',
	panel: '#0f1519',
	panelSoft: '#121a20',
	line: '#27313a',
	lineSoft: '#1c252c',
	text: '#f4f4f5',
	muted: '#a1a1aa',
	subtle: '#71717a',
	emerald: '#6ee7b7',
	red: '#fca5a5',
	amber: '#fcd34d'
};

export async function renderSessionShareImage(
	overview: SessionOverview,
	nowMs = Date.now(),
	previousOverview: SessionOverview | null = null
): Promise<Blob> {
	await document.fonts?.ready;

	const layoutHeight = getImageHeight(overview);
	const canvas = document.createElement('canvas');
	canvas.width = IMAGE_WIDTH;
	canvas.height = layoutHeight;

	const ctx = canvas.getContext('2d');

	if (!ctx) {
		throw new Error('Image rendering is not available in this browser.');
	}

	ctx.fillStyle = COLORS.page;
	ctx.fillRect(0, 0, IMAGE_WIDTH, layoutHeight);

	drawHeader(ctx, overview, nowMs, previousOverview);
	drawExercises(ctx, overview);
	drawWatermark(ctx, layoutHeight);

	const blob = await canvasToBlob(canvas);

	if (!blob) {
		throw new Error('Could not create the session image.');
	}

	return blob;
}

export async function shareOrDownloadSessionImage(
	overview: SessionOverview,
	nowMs = Date.now(),
	previousOverview: SessionOverview | null = null
) {
	const blob = await renderSessionShareImage(overview, nowMs, previousOverview);
	const fileName = getSessionImageFileName(overview);
	const file = new File([blob], fileName, { type: blob.type || 'image/png' });
	const shareData: ShareData = {
		title: `${overview.summary.workoutNameSnapshot} on TinyTrain`,
		text: 'TinyTrain session overview',
		files: [file]
	};

	if (navigator.canShare?.(shareData)) {
		try {
			await navigator.share(shareData);
			return;
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				throw error;
			}
		}
	}

	downloadBlob(blob, fileName);
}

function getImageHeight(overview: SessionOverview) {
	const exerciseHeights = overview.exercises.reduce((total, sessionExercise) => {
		return total + getExerciseCardHeight(sessionExercise) + EXERCISE_GAP;
	}, 0);

	return OUTER_PADDING + HEADER_HEIGHT + exerciseHeights + FOOTER_HEIGHT;
}

function getExerciseCardHeight(sessionExercise: SessionExerciseOverview) {
	const sets = getPerformedSets(sessionExercise);
	const rowCount = Math.max(sets.length, 1);
	return CARD_PADDING + 38 + 28 + rowCount * TABLE_ROW_HEIGHT + CARD_PADDING;
}

function drawHeader(
	ctx: CanvasRenderingContext2D,
	overview: SessionOverview,
	nowMs: number,
	previousOverview: SessionOverview | null
) {
	const { summary } = overview;
	const statsY = OUTER_PADDING + 112;
	const currentVolume = getSessionVolume(overview);
	const previousVolume = previousOverview ? getSessionVolume(previousOverview) : null;
	const headingLine =
		summary.status === 'planned'
			? `${formatDayHeading(summary.dayKey)} · Not started`
			: `${formatDayHeading(summary.dayKey)} at ${formatSessionTime(summary.startedAt)}`;

	drawText(ctx, 'TinyTrain', { x: OUTER_PADDING, y: OUTER_PADDING }, '700 18px Inter, system-ui', {
		color: COLORS.emerald
	});
	drawText(
		ctx,
		summary.workoutNameSnapshot,
		{ x: OUTER_PADDING, y: OUTER_PADDING + 30 },
		'700 36px Inter, system-ui',
		{
			maxWidth: IMAGE_WIDTH - OUTER_PADDING * 2,
			color: COLORS.text
		}
	);
	drawText(
		ctx,
		headingLine,
		{ x: OUTER_PADDING, y: OUTER_PADDING + 76 },
		'500 17px Inter, system-ui',
		{ color: COLORS.muted }
	);

	drawStatPill(
		ctx,
		{ x: OUTER_PADDING, y: statsY },
		'Volume',
		formatVolume(currentVolume),
		getVolumeTone(currentVolume, previousVolume),
		getVolumeComparisonLabel(currentVolume, previousVolume)
	);
	drawStatPill(
		ctx,
		{ x: OUTER_PADDING + (STAT_PILL_WIDTH + STAT_PILL_GAP), y: statsY },
		'Duration',
		formatDuration(summary.startedAt, summary.completedAt, nowMs),
		COLORS.text
	);
	drawStatPill(
		ctx,
		{ x: OUTER_PADDING, y: statsY + 68 },
		'Exercises',
		String(summary.totalExercises),
		COLORS.text
	);
	drawStatPill(
		ctx,
		{ x: OUTER_PADDING + (STAT_PILL_WIDTH + STAT_PILL_GAP), y: statsY + 68 },
		'Sets',
		String(summary.totalSets),
		COLORS.text
	);
}

function drawExercises(ctx: CanvasRenderingContext2D, overview: SessionOverview) {
	let y = OUTER_PADDING + HEADER_HEIGHT;

	for (const [index, sessionExercise] of overview.exercises.entries()) {
		const height = getExerciseCardHeight(sessionExercise);
		drawExerciseCard(ctx, sessionExercise, index + 1, y, height);
		y += height + EXERCISE_GAP;
	}
}

function drawExerciseCard(
	ctx: CanvasRenderingContext2D,
	sessionExercise: SessionExerciseOverview,
	position: number,
	y: number,
	height: number
) {
	const x = OUTER_PADDING;
	const width = IMAGE_WIDTH - OUTER_PADDING * 2;
	const sets = getPerformedSets(sessionExercise);
	const tableY = y + CARD_PADDING + 38;

	roundedRect(ctx, x, y, width, height, CARD_RADIUS);
	ctx.fillStyle = COLORS.panel;
	ctx.fill();
	ctx.strokeStyle = COLORS.lineSoft;
	ctx.lineWidth = 2;
	ctx.stroke();

	drawText(
		ctx,
		String(position).padStart(2, '0'),
		{ x: x + CARD_PADDING, y: y + CARD_PADDING + 1 },
		'700 24px Inter, system-ui',
		{ color: COLORS.emerald }
	);
	drawText(
		ctx,
		sessionExercise.exerciseNameSnapshot,
		{ x: x + CARD_PADDING + 44, y: y + CARD_PADDING + 3 },
		'700 21px Inter, system-ui',
		{ maxWidth: width - CARD_PADDING * 2 - 44, color: COLORS.text }
	);

	drawTableHeader(ctx, x + CARD_PADDING, tableY, width - CARD_PADDING * 2);

	if (sets.length === 0) {
		drawEmptySetRow(ctx, x + CARD_PADDING, tableY + 34, width - CARD_PADDING * 2);
		return;
	}

	sets.forEach((set, index) => {
		drawSetRow(
			ctx,
			set,
			x + CARD_PADDING,
			tableY + 34 + index * TABLE_ROW_HEIGHT,
			width - CARD_PADDING * 2
		);
	});
}

function drawTableHeader(ctx: CanvasRenderingContext2D, x: number, y: number, width: number) {
	const columns = getColumns(x, width);

	for (const column of columns) {
		drawText(ctx, column.label, { x: column.x, y: y + 2 }, '700 11px Inter, system-ui', {
			color: COLORS.subtle,
			align: column.align
		});
	}
}

function drawSetRow(
	ctx: CanvasRenderingContext2D,
	set: SessionSetOverview,
	x: number,
	y: number,
	width: number
) {
	roundedRect(ctx, x, y, width, TABLE_ROW_HEIGHT - 4, 12);
	ctx.fillStyle = COLORS.panelSoft;
	ctx.fill();

	const columns = getColumns(x, width);
	const cells: Array<{ column: (typeof columns)[number]; value: string | DrawnCell }> = [
		{ column: columns[0], value: set.label.replace('Set ', '') },
		{ column: columns[1], value: getSetCell(set, 'weight') },
		{ column: columns[2], value: getSetCell(set, 'reps') },
		{ column: columns[3], value: getSetCell(set, 'rir') }
	];

	for (const cell of cells) {
		if (typeof cell.value === 'string') {
			drawText(ctx, cell.value, { x: cell.column.x, y: y + 11 }, '700 18px Inter, system-ui', {
				color: COLORS.text,
				align: cell.column.align
			});
			continue;
		}

		drawText(ctx, cell.value.main, { x: cell.column.x, y: y + 6 }, '700 18px Inter, system-ui', {
			color: COLORS.text,
			align: cell.column.align
		});

		if (cell.value.delta) {
			drawText(
				ctx,
				cell.value.delta,
				{ x: cell.column.x, y: y + 24 },
				'600 12px Inter, system-ui',
				{
					color: getDeltaTone(cell.value.tone),
					align: cell.column.align
				}
			);
		}
	}
}

function drawEmptySetRow(ctx: CanvasRenderingContext2D, x: number, y: number, width: number) {
	roundedRect(ctx, x, y, width, TABLE_ROW_HEIGHT - 4, 12);
	ctx.fillStyle = COLORS.panelSoft;
	ctx.fill();
	drawText(ctx, 'No logged sets', { x: x + 18, y: y + 10 }, '700 16px Inter, system-ui', {
		color: COLORS.subtle
	});
}

function drawWatermark(ctx: CanvasRenderingContext2D, height: number) {
	drawText(
		ctx,
		'Made with TinyTrain',
		{ x: IMAGE_WIDTH - OUTER_PADDING, y: height - 32 },
		'700 15px Inter, system-ui',
		{ color: COLORS.subtle, align: 'right' }
	);
}

function drawStatPill(
	ctx: CanvasRenderingContext2D,
	point: Point,
	label: string,
	value: string,
	valueColor: string,
	detail = ''
) {
	roundedRect(ctx, point.x, point.y, STAT_PILL_WIDTH, 54, 12);
	ctx.fillStyle = COLORS.panel;
	ctx.fill();
	ctx.strokeStyle = COLORS.lineSoft;
	ctx.lineWidth = 2;
	ctx.stroke();

	drawText(
		ctx,
		label.toUpperCase(),
		{ x: point.x + 14, y: point.y + 10 },
		'700 10px Inter, system-ui',
		{
			color: COLORS.subtle
		}
	);
	drawText(ctx, value, { x: point.x + 14, y: point.y + 25 }, '700 17px Inter, system-ui', {
		color: valueColor,
		maxWidth: STAT_PILL_WIDTH - 28
	});

	if (detail) {
		drawText(ctx, detail, { x: point.x + 14, y: point.y + 43 }, '600 10px Inter, system-ui', {
			color: valueColor,
			maxWidth: STAT_PILL_WIDTH - 28
		});
	}
}

function getColumns(x: number, width: number) {
	return [
		{ label: 'SET', x: x + 18, align: 'left' as const },
		{ label: 'WEIGHT', x: x + width * 0.42, align: 'center' as const },
		{ label: 'REPS', x: x + width * 0.67, align: 'center' as const },
		{ label: 'RIR', x: x + width - 18, align: 'right' as const }
	];
}

function getSetCell(set: SessionSetOverview, field: 'weight' | 'reps' | 'rir'): DrawnCell {
	const delta =
		field === 'weight' ? set.weightDelta : field === 'reps' ? set.repsDelta : set.rirDelta;
	const value = field === 'weight' ? set.weight : field === 'reps' ? set.reps : set.rir;

	return {
		main: formatSetCellValue(value),
		delta: delta.label,
		tone: delta.state === 'improved' ? 'up' : delta.state === 'regressed' ? 'down' : 'muted'
	};
}

function getSessionVolume(overview: SessionOverview) {
	return overview.exercises.reduce((total, sessionExercise) => {
		return (
			total +
			getPerformedSets(sessionExercise).reduce((exerciseTotal, set) => {
				if (
					typeof set.weight !== 'number' ||
					!Number.isFinite(set.weight) ||
					typeof set.reps !== 'number' ||
					!Number.isFinite(set.reps)
				) {
					return exerciseTotal;
				}

				return exerciseTotal + set.weight * set.reps;
			}, 0)
		);
	}, 0);
}

function formatVolume(volume: number) {
	return new Intl.NumberFormat('en-US', {
		maximumFractionDigits: volume % 1 === 0 ? 0 : 1
	}).format(volume);
}

function getVolumeComparisonLabel(currentVolume: number, previousVolume: number | null) {
	if (previousVolume === null) {
		return 'No previous';
	}

	const diff = currentVolume - previousVolume;

	if (diff === 0) {
		return 'Matched prev';
	}

	return `${diff > 0 ? '+' : ''}${formatVolume(diff)}`;
}

function getVolumeTone(currentVolume: number, previousVolume: number | null) {
	if (previousVolume === null || currentVolume === previousVolume) {
		return COLORS.text;
	}

	return currentVolume > previousVolume ? COLORS.emerald : COLORS.red;
}

function getDeltaTone(tone: DrawnCell['tone']) {
	if (tone === 'up') {
		return COLORS.emerald;
	}

	if (tone === 'down') {
		return COLORS.red;
	}

	return COLORS.subtle;
}

function drawText(
	ctx: CanvasRenderingContext2D,
	text: string,
	point: Point,
	font: string,
	options: {
		color?: string;
		align?: CanvasTextAlign;
		maxWidth?: number;
	} = {}
) {
	ctx.font = font;
	ctx.fillStyle = options.color ?? COLORS.text;
	ctx.textAlign = options.align ?? 'left';
	ctx.textBaseline = 'top';

	if (options.maxWidth) {
		ctx.fillText(truncateText(ctx, text, options.maxWidth), point.x, point.y);
		return;
	}

	ctx.fillText(text, point.x, point.y);
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
	if (ctx.measureText(text).width <= maxWidth) {
		return text;
	}

	const ellipsis = '...';
	let lower = 0;
	let upper = text.length;

	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		const candidate = `${text.slice(0, middle).trimEnd()}${ellipsis}`;

		if (ctx.measureText(candidate).width <= maxWidth) {
			lower = middle;
			continue;
		}

		upper = middle - 1;
	}

	return `${text.slice(0, lower).trimEnd()}${ellipsis}`;
}

function roundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number
) {
	const safeRadius = Math.min(radius, width / 2, height / 2);

	ctx.beginPath();
	ctx.moveTo(x + safeRadius, y);
	ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
	ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
	ctx.arcTo(x, y + height, x, y, safeRadius);
	ctx.arcTo(x, y, x + width, y, safeRadius);
	ctx.closePath();
}

function canvasToBlob(canvas: HTMLCanvasElement) {
	return new Promise<Blob | null>((resolve) => {
		canvas.toBlob((blob) => resolve(blob), 'image/png');
	});
}

function downloadBlob(blob: Blob, fileName: string) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');

	anchor.href = url;
	anchor.download = fileName;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();

	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getSessionImageFileName(overview: SessionOverview) {
	const cleanWorkoutName = overview.summary.workoutNameSnapshot
		.toLocaleLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '');
	const cleanDay = overview.summary.dayKey || 'session';

	return `tinytrain-${cleanDay}-${cleanWorkoutName || 'session'}.png`;
}
