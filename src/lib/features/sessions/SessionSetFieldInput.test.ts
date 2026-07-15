import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import SessionSetFieldInput from './SessionSetFieldInput.svelte';

describe('SessionSetFieldInput', () => {
	it('preserves the logging, focus, and comparison accessibility attributes', () => {
		const { body } = render(SessionSetFieldInput, {
			props: {
				setId: 'set-1',
				field: 'weight',
				inputMode: 'decimal',
				ariaLabel: 'Set 01 weight',
				value: '102.5',
				previousValue: 100,
				delta: { state: 'improved', label: '+2.5' },
				indicatorPosition: 'bottom-left',
				onInput: () => undefined,
				onKeydown: () => undefined
			}
		});

		expect(body).toContain('name="tinytrain-set-set-1-weight"');
		expect(body).toContain('autocomplete="off"');
		expect(body).toContain('inputmode="decimal"');
		expect(body).toContain('enterkeyhint="next"');
		expect(body).toContain('data-session-set-input="true"');
		expect(body).toContain('aria-label="Set 01 weight"');
		expect(body).toContain('aria-describedby="set-set-1-weight-comparison"');
		expect(body).toContain('value="102.5"');
		expect(body).toContain('placeholder="100"');
		expect(body).toContain('data-delta-position="bottom-left"');
		expect(body).toContain('2.5 higher than the previous session');
		expect(body).not.toMatch(/<input[^>]*\sdisabled(?:=""|(?=[\s>]))/);
	});

	it('retains the numeric keyboard pattern without adding a comparison description', () => {
		const { body } = render(SessionSetFieldInput, {
			props: {
				setId: 'set-2',
				field: 'reps',
				inputMode: 'numeric',
				pattern: '[0-9]*',
				ariaLabel: 'Set 02 reps',
				value: '8',
				previousValue: 8,
				delta: { state: 'matched', label: '' },
				indicatorPosition: 'top-right',
				onInput: () => undefined,
				onKeydown: () => undefined
			}
		});

		expect(body).toContain('inputmode="numeric"');
		expect(body).toContain('pattern="[0-9]*"');
		expect(body).not.toContain('aria-describedby');
		expect(body).not.toContain('previous session');
	});

	it('uses native disabled semantics while a destructive session mutation is saving', () => {
		const { body } = render(SessionSetFieldInput, {
			props: {
				setId: 'set-3',
				field: 'rir',
				inputMode: 'numeric',
				pattern: '[0-9]*',
				ariaLabel: 'Set 03 RIR',
				value: '2',
				delta: { state: 'empty', label: '' },
				indicatorPosition: 'bottom-right',
				disabled: true,
				onInput: () => undefined,
				onKeydown: () => undefined
			}
		});

		expect(body).toMatch(/<input[^>]*\sdisabled(?:=""|(?=[\s>]))/);
		expect(body).toContain('aria-label="Set 03 RIR"');
	});
});
