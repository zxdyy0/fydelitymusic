// sw.js
// Two caching tiers, on purpose:
//
// 1. APP_SHELL — the actual UI (html/css/js/icons/manifest). Small, so we
//    precache all of it on install. This is what makes Fydelity open
//    instantly even with no signal, and is what makes it installable as a
//    real offline-capable PWA in the first place.
//
// 2. RUNTIME_CACHE — the ffmpeg.wasm core (~31MB: ffmpeg-core.js +
//    ffmpeg-core.wasm). We deliberately do NOT precache this on install —
//    that would make first install slow and would download 31MB even for
//    people whose whole library is MP3/AAC and never needs it. Instead it's
//    cached the first time a track actually triggers a decode (APE, or FLAC
//    without native support). After that first time, it's instant and fully
//    offline from cache.
//
// Nothing here ever touches the user's music files — those are opened
// directly from disk via the File System Access API / file input, never
// fetched over the network, so there's nothing to cache or leak there.

const SW_VERSION = 'fydelity-v2'; // bumped: v2 fixes the Android "picker does nothing" bug
const APP_SHELL_CACHE = `${SW_VERSION}-shell`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;

const APP_SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/audio-engine.js',
  './js/file-source.js',
  './vendor/ffmpeg/ffmpeg/index.js',
  './vendor/ffmpeg/ffmpeg/classes.js',
  './vendor/ffmpeg/ffmpeg/const.js',
  './vendor/ffmpeg/ffmpeg/errors.js',
  './vendor/ffmpeg/ffmpeg/types.js',
  './vendor/ffmpeg/ffmpeg/utils.js',
  './vendor/ffmpeg/ffmpeg/worker.js',
  './vendor/ffmpeg/util/index.js',
  './vendor/ffmpeg/util/const.js',
  './vendor/ffmpeg/util/errors.js',
  './vendor/ffmpeg/util/types.js',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Large, decode-only asset: fetched from a CDN (see audio-engine.js) rather
// than bundled locally — keeps this repo's own files under GitHub's 25MB
// web-upload limit. Still cached here after first fetch, so repeat use
// (including fully offline) is just as fast as if it were bundled.
const FFMPEG_CORE_ORIGIN = 'unpkg.com';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('fydelity-') && k !== APP_SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isFfmpegCore = url.hostname === FFMPEG_CORE_ORIGIN && url.pathname.includes('ffmpeg-core');

  if (isFfmpegCore) {
    // cache-first, fetch-and-cache on miss — first APE/FLAC-fallback decode
    // downloads it once (from the CDN), every decode after that (even
    // offline) is served from this cache instead
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok || response.type === 'opaque') {
            const clone = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // other cross-origin (fonts CDN etc.) — let the browser handle normally

  // app shell: cache-first with a network fallback, so an update to these
  // files (new deploy) is still reachable if the precache ever misses
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
