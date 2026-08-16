// Disables access to DOM typings like `HTMLElement` which are not available
// inside a service worker and instantiates the correct globals
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Ensures that the `$service-worker` import has proper type definitions
/// <reference types="@sveltejs/kit" />

// Only necessary if you have an import from `$env/static/public`
/// <reference types="../.svelte-kit/ambient.d.ts" />

import { build, files, version } from '$service-worker';

// This gives `self` the correct types
const self = globalThis.self as unknown as ServiceWorkerGlobalScope;

// Create a unique cache name for this deployment
const CACHE = `cache-${version}`;
const APP_SHELL = '/';
const DEV = import.meta.env.DEV;
const AUTH_CACHE_PARAM_NAMES = [
	'code',
	'state',
	'error',
	'error_description',
	'access_token',
	'refresh_token',
	'provider_token',
	'provider_refresh_token'
];

const ASSETS = [
	...build, // the app itself
	...files, // everything in `static`
	APP_SHELL
];
const CACHEABLE_ASSET_PATHS = new Set(
	ASSETS.map((asset) => new URL(asset, self.location.origin).pathname)
);

async function fetchFresh(request: Request | string) {
	const response = await fetch(request, { cache: 'no-store' });

	// if we're offline, fetch can return a value that is not a Response
	// instead of throwing - and we can't pass this non-Response to respondWith
	if (!(response instanceof Response)) {
		throw new Error('invalid response from fetch');
	}

	return response;
}

async function getCachedResponse(
	cache: Cache,
	request: Request,
	url: URL,
	options: { appShellFallback?: boolean } = {}
) {
	return (
		(await cache.match(request)) ??
		(await cache.match(url.pathname)) ??
		(options.appShellFallback && request.mode === 'navigate'
			? await cache.match(APP_SHELL)
			: undefined)
	);
}

function hasAuthCacheParams(url: URL) {
	for (const paramName of AUTH_CACHE_PARAM_NAMES) {
		if (url.searchParams.has(paramName)) {
			return true;
		}
	}

	return false;
}

function isSafeSameOriginUrl(url: URL) {
	return url.origin === self.location.origin && !hasAuthCacheParams(url);
}

function canUseOfflineCache(request: Request, url: URL) {
	return (
		isSafeSameOriginUrl(url) &&
		(request.mode === 'navigate' || CACHEABLE_ASSET_PATHS.has(url.pathname))
	);
}

function canStoreResponse(request: Request, response: Response) {
	if (
		request.mode === 'navigate' ||
		request.headers.has('authorization') ||
		response.status !== 200
	) {
		return false;
	}

	const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';

	return !cacheControl.includes('no-store') && !cacheControl.includes('private');
}

function cacheResponse(event: FetchEvent, cache: Cache, request: Request, response: Response) {
	if (
		CACHEABLE_ASSET_PATHS.has(new URL(request.url).pathname) &&
		canStoreResponse(request, response)
	) {
		event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
	}
}

async function addFilesToCache(cache: Cache) {
	const results = await Promise.allSettled(
		ASSETS.map(async (asset) => {
			await cache.add(asset);
			return asset;
		})
	);

	const failedAssets = results
		.map((result, index) => (result.status === 'rejected' ? ASSETS[index] : undefined))
		.filter((asset): asset is string => Boolean(asset));

	if (failedAssets.length > 0) {
		throw new Error(`Unable to precache ${failedAssets.length} required asset(s).`);
	}
}

self.addEventListener('install', (event) => {
	// Create a new cache and add all files to it
	async function installCache() {
		if (DEV) {
			await self.skipWaiting();
			return;
		}

		const cache = await caches.open(CACHE);
		await addFilesToCache(cache);
	}

	event.waitUntil(installCache());
});

self.addEventListener('activate', (event) => {
	// Remove previous cached data from disk
	async function deleteOldCaches() {
		for (const key of await caches.keys()) {
			if (DEV || key !== CACHE) await caches.delete(key);
		}

		if (DEV) {
			await self.clients.claim();
		}
	}

	event.waitUntil(deleteOldCaches());
});

self.addEventListener('fetch', (event) => {
	// ignore POST requests etc
	if (event.request.method !== 'GET') return;

	async function respond() {
		const url = new URL(event.request.url);
		const isSameOrigin = url.origin === self.location.origin;
		const isCacheableSameOrigin = isSameOrigin && canUseOfflineCache(event.request, url);
		const cache = await caches.open(CACHE);

		if (DEV) {
			try {
				const response = await fetchFresh(event.request);

				if (isCacheableSameOrigin) {
					cacheResponse(event, cache, event.request, response);
				}

				return response;
			} catch (err) {
				if (isCacheableSameOrigin) {
					const response = await getCachedResponse(cache, event.request, url, {
						appShellFallback: true
					});

					if (response) {
						return response;
					}
				}

				throw err;
			}
		}

		if (!isSameOrigin) {
			return fetch(event.request);
		}

		if (!isCacheableSameOrigin) {
			return fetchFresh(event.request);
		}

		const cached = await getCachedResponse(cache, event.request, url);

		if (cached) {
			return cached;
		}

		try {
			const response = await fetchFresh(event.request);

			cacheResponse(event, cache, event.request, response);
			return response;
		} catch (err) {
			const response = await getCachedResponse(cache, event.request, url, {
				appShellFallback: true
			});

			if (response) {
				return response;
			}

			// if there's no cache, then just error out
			// as there is nothing we can do to respond to this request
			throw err;
		}
	}

	event.respondWith(respond());
});
