import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { APP_SHELL, getCachedResponse, getDeploymentCacheName } from './service-worker-cache';

const serviceWorkerPath = fileURLToPath(new URL('./service-worker.ts', import.meta.url));

function fakeRequest(mode: RequestMode) {
	return { mode } as Request;
}

function fakeCache(match: (request: unknown) => Promise<Response | undefined>) {
	return { match } as unknown as Pick<Cache, 'match'>;
}

describe('service-worker deployment cache', () => {
	it('partitions cached shells and assets by the exact worker deployment version', () => {
		expect(getDeploymentCacheName('deployment-a')).toBe('cache-deployment-a');
		expect(getDeploymentCacheName('deployment-b')).toBe('cache-deployment-b');
		expect(getDeploymentCacheName('deployment-a')).not.toBe(getDeploymentCacheName('deployment-b'));
	});

	it('serves the controlling deployment app shell for uncached deep navigations', async () => {
		const appShell = new Response('deployment-a shell');
		const request = fakeRequest('navigate');
		const match = vi.fn(async (cacheKey: unknown) =>
			cacheKey === APP_SHELL ? appShell : undefined
		);

		const response = await getCachedResponse(
			fakeCache(match),
			request,
			new URL('https://tinytrain.test/sessions/session-1'),
			{ useAppShellForNavigation: true }
		);

		expect(response).toBe(appShell);
		expect(match).toHaveBeenCalledOnce();
		expect(match).toHaveBeenCalledWith(APP_SHELL);
	});

	it('returns no navigation match when the deployment app shell is missing', async () => {
		const request = fakeRequest('navigate');
		const unrelatedDeepNavigation = new Response('not a coherent app shell');
		const match = vi.fn(async (cacheKey: unknown) =>
			cacheKey === request ? unrelatedDeepNavigation : undefined
		);

		const response = await getCachedResponse(
			fakeCache(match),
			request,
			new URL('https://tinytrain.test/sessions/session-1'),
			{ useAppShellForNavigation: true }
		);

		expect(response).toBeUndefined();
		expect(match).toHaveBeenCalledOnce();
		expect(match).toHaveBeenCalledWith(APP_SHELL);
	});

	it('preserves exact and pathname matching for non-navigation assets', async () => {
		const asset = new Response('deployment-a asset');
		const request = fakeRequest('same-origin');
		const match = vi.fn(async (cacheKey: unknown) => (cacheKey === '/app.js' ? asset : undefined));

		const response = await getCachedResponse(
			fakeCache(match),
			request,
			new URL('https://tinytrain.test/app.js?v=deployment-a'),
			{ useAppShellForNavigation: true }
		);

		expect(response).toBe(asset);
		expect(match.mock.calls).toEqual([[request], ['/app.js']]);
	});

	it('wires production shell matching after the auth-safe cache gate and before network', () => {
		const source = readFileSync(serviceWorkerPath, 'utf8');
		const authSafeGateIndex = source.indexOf('if (!isCacheableSameOrigin)');
		const shellLookupIndex = source.indexOf(
			'const cached = await getCachedResponse(cache, event.request, url, {'
		);
		const networkFallbackIndex = source.indexOf(
			'const response = await fetchFresh(event.request);',
			shellLookupIndex
		);

		expect(source).toContain('const CACHE = getDeploymentCacheName(version);');
		expect(source).toContain('if (DEV || key !== CACHE) await caches.delete(key);');
		expect(authSafeGateIndex).toBeGreaterThanOrEqual(0);
		expect(shellLookupIndex).toBeGreaterThan(authSafeGateIndex);
		expect(networkFallbackIndex).toBeGreaterThan(shellLookupIndex);
		expect(source.slice(shellLookupIndex, networkFallbackIndex)).toContain(
			'useAppShellForNavigation: true'
		);
	});
});
