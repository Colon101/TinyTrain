import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	ACCENT_THEMES,
	ACCENT_THEME_STORAGE_KEY,
	CUSTOM_ACCENT_STORAGE_KEY,
	CUSTOM_THEME_VARIABLES,
	DEFAULT_CUSTOM_ACCENT,
	buildCustomAccentPalette
} from './accent-theme';
import { resolveShareImagePalette } from './features/sessions/session-share-image';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const tokenRegistryPath = join(sourceRoot, 'routes', 'layout.css');
const themeMetadataPath = join(sourceRoot, 'lib', 'accent-theme.ts');
const appTemplatePath = join(sourceRoot, 'app.html');
const concretePaletteRegistryPaths = new Set([tokenRegistryPath, themeMetadataPath]);
const sourceExtensions = new Set(['.css', '.svelte', '.ts']);

function collectSourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);

		if (entry.isDirectory()) {
			return collectSourceFiles(path);
		}

		if (!sourceExtensions.has(extname(entry.name)) || entry.name.endsWith('.test.ts')) {
			return [];
		}

		return [path];
	});
}

function readHexVariable(css: string, variable: string) {
	const match = css.match(new RegExp(`${variable}:\\s*(#[0-9a-f]{6})`, 'i'));
	expect(match, `${variable} should be a six-digit hex color`).not.toBeNull();
	return match![1];
}

function readThemeBlock(css: string, themeId: string) {
	const selector = themeId === 'emerald' ? ':root' : `:root\\[data-accent-theme='${themeId}'\\]`;
	const match = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\}`));
	expect(match, `${themeId} should have a CSS theme block`).not.toBeNull();
	return match![1];
}

function getRelativeLuminance(color: string) {
	const channels = color
		.slice(1)
		.match(/.{2}/g)!
		.map((channel) => Number.parseInt(channel, 16) / 255)
		.map((channel) =>
			channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
		);

	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe('accent theme contract', () => {
	it('keeps concrete theme colors in the theme registries', () => {
		const forbiddenPalette = /\b(?:emerald|green|sky|teal)-\d{2,3}\b/gi;
		const forbiddenLiteral =
			/#(?:ecfdf5|d1fae5|a7f3d0|6ee7b7|34d399|10b981|059669|047857|065f46|064e3b|022c22|e0f2fe|bae6fd|7dd3fc|082f49)\b|rgba?\(\s*52(?:\s*,\s*|\s+)211(?:\s*,\s*|\s+)153\b/gi;
		const forbiddenSurfaceLiteral =
			/#(?:070a0d|0b1014|06080a|080b0d|0e1417|11171a|0f1519|0b1013|121a20|1c252c)\b/gi;
		const violations = collectSourceFiles(sourceRoot)
			.filter((path) => !concretePaletteRegistryPaths.has(path))
			.flatMap((path) => {
				const source = readFileSync(path, 'utf8');
				const matches = [
					...source.matchAll(forbiddenPalette),
					...source.matchAll(forbiddenLiteral),
					...source.matchAll(forbiddenSurfaceLiteral)
				];

				return matches.map((match) => `${path.slice(sourceRoot.length + 1)}: ${match[0]}`);
			});

		expect(violations).toEqual([]);
	});

	it('keeps completed calendar dots on the active accent', () => {
		for (const file of ['HomeCalendar.svelte', 'DayPickerSheet.svelte']) {
			const source = readFileSync(join(sourceRoot, 'lib', 'features', 'home', file), 'utf8');

			expect(source).toContain("session.status === 'completed' ? 'bg-accent' : 'bg-amber-300'");
			expect(source).not.toContain("session.status === 'completed' ? 'bg-success'");
		}
	});

	it('registers every preset with its exact accent and a readable foreground', () => {
		const css = readFileSync(tokenRegistryPath, 'utf8');

		for (const theme of ACCENT_THEMES) {
			const block = readThemeBlock(css, theme.id);
			const colorSource = theme.id === 'custom' ? readThemeBlock(css, 'emerald') : block;
			const accentVariable = theme.id === 'custom' ? '--theme-custom-accent' : '--theme-accent';
			const foregroundVariable =
				theme.id === 'custom' ? '--theme-custom-on-accent' : '--theme-on-accent';
			const accent = readHexVariable(colorSource, accentVariable);
			const foreground = readHexVariable(colorSource, foregroundVariable);
			const accentLuminance = getRelativeLuminance(accent);
			const foregroundLuminance = getRelativeLuminance(foreground);
			const contrast =
				(Math.max(accentLuminance, foregroundLuminance) + 0.05) /
				(Math.min(accentLuminance, foregroundLuminance) + 0.05);

			expect(accent.toLowerCase(), `${theme.name} accent`).toBe(theme.hex.toLowerCase());
			expect(contrast, `${theme.name} contrast`).toBeGreaterThanOrEqual(4.5);
		}
	});

	it('maps every custom theme value into the runtime contract', () => {
		const css = readFileSync(tokenRegistryPath, 'utf8');
		const defaultBlock = readThemeBlock(css, 'emerald');
		const customBlock = readThemeBlock(css, 'custom');
		const defaultPalette = buildCustomAccentPalette(DEFAULT_CUSTOM_ACCENT)!;

		for (const customVariable of CUSTOM_THEME_VARIABLES) {
			expect(customBlock).toContain(customVariable);
			expect(readHexVariable(defaultBlock, customVariable).toUpperCase()).toBe(
				defaultPalette[customVariable]
			);
		}
	});

	it('restores the same persisted preference key before the app paints', () => {
		const appTemplate = readFileSync(appTemplatePath, 'utf8');
		const customStorageRead = `const savedCustomAccent = localStorage.getItem('${CUSTOM_ACCENT_STORAGE_KEY}');`;
		const storageRead = `const savedAccentTheme = localStorage.getItem('${ACCENT_THEME_STORAGE_KEY}');`;
		const customVariableAssignment =
			'document.documentElement.style.setProperty(variable, customPalette[variable]);';
		const themeAssignment = 'document.documentElement.dataset.accentTheme = savedAccentTheme;';
		const inlineScripts = [...appTemplate.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
		const bootstrapScripts = inlineScripts.filter((match) => match[1].includes(storageRead));

		expect(bootstrapScripts).toHaveLength(1);

		const [bootstrapMatch] = bootstrapScripts;
		const bootstrapScript = bootstrapMatch[1];
		const customReadIndex = bootstrapScript.indexOf(customStorageRead);
		const customAssignmentIndex = bootstrapScript.indexOf(customVariableAssignment);
		const readIndex = bootstrapScript.indexOf(storageRead);
		const assignmentIndex = bootstrapScript.indexOf(themeAssignment);
		const bootstrapEndIndex = bootstrapMatch.index! + bootstrapMatch[0].length;
		const svelteHeadIndex = appTemplate.indexOf('%sveltekit.head%');
		const svelteBodyIndex = appTemplate.indexOf('%sveltekit.body%');

		expect(customReadIndex).toBeGreaterThanOrEqual(0);
		expect(customAssignmentIndex).toBeGreaterThan(customReadIndex);
		expect(readIndex).toBeGreaterThan(customAssignmentIndex);
		expect(readIndex).toBeGreaterThanOrEqual(0);
		expect(assignmentIndex).toBeGreaterThan(readIndex);
		for (const variable of CUSTOM_THEME_VARIABLES) {
			expect(bootstrapScript).toContain(`'${variable}'`);
		}
		expect(bootstrapEndIndex).toBeLessThan(svelteHeadIndex);
		expect(svelteHeadIndex).toBeLessThan(svelteBodyIndex);
	});

	it('keeps share-image accent and positive progress independent', () => {
		const colorsByProperty = new Map([
			['--theme-accent', ' #c084fc '],
			['--semantic-positive', ' #6ee7b7 '],
			['--theme-surface-canvas', ' #090612 '],
			['--theme-surface-menu', ' #160d22 '],
			['--theme-surface-soft', ' #21132f '],
			['--theme-surface-line-soft', ' #3d2452 ']
		]);
		const requestedProperties: string[] = [];
		const palette = resolveShareImagePalette((property) => {
			requestedProperties.push(property);
			return colorsByProperty.get(property) ?? '';
		});

		expect(requestedProperties).toEqual([...colorsByProperty.keys()]);
		expect(palette).toEqual({
			accent: '#c084fc',
			positive: '#6ee7b7',
			page: '#090612',
			panel: '#160d22',
			panelSoft: '#21132f',
			lineSoft: '#3d2452'
		});
	});
});
