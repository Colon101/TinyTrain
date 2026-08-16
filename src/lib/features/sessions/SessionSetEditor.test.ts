import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { SessionSetOverview } from '$lib/db';
import SessionSetEditor from './SessionSetEditor.svelte';

const timestamp = '2026-07-15T10:00:00.000Z';
const sessionSet: SessionSetOverview = {
	id: 'set-1',
	sessionExerciseId: 'session-exercise-1',
	exerciseId: 'exercise-1',
	order: 1,
	side: 'bilateral',
	weightInput: '100',
	repsInput: '8',
	rirInput: '2',
	weight: 100,
	reps: 8,
	rir: 2,
	createdAt: timestamp,
	updatedAt: timestamp,
	label: 'Set 01',
	previousReference: {
		weight: 95,
		reps: 8,
		rir: 3
	},
	weightDelta: { state: 'improved', label: '+5' },
	repsDelta: { state: 'matched', label: '' },
	rirDelta: { state: 'regressed', label: '-1' }
};

describe('SessionSetEditor', () => {
	it('disables every set mutation control while a destructive save is running', () => {
		const { body } = render(SessionSetEditor, {
			props: {
				sets: [sessionSet],
				isSaving: true,
				isUnilateral: false,
				onAutofillPreviousSet: () => undefined,
				onSetInput: () => undefined,
				onSetInputKeydown: () => undefined,
				onAddSet: () => undefined,
				onRemoveSet: () => undefined
			}
		});
		const inputTags = body.match(/<input\b[^>]*>/g) ?? [];
		const buttonTags = body.match(/<button\b[^>]*>/g) ?? [];

		expect(inputTags).toHaveLength(3);
		expect(inputTags.every((tag) => /\sdisabled(?:=""|(?=[\s>]))/.test(tag))).toBe(true);
		expect(buttonTags).toHaveLength(3);
		expect(buttonTags.every((tag) => /\sdisabled(?:=""|(?=[\s>]))/.test(tag))).toBe(true);
	});
});
