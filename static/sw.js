// The service worker - PicoShelf offline. The site's files (the app, PicoVox and its models, and the catalog) are cached
// when it installs, and each request for them is answered from the network when it can (so a new version is used at
// once), else from the cache - the page (with any search or hash) from the cached index. The listener's books are kept by
// the app (lib/bookcache.js), so the books they've opened play offline. make app writes the version (a hash of the
// files) and the files below; a new version replaces the old cache.

const version = 'development';
const files = [];
const cacheName = `picoshelf-${version}`;


// Install - cache the site's files
self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(files)).then(() => self.skipWaiting()));
});


// Activate - delete the older versions' caches, and serve the open pages
self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((names) => Promise.all(
        names.filter((name) => name.startsWith('picoshelf-') && name !== cacheName).map((name) => caches.delete(name))
    )).then(() => self.clients.claim()));
});


// Fetch - the site's files from the network (refreshing the cache), else from the cache; other sites' requests (the
// books, Wikipedia, covers) aren't handled
self.addEventListener('fetch', (event) => {
    const {request} = event;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
        return;
    }
    event.respondWith(fetch(request).then((response) => {
        if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(cacheName).then((cache) => cache.put(request, copy)));
        }
        return response;
    }).catch(async (error) => {
        const cached = await caches.match(request.mode === 'navigate' ? './' : request, {'ignoreSearch': true});
        if (cached === undefined) {
            throw error;
        }
        return cached;
    }));
});
