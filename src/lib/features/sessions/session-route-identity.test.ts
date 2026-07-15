import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(import.meta.dirname, '../../../routes/(app)/sessions/[sessionId]');

function readRoute(...segments: string[]) {
	return readFileSync(resolve(sourceRoot, ...segments), 'utf8');
}

describe('session route identity boundaries', () => {
	it('remounts the overview screen when the session changes', () => {
		const route = readRoute('+page.svelte');

		expect(route).toContain('{#key data.sessionId}');
		expect(route).toMatch(
			/\{#key data\.sessionId\}[\s\S]*<SessionOverviewScreen sessionId=\{data\.sessionId\} \/>[\s\S]*\{\/key\}/
		);
	});

	it('remounts the exercise screen when either route identity changes', () => {
		const route = readRoute('exercises', '[sessionExerciseId]', '+page.svelte');

		expect(route).not.toContain('{#key data.sessionId}');
		expect(route).not.toContain('{#key data.sessionExerciseId}');
		expect(route).toContain('{#key `${data.sessionId}:${data.sessionExerciseId}`}');
		expect(route).toMatch(
			/\{#key `\$\{data\.sessionId\}:\$\{data\.sessionExerciseId\}`\}[\s\S]*<SessionExerciseScreen sessionId=\{data\.sessionId\} sessionExerciseId=\{data\.sessionExerciseId\} \/>[\s\S]*\{\/key\}/
		);
	});
});
