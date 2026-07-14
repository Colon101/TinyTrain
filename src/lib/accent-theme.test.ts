import { describe, expect, it } from 'vitest';
import {
	ACCENT_THEMES,
	DEFAULT_ACCENT_THEME_ID,
	isAccentThemeId,
	parseStoredAccentTheme
} from './accent-theme';

describe('accent theme preference', () => {
	it('includes the requested Ocean Blue preset exactly', () => {
		expect(ACCENT_THEMES.find((theme) => theme.id === 'ocean-blue')).toMatchObject({
			name: 'Ocean Blue',
			// Keep this exact product-specified value synchronized with the CSS theme registry.
			hex: '#8AA3C1'
		});
	});

	it('accepts only registered theme identifiers', () => {
		expect(isAccentThemeId('emerald')).toBe(true);
		expect(isAccentThemeId('ocean-blue')).toBe(true);
		expect(isAccentThemeId('custom')).toBe(false);
		expect(isAccentThemeId(null)).toBe(false);
	});

	it('falls back safely when the stored preference is missing or invalid', () => {
		expect(parseStoredAccentTheme(null)).toBe(DEFAULT_ACCENT_THEME_ID);
		expect(parseStoredAccentTheme('not-a-theme')).toBe(DEFAULT_ACCENT_THEME_ID);
		expect(parseStoredAccentTheme('lavender')).toBe('lavender');
	});
});
