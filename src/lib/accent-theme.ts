import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export const DEFAULT_CUSTOM_ACCENT = '#A3A3A3';

export const ACCENT_THEMES = [
	{
		id: 'emerald',
		name: 'Emerald',
		hex: '#6EE7B7'
	},
	{
		id: 'lavender',
		name: 'Lavender',
		hex: '#C4B5FD'
	},
	{
		id: 'ocean-blue',
		name: 'Ocean Blue',
		hex: '#8AA3C1'
	},
	{
		id: 'olive-brown',
		name: 'Olive Brown',
		hex: '#5B543A'
	},
	{
		id: 'rose',
		name: 'Rose',
		hex: '#FDA4AF'
	},
	{
		id: 'amber',
		name: 'Amber',
		hex: '#FCD34D'
	},
	{
		id: 'arctic',
		name: 'Arctic',
		hex: '#67E8F9'
	},
	{
		id: 'custom',
		name: 'Custom',
		hex: DEFAULT_CUSTOM_ACCENT
	}
] as const;

export type AccentTheme = (typeof ACCENT_THEMES)[number];
export type AccentThemeId = AccentTheme['id'];

export const DEFAULT_ACCENT_THEME_ID: AccentThemeId = 'emerald';
export const ACCENT_THEME_STORAGE_KEY = 'tinytrain:accent-theme:v1';
export const CUSTOM_ACCENT_STORAGE_KEY = 'tinytrain:custom-accent:v1';

export const CUSTOM_THEME_VARIABLES = [
	'--theme-custom-accent',
	'--theme-custom-accent-soft',
	'--theme-custom-accent-subtle',
	'--theme-custom-accent-shadow',
	'--theme-custom-on-accent',
	'--theme-custom-surface-canvas',
	'--theme-custom-surface-canvas-top',
	'--theme-custom-surface-canvas-bottom',
	'--theme-custom-surface-app',
	'--theme-custom-surface-overlay',
	'--theme-custom-surface-raised',
	'--theme-custom-surface-menu',
	'--theme-custom-surface-dialog',
	'--theme-custom-surface-soft',
	'--theme-custom-surface-line-soft'
] as const;

type CustomThemeVariable = (typeof CUSTOM_THEME_VARIABLES)[number];
export type CustomAccentPalette = Record<CustomThemeVariable, string>;

type StoredCustomAccentV1 = {
	version: 1;
	palette: CustomAccentPalette;
};

const accentThemeIdStore = writable<AccentThemeId>(DEFAULT_ACCENT_THEME_ID);
const customAccentColorStore = writable(DEFAULT_CUSTOM_ACCENT);

export const accentThemeId = { subscribe: accentThemeIdStore.subscribe };
export const customAccentColor = { subscribe: customAccentColorStore.subscribe };

let initialized = false;

function normalizeHexColor(value: string) {
	return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null;
}

function hexToRgb(value: string) {
	return value
		.slice(1)
		.match(/.{2}/g)!
		.map((channel) => Number.parseInt(channel, 16));
}

function rgbToHex(channels: number[]) {
	return `#${channels
		.map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
		.join('')}`.toUpperCase();
}

function mixHex(foreground: string, background: string, foregroundWeight: number) {
	const foregroundChannels = hexToRgb(foreground);
	const backgroundChannels = hexToRgb(background);

	return rgbToHex(
		foregroundChannels.map(
			(channel, index) =>
				channel * foregroundWeight + backgroundChannels[index] * (1 - foregroundWeight)
		)
	);
}

function getRelativeLuminance(value: string) {
	const channels = hexToRgb(value)
		.map((channel) => channel / 255)
		.map((channel) =>
			channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
		);

	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function getContrast(first: string, second: string) {
	const firstLuminance = getRelativeLuminance(first);
	const secondLuminance = getRelativeLuminance(second);

	return (
		(Math.max(firstLuminance, secondLuminance) + 0.05) /
		(Math.min(firstLuminance, secondLuminance) + 0.05)
	);
}

export function buildCustomAccentPalette(value: string): CustomAccentPalette | null {
	const accent = normalizeHexColor(value);

	if (!accent) {
		return null;
	}

	const darkForeground = '#09090B';
	const lightForeground = '#FFFFFF';
	const onAccent =
		getContrast(accent, darkForeground) >= getContrast(accent, lightForeground)
			? darkForeground
			: lightForeground;

	return {
		'--theme-custom-accent': accent,
		'--theme-custom-accent-soft': mixHex(accent, '#FFFFFF', 0.58),
		'--theme-custom-accent-subtle': mixHex(accent, '#FFFFFF', 0.28),
		'--theme-custom-accent-shadow': mixHex(accent, '#000000', 0.28),
		'--theme-custom-on-accent': onAccent,
		'--theme-custom-surface-canvas': mixHex(accent, '#070A0D', 0.035),
		'--theme-custom-surface-canvas-top': mixHex(accent, '#0B1014', 0.055),
		'--theme-custom-surface-canvas-bottom': mixHex(accent, '#06080A', 0.025),
		'--theme-custom-surface-app': mixHex(accent, '#080B0D', 0.04),
		'--theme-custom-surface-overlay': mixHex(accent, '#0E1417', 0.07),
		'--theme-custom-surface-raised': mixHex(accent, '#11171A', 0.08),
		'--theme-custom-surface-menu': mixHex(accent, '#0F1519', 0.07),
		'--theme-custom-surface-dialog': mixHex(accent, '#0B1013', 0.05),
		'--theme-custom-surface-soft': mixHex(accent, '#121A20', 0.08),
		'--theme-custom-surface-line-soft': mixHex(accent, '#1C252C', 0.12)
	};
}

const DEFAULT_CUSTOM_PALETTE = buildCustomAccentPalette(DEFAULT_CUSTOM_ACCENT)!;

export function isAccentThemeId(value: unknown): value is AccentThemeId {
	return ACCENT_THEMES.some((theme) => theme.id === value);
}

export function parseStoredAccentTheme(value: string | null): AccentThemeId {
	return isAccentThemeId(value) ? value : DEFAULT_ACCENT_THEME_ID;
}

function isCustomAccentPalette(value: unknown): value is CustomAccentPalette {
	return Boolean(
		value &&
		typeof value === 'object' &&
		CUSTOM_THEME_VARIABLES.every(
			(variable) =>
				variable in value &&
				typeof (value as Record<string, unknown>)[variable] === 'string' &&
				/^#[0-9a-f]{6}$/i.test((value as Record<string, string>)[variable])
		)
	);
}

export function parseStoredCustomAccentPalette(rawValue: string | null): CustomAccentPalette {
	if (!rawValue) {
		return DEFAULT_CUSTOM_PALETTE;
	}

	try {
		const stored = JSON.parse(rawValue) as Partial<StoredCustomAccentV1>;
		return stored.version === 1 && isCustomAccentPalette(stored.palette)
			? stored.palette
			: DEFAULT_CUSTOM_PALETTE;
	} catch {
		return DEFAULT_CUSTOM_PALETTE;
	}
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

function loadStoredCustomAccentPalette() {
	if (!browser) {
		return DEFAULT_CUSTOM_PALETTE;
	}

	try {
		return parseStoredCustomAccentPalette(localStorage.getItem(CUSTOM_ACCENT_STORAGE_KEY));
	} catch {
		return DEFAULT_CUSTOM_PALETTE;
	}
}

function applyCustomAccentPalette(palette: CustomAccentPalette) {
	if (!browser) {
		return;
	}

	for (const variable of CUSTOM_THEME_VARIABLES) {
		document.documentElement.style.setProperty(variable, palette[variable]);
	}
}

function setCustomAccentPalette(palette: CustomAccentPalette) {
	customAccentColorStore.set(palette['--theme-custom-accent']);
	applyCustomAccentPalette(palette);
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
	setCustomAccentPalette(loadStoredCustomAccentPalette());
	setActiveAccentTheme(loadStoredAccentTheme());

	window.addEventListener('storage', (event) => {
		if (event.key === CUSTOM_ACCENT_STORAGE_KEY || event.key === null) {
			setCustomAccentPalette(loadStoredCustomAccentPalette());
		}

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

export function saveCustomAccentTheme(value: string) {
	const palette = buildCustomAccentPalette(value);

	if (!palette) {
		return false;
	}

	initializeAccentThemePreference();
	setCustomAccentPalette(palette);
	setActiveAccentTheme('custom');

	if (!browser) {
		return false;
	}

	const stored: StoredCustomAccentV1 = { version: 1, palette };

	try {
		localStorage.setItem(CUSTOM_ACCENT_STORAGE_KEY, JSON.stringify(stored));
		localStorage.setItem(ACCENT_THEME_STORAGE_KEY, 'custom');
		return true;
	} catch {
		return false;
	}
}
