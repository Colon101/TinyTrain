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
import 'dexie-cloud-addon/service-worker';

// This gives `self` the correct types
const self = globalThis.self as unknown as ServiceWorkerGlobalScope;

// Create a unique cache name for this deployment
const CACHE = `cache-${version}`;
const APP_SHELL = '/';
const DEPLOYMENT_MANIFEST = '/deployment.json';
const DEV = import.meta.env.DEV;
const LOG_PREFIX = '[TinyTrain service worker]';

const ASSETS = [
	...build, // the app itself
	...files, // everything in `static`
	APP_SHELL
];

type DeploymentManifest = {
	id?: unknown;
};

type CacheUrlsMessage = {
	type?: unknown;
	urls?: unknown;
};

let currentDeploymentPromise: Promise<boolean> | undefined;

async function fetchFresh(request: Request | string) {
	const response = await fetch(request, { cache: 'no-store' });

	// if we're offline, fetch can return a value that is not a Response
	// instead of throwing - and we can't pass this non-Response to respondWith
	if (!(response instanceof Response)) {
		throw new Error('invalid response from fetch');
	}

	return response;
}

async function getCachedResponse(cache: Cache, request: Request, url: URL) {
	return (
		(await cache.match(request)) ??
		(await cache.match(url.pathname)) ??
		(request.mode === 'navigate' ? await cache.match(APP_SHELL) : undefined)
	);
}

async function readDeploymentId(response: Response | undefined) {
	if (!response?.ok) return undefined;

	try {
		const manifest = (await response.clone().json()) as DeploymentManifest;
		return typeof manifest.id === 'string' ? manifest.id : undefined;
	} catch {
		return undefined;
	}
}

async function hasCurrentDeployment(cache: Cache) {
	console.info(`${LOG_PREFIX} checking for cache update`);

	const [cachedResponse, latestResponse] = await Promise.all([
		cache.match(DEPLOYMENT_MANIFEST),
		fetchFresh(`${DEPLOYMENT_MANIFEST}?sw-update=${Date.now()}`)
	]);

	const cachedId = await readDeploymentId(cachedResponse);
	const latestId = await readDeploymentId(latestResponse);

	const hasCurrentDeployment = Boolean(cachedId && latestId && cachedId === latestId);

	console.info(
		hasCurrentDeployment
			? `${LOG_PREFIX} cache is current`
			: `${LOG_PREFIX} newer deployment found, skipping cache for this load`,
		{ cachedId, latestId }
	);

	return hasCurrentDeployment;
}

function hasVerifiedCurrentDeployment(cache: Cache) {
	currentDeploymentPromise ??= hasCurrentDeployment(cache).catch((error: unknown) => {
		console.info(`${LOG_PREFIX} cache update check failed, trusting cache`, error);
		return true;
	});

	return currentDeploymentPromise;
}

function cacheResponse(event: FetchEvent, cache: Cache, request: Request, response: Response) {
	if (response.status === 200) {
		event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
	}
}

async function cacheUrls(urls: unknown) {
	if (!Array.isArray(urls)) {
		return;
	}

	const cache = await caches.open(CACHE);

	await Promise.all(
		urls.map(async (url) => {
			if (typeof url !== 'string') {
				return;
			}

			try {
				const parsedUrl = new URL(url, self.location.origin);

				if (parsedUrl.origin !== self.location.origin) {
					return;
				}

				const response = await fetchFresh(parsedUrl.href);

				if (response.status === 200) {
					await cache.put(parsedUrl.href, response);
				}
			} catch {
				// Best-effort cache warming only.
			}
		})
	);
}

self.addEventListener('install', (event) => {
	// Create a new cache and add all files to it
	async function addFilesToCache() {
		if (DEV) {
			await self.skipWaiting();
			return;
		}

		const cache = await caches.open(CACHE);
		await cache.addAll(ASSETS);
		await self.skipWaiting();
	}

	event.waitUntil(addFilesToCache());
});

self.addEventListener('activate', (event) => {
	// Remove previous cached data from disk
	async function deleteOldCaches() {
		for (const key of await caches.keys()) {
			if (DEV || key !== CACHE) await caches.delete(key);
		}

		await self.clients.claim();
	}

	event.waitUntil(deleteOldCaches());
});

self.addEventListener('message', (event) => {
	const data = event.data as CacheUrlsMessage;

	if (data?.type === 'CACHE_URLS') {
		event.waitUntil(cacheUrls(data.urls));
	}
});

self.addEventListener('fetch', (event) => {
	// ignore POST requests etc
	if (event.request.method !== 'GET') return;

	async function respond() {
		const url = new URL(event.request.url);
		const isSameOrigin = url.origin === self.location.origin;
		const cache = await caches.open(CACHE);

		if (DEV) {
			try {
				const response = await fetchFresh(event.request);

				if (isSameOrigin) {
					cacheResponse(event, cache, event.request, response);
				}

				return response;
			} catch (err) {
				if (isSameOrigin) {
					const response = await getCachedResponse(cache, event.request, url);

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

		if (url.pathname === DEPLOYMENT_MANIFEST) {
			return fetchFresh(event.request);
		}

		// Check the deploy UUID once before trusting the cache. If the check fails,
		// assume we're offline and let the cache carry the app.
		const canUseCache = await hasVerifiedCurrentDeployment(cache);

		if (canUseCache) {
			const cached = await getCachedResponse(cache, event.request, url);

			if (cached) {
				return cached;
			}
		}

		try {
			const response = await fetchFresh(event.request);

			cacheResponse(event, cache, event.request, response);
			return response;
		} catch (err) {
			const response = await getCachedResponse(cache, event.request, url);

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
