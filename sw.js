/**
 * Service Worker — caches all app files for offline use.
 * Version bump (CACHE_NAME) forces a full refresh on update.
 */
'use strict';

const CACHE_NAME = 'c4solver-v1';
const ASSETS = [
  './',
  './index.html',
  './solver-worker.js',
  './manifest.json',
  './icon-192.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Cache-first for app shell; network-first could also work
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
