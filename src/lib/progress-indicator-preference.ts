import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export const PROGRESS_INDICATOR_POSITIONS = [
	{ value: 'top-left', label: 'Top left' },
	{ value: 'top-center', label: 'Top center' },
	{ value: 'top-right', label: 'Top right' },
	{ value: 'bottom-left', label: 'Bottom left' },
	{ value: 'bottom-center', label: 'Bottom center' },
	{ value: 'bottom-right', label: 'Bottom right' }
] as const;

export type ProgressIndicatorPosition = (typeof PROGRESS_INDICATOR_POSITIONS)[number]['value'];

export const DEFAULT_PROGRESS_INDICATOR_POSITION: ProgressIndicatorPosition = 'bottom-left';

const PREFERENCE_STORAGE_KEY = 'tinytrain:preferences:v1';
const LEGACY_POSITION_STORAGE_KEY = 'tinytrain-testing-delta-position';

type StoredPreferencesV1 = {
	version: 1;
	progressIndicatorPosition: ProgressIndicatorPosition;
};

export const progressIndicatorPosition = writable<ProgressIndicatorPosition>(
	DEFAULT_PROGRESS_INDICATOR_POSITION
);

let initialized = false;

export function isProgressIndicatorPosition(value: unknown): value is ProgressIndicatorPosition {
	return PROGRESS_INDICATOR_POSITIONS.some((position) => position.value === value);
}

function parseStoredPosition(rawValue: string | null) {
	if (!rawValue) {
		return null;
	}

	try {
		const parsed = JSON.parse(rawValue) as unknown;

		if (isProgressIndicatorPosition(parsed)) {
			return parsed;
		}

		if (
			parsed &&
			typeof parsed === 'object' &&
			'progressIndicatorPosition' in parsed &&
			isProgressIndicatorPosition(parsed.progressIndicatorPosition)
		) {
			return parsed.progressIndicatorPosition;
		}
	} catch {
		return isProgressIndicatorPosition(rawValue) ? rawValue : null;
	}

	return null;
}

function writeStoredPosition(position: ProgressIndicatorPosition) {
	if (!browser) {
		return false;
	}

	const preferences: StoredPreferencesV1 = {
		version: 1,
		progressIndicatorPosition: position
	};

	try {
		localStorage.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify(preferences));
		return true;
	} catch {
		return false;
	}
}

function loadStoredPosition() {
	if (!browser) {
		return DEFAULT_PROGRESS_INDICATOR_POSITION;
	}

	try {
		const currentPosition = parseStoredPosition(localStorage.getItem(PREFERENCE_STORAGE_KEY));

		if (currentPosition) {
			writeStoredPosition(currentPosition);
			return currentPosition;
		}

		const legacyPosition = parseStoredPosition(localStorage.getItem(LEGACY_POSITION_STORAGE_KEY));
		const nextPosition = legacyPosition ?? DEFAULT_PROGRESS_INDICATOR_POSITION;

		if (writeStoredPosition(nextPosition) && legacyPosition) {
			try {
				localStorage.removeItem(LEGACY_POSITION_STORAGE_KEY);
			} catch {
				// The canonical preference is already saved, so a stale legacy key is harmless.
			}
		}

		return nextPosition;
	} catch {
		return DEFAULT_PROGRESS_INDICATOR_POSITION;
	}
}

export function initializeProgressIndicatorPreference() {
	if (!browser || initialized) {
		return;
	}

	initialized = true;
	progressIndicatorPosition.set(loadStoredPosition());

	window.addEventListener('storage', (event) => {
		if (event.key === PREFERENCE_STORAGE_KEY || event.key === null) {
			progressIndicatorPosition.set(loadStoredPosition());
		}
	});
}

export function saveProgressIndicatorPosition(position: ProgressIndicatorPosition) {
	initializeProgressIndicatorPreference();
	progressIndicatorPosition.set(position);
	return writeStoredPosition(position);
}
