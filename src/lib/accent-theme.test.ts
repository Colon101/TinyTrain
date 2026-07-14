import { describe, expect, it } from 'vitest';
import {
	ACCENT_THEMES,
	CUSTOM_THEME_VARIABLES,
	DEFAULT_CUSTOM_ACCENT,
	DEFAULT_ACCENT_THEME_ID,
	buildCustomAccentPalette,
	isAccentThemeId,
	parseStoredAccentTheme,
	parseStoredCustomAccentPalette
} from './accent-theme';

describe('accent theme preference', () => {
	it('includes the requested Ocean Blue preset exactly', () => {
		expect(ACCENT_THEMES.find((theme) => theme.id === 'ocean-blue')).toMatchObject({
			name: 'Ocean Blue',
			// Keep this exact product-specified value synchronized with the CSS theme registry.
			hex: '#8AA3C1'
		});
	});

	it('includes the requested Olive Brown preset exactly', () => {
		expect(ACCENT_THEMES.find((theme) => theme.id === 'olive-brown')).toMatchObject({
			name: 'Olive Brown',
			hex: '#5B543A'
		});
	});

	it('keeps the picker in complete rows with Ocean Blue and Olive Brown together', () => {
		expect(ACCENT_THEMES.map((theme) => theme.id)).toEqual([
			'emerald',
			'lavender',
			'ocean-blue',
			'olive-brown',
			'rose',
			'amber',
			'arctic',
			'custom'
		]);
	});

	it('accepts only registered theme identifiers', () => {
		expect(isAccentThemeId('emerald')).toBe(true);
		expect(isAccentThemeId('ocean-blue')).toBe(true);
		expect(isAccentThemeId('olive-brown')).toBe(true);
		expect(isAccentThemeId('custom')).toBe(true);
		expect(isAccentThemeId(null)).toBe(false);
	});

	it('falls back safely when the stored preference is missing or invalid', () => {
		expect(parseStoredAccentTheme(null)).toBe(DEFAULT_ACCENT_THEME_ID);
		expect(parseStoredAccentTheme('not-a-theme')).toBe(DEFAULT_ACCENT_THEME_ID);
		expect(parseStoredAccentTheme('lavender')).toBe('lavender');
	});

	it('derives a complete, explicit palette from a valid custom color', () => {
		const palette = buildCustomAccentPalette('#123456');

		expect(palette).not.toBeNull();
		expect(palette?.['--theme-custom-accent']).toBe('#123456');
		expect(palette?.['--theme-custom-on-accent']).toBe('#FFFFFF');
		expect(Object.keys(palette!)).toEqual(CUSTOM_THEME_VARIABLES);

		for (const value of Object.values(palette!)) {
			expect(value).toMatch(/^#[0-9A-F]{6}$/);
		}
	});

	it('chooses a readable foreground at both ends of the custom color range', () => {
		expect(buildCustomAccentPalette('#000000')?.['--theme-custom-on-accent']).toBe('#FFFFFF');
		expect(buildCustomAccentPalette('#ffffff')?.['--theme-custom-on-accent']).toBe('#09090B');
		expect(buildCustomAccentPalette('123456')).toBeNull();
		expect(buildCustomAccentPalette('#12345g')).toBeNull();
	});

	it('restores only complete versioned custom palettes', () => {
		const palette = buildCustomAccentPalette('#8AA3C1')!;
		const stored = JSON.stringify({ version: 1, palette });

		expect(parseStoredCustomAccentPalette(stored)).toEqual(palette);
		expect(parseStoredCustomAccentPalette('{')).toMatchObject({
			'--theme-custom-accent': DEFAULT_CUSTOM_ACCENT
		});
		expect(
			parseStoredCustomAccentPalette(JSON.stringify({ version: 1, palette: {} }))
		).toMatchObject({
			'--theme-custom-accent': DEFAULT_CUSTOM_ACCENT
		});
	});
});
