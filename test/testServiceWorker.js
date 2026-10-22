import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';


// The service worker's source (static/sw.js - make app writes its version and files)
const workerSource = readFileSync(new URL('../static/sw.js', import.meta.url), 'utf-8');
const origin = 'https://example.github.io';


// A fake response - its status, and whether it's the clone
function fakeResponse(status, body) {
    return {status, 'ok': status >= 200 && status < 300, body, 'clone': () => ({status, body, 'cloned': true})};
}


// Run the service worker with fake caches (name -> Map of URL -> response) and a fake fetch (request -> response, or a
// thrown error) - its event handlers, and what it did
function runWorker({cacheNames = [], cached = {}, fetchResponse = () => fakeResponse(200, 'network')} = {}) {
    const handlers = {};
    const calls = [];
    const caches = new Map(cacheNames.map((name) => [name, new Map()]));
    const context = {
        URL,
        'self': {
            'location': {origin},
            'addEventListener': (type, handler) => {
                handlers[type] = handler;
            },
            'skipWaiting': () => {
                calls.push(['skipWaiting']);
                return Promise.resolve();
            },
            'clients': {'claim': () => {
                calls.push(['claim']);
                return Promise.resolve();
            }}
        },
        'caches': {
            'open': (name) => {
                if (!caches.has(name)) {
                    caches.set(name, new Map());
                }
                const cache = caches.get(name);
                return Promise.resolve({
                    'addAll': (urls) => {
                        // (a copy - the worker's arrays are its context's)
                        calls.push(['addAll', name, [...urls]]);
                        return Promise.resolve();
                    },
                    'put': (request, response) => {
                        cache.set(request.url, response);
                        return Promise.resolve();
                    }
                });
            },
            'keys': () => Promise.resolve([...caches.keys()]),
            'delete': (name) => {
                calls.push(['delete', name]);
                return Promise.resolve(caches.delete(name));
            },
            'match': (request, options) => {
                calls.push(['match', typeof request === 'string' ? request : request.url, options]);
                return Promise.resolve(cached[typeof request === 'string' ? request : request.url]);
            }
        },
        'fetch': (request) => {
            calls.push(['fetch', request.url]);
            return Promise.resolve().then(() => fetchResponse(request));
        }
    };
    vm.runInNewContext(workerSource, context);
    return {handlers, calls, caches};
}


// Dispatch an event to a handler - the promises it waited on and its response (respondWith's), settled
async function dispatch(handler, data = {}) {
    const waits = [];
    let response = null;
    handler({
        ...data,
        'waitUntil': (promise) => {
            waits.push(promise);
        },
        'respondWith': (promise) => {
            response = promise;
        }
    });
    await Promise.all(waits);
    return {waits, response};
}


test('service worker, install', async () => {
    const {handlers, calls} = runWorker();
    const {waits} = await dispatch(handlers.install);
    assert.equal(waits.length, 1);
    assert.deepEqual(calls, [['addAll', 'picoshelf-development', []], ['skipWaiting']]);
});


test('service worker, install with make app\'s files', async () => {
    // (as make app writes them)
    const source = workerSource.replace('const version = \'development\';', 'const version = \'0123abcd\';').
        replace('const files = [];', 'const files = ["./","lib/app.js"];');
    assert.notEqual(source, workerSource);
    const calls = [];
    const handlers = {};
    vm.runInNewContext(source, {
        'self': {'addEventListener': (type, handler) => {
            handlers[type] = handler;
        }, 'skipWaiting': () => Promise.resolve()},
        'caches': {'open': (name) => Promise.resolve({'addAll': (urls) => {
            calls.push([name, [...urls]]);
            return Promise.resolve();
        }})}
    });
    await dispatch(handlers.install);
    assert.deepEqual(calls, [['picoshelf-0123abcd', ['./', 'lib/app.js']]]);
});


test('service worker, activate', async () => {
    const {handlers, calls, caches} = runWorker({'cacheNames': ['picoshelf-old', 'picoshelf-development', 'other']});
    await dispatch(handlers.activate);
    assert.deepEqual(calls, [['delete', 'picoshelf-old'], ['claim']]);
    assert.deepEqual([...caches.keys()], ['picoshelf-development', 'other']);
});


test('service worker, fetch from the network', async () => {
    const {handlers, calls, caches} = runWorker();
    const request = {'method': 'GET', 'url': `${origin}/picoshelf/lib/app.js`, 'mode': 'cors'};
    const {response} = await dispatch(handlers.fetch, {request});
    const result = await response;
    assert.equal(result.body, 'network');
    assert.deepEqual(calls, [['fetch', request.url]]);

    // Cached (the clone) for offline
    await Promise.resolve();
    assert.deepEqual(caches.get('picoshelf-development').get(request.url), {'status': 200, 'body': 'network', 'cloned': true});
});


test('service worker, fetch an error status', async () => {
    const {handlers, caches} = runWorker({'fetchResponse': () => fakeResponse(404, 'missing')});
    const request = {'method': 'GET', 'url': `${origin}/picoshelf/missing.js`, 'mode': 'cors'};
    const {response} = await dispatch(handlers.fetch, {request});
    assert.equal((await response).status, 404);
    assert.equal(caches.has('picoshelf-development'), false);
});


test('service worker, fetch offline', async () => {
    const offline = () => {
        throw new TypeError('Failed to fetch');
    };
    const pageUrl = `${origin}/picoshelf/?timing`;
    const fileUrl = `${origin}/picoshelf/lib/app.js`;
    const {handlers, calls} = runWorker({'fetchResponse': offline, 'cached': {'./': 'the index', [fileUrl]: 'the file'}});

    // A file - from the cache
    let {response} = await dispatch(handlers.fetch, {'request': {'method': 'GET', 'url': fileUrl, 'mode': 'cors'}});
    assert.equal(await response, 'the file');

    // The page - the cached index, whatever its search
    ({response} = await dispatch(handlers.fetch, {'request': {'method': 'GET', 'url': pageUrl, 'mode': 'navigate'}}));
    assert.equal(await response, 'the index');
    assert.deepEqual(calls.filter(([name]) => name === 'match').map(([, url, options]) => [url, options.ignoreSearch]), [
        [fileUrl, true], ['./', true]
    ]);

    // Not cached - the network's error
    ({response} = await dispatch(handlers.fetch, {'request': {'method': 'GET', 'url': `${origin}/picoshelf/other.js`, 'mode': 'cors'}}));
    await assert.rejects(response, {'name': 'TypeError', 'message': 'Failed to fetch'});
});


test('service worker, fetch not handled', async () => {
    const {handlers, calls} = runWorker();

    // Another site's request (a book, Wikipedia, a cover), and a request that isn't a GET
    for (const request of [{'method': 'GET', 'url': 'https://en.wikipedia.org/w/api.php'}, {'method': 'POST', 'url': `${origin}/log`}]) {
        const {response} = await dispatch(handlers.fetch, {request});
        assert.equal(response, null);
    }
    assert.deepEqual(calls, []);
});
