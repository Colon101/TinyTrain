import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export const ACCENT_THEMES = [
	{
		id: 'emerald',
		name: 'Emerald',
		hex: '#6EE7B7',
		description: 'Fresh and focused'
	},
	{
		id: 'ocean-blue',
		name: 'Ocean Blue',
		hex: '#8AA3C1',
		description: 'Calm and understated'
	},
	{
		id: 'lavender',
		name: 'Lavender',
		hex: '#C4B5FD',
		description: 'Soft and reflective'
	},
	{
		id: 'rose',
		name: 'Rose',
		hex: '#FDA4AF',
		description: 'Warm and expressive'
	},
	{
		id: 'amber',
		name: 'Amber',
		hex: '#FCD34D',
		description: 'Bold and energetic'
	},
	{
		id: 'arctic',
		name: 'Arctic',
		hex: '#67E8F9',
		description: 'Cool and bright'
	},
	{
		id: 'olive-brown',
		name: 'Olive Brown',
		hex: '#5B543A',
		description: 'Earthy and grounded'
	}
] as const;

export type AccentTheme = (typeof ACCENT_THEMES)[number];
export type AccentThemeId = AccentTheme['id'];

export const DEFAULT_ACCENT_THEME_ID: AccentThemeId = 'emerald';
export const ACCENT_THEME_STORAGE_KEY = 'tinytrain:accent-theme:v1';

const accentThemeIdStore = writable<AccentThemeId>(DEFAULT_ACCENT_THEME_ID);

export const accentThemeId = { subscribe: accentThemeIdStore.subscribe };

let initialized = false;

export function isAccentThemeId(value: unknown): value is AccentThemeId {
	return ACCENT_THEMES.some((theme) => theme.id === value);
}

export function parseStoredAccentTheme(value: string | null): AccentThemeId {
	return isAccentThemeId(value) ? value : DEFAULT_ACCENT_THEME_ID;
}

function applyAccentTheme(themeId: AccentThemeId) {
	if (!browser) {
		return;
	}

	document.documentElement.dataset.accentTheme = themeId;
}

function loadStoredAccentTheme() {
	if (!browser) {
		return DEFAULT_ACCENT_THEME_ID;
	}

	try {
		return parseStoredAccentTheme(localStorage.getItem(ACCENT_THEME_STORAGE_KEY));
	} catch {
		return DEFAULT_ACCENT_THEME_ID;
	}
}

function setActiveAccentTheme(themeId: AccentThemeId) {
	accentThemeIdStore.set(themeId);
	applyAccentTheme(themeId);
}

export function initializeAccentThemePreference() {
	if (!browser || initialized) {
		return;
	}

	initialized = true;
	setActiveAccentTheme(loadStoredAccentTheme());

	window.addEventListener('storage', (event) => {
		if (event.key === ACCENT_THEME_STORAGE_KEY || event.key === null) {
			setActiveAccentTheme(loadStoredAccentTheme());
		}
	});
}

export function saveAccentTheme(themeId: AccentThemeId) {
	initializeAccentThemePreference();
	setActiveAccentTheme(themeId);

	if (!browser) {
		return false;
	}

	try {
		localStorage.setItem(ACCENT_THEME_STORAGE_KEY, themeId);
		return true;
	} catch {
		return false;
	}
}
