import {strict as assert} from 'node:assert';
import test from 'node:test';


// A fake indexedDB - the API surface bookcache.js uses. open's outcome is openMode: 'success' (an upgrade on the first
// open, then success), 'error', 'blocked', or 'throw' (open throws, as with IndexedDB disabled). The database's
// failTransaction makes transaction throw; failRequest makes each store request fail.
function fakeIndexedDB(openMode = 'success') {
    const fake = {
        'opens': [],
        'stores': {},
        'database': null,
        'open': (name, version) => {
            fake.opens.push([name, version]);
            if (openMode === 'throw') {
                throw new Error('SecurityError');
            }
            const request = {'result': undefined};
            setTimeout(() => {
                if (openMode === 'error') {
                    request.onerror();
                } else if (openMode === 'blocked') {
                    request.onblocked();
                } else {
                    request.result = fake.database;
                    if (fake.database.upgraded === false) {
                        request.onupgradeneeded();
                        fake.database.upgraded = true;
                    }
                    request.onsuccess();
                }
            }, 0);
            return request;
        }
    };
    fake.database = {
        'upgraded': false,
        'failTransaction': false,
        'failRequest': false,
        'transactions': [],
        'createObjectStore': (name, options) => {
            fake.stores[name] = {options, 'records': new Map()};
        },
        'transaction': (storeName, mode) => {
            if (fake.database.failTransaction) {
                throw new Error('InvalidStateError');
            }
            fake.database.transactions.push([storeName, mode]);
            return {
                'objectStore': (name) => {
                    const {options, records} = fake.stores[name];
                    const makeRequest = (action) => {
                        const request = {'result': undefined};
                        setTimeout(() => {
                            if (fake.database.failRequest) {
                                request.onerror();
                            } else {
                                request.result = action();
                                request.onsuccess();
                            }
                        }, 0);
                        return request;
                    };
                    return {
                        'get': (key) => makeRequest(() => records.get(key)),
                        'put': (record) => makeRequest(() => {
                            records.set(record[options.keyPath], record);
                            return record[options.keyPath];
                        }),
                        'delete': (key) => makeRequest(() => {
                            records.delete(key);
                            return undefined;
                        })
                    };
                }
            };
        }
    };
    globalThis.indexedDB = fake;
    return fake;
}


// A fresh bookcache.js module (its database is opened once per module)
let moduleCount = 0;
function importBookcache() {
    moduleCount += 1;
    return import(`../lib/bookcache.js?instance=${moduleCount}`);
}


const book = {'key': 'gutenberg-2701', 'text': 'Call me Ishmael.', 'chapters': [{'title': 'Loomings', 'start': 0}],
    'title': 'Moby-Dick', 'author': 'Herman Melville'};


test('bookcache, put, get, and delete', async () => {
    const fake = fakeIndexedDB();
    const {deleteCachedBook, getCachedBook, putCachedBook} = await importBookcache();

    // Not cached
    assert.equal(await getCachedBook(book.key), null);
    assert.deepEqual(fake.opens, [['audiobooks', 1]]);
    assert.deepEqual(fake.stores.books.options, {'keyPath': 'key'});

    // Cached
    assert.equal(await putCachedBook(book), book.key);
    assert.deepEqual(await getCachedBook(book.key), book);
    assert.equal(await getCachedBook('other'), null);

    // Deleted
    assert.equal(await deleteCachedBook(book.key), null);
    assert.equal(await getCachedBook(book.key), null);

    // The database is opened once
    assert.equal(fake.opens.length, 1);
    assert.deepEqual(fake.database.transactions, [
        ['books', 'readonly'],
        ['books', 'readwrite'],
        ['books', 'readonly'],
        ['books', 'readonly'],
        ['books', 'readwrite'],
        ['books', 'readonly']
    ]);
});


test('bookcache, existing database', async () => {
    const fake = fakeIndexedDB();
    fake.database.upgraded = true;
    fake.database.createObjectStore('books', {'keyPath': 'key'});
    fake.stores.books.records.set(book.key, book);
    const {getCachedBook} = await importBookcache();
    assert.deepEqual(await getCachedBook(book.key), book);
});


test('bookcache, request error', async () => {
    const fake = fakeIndexedDB();
    const {deleteCachedBook, getCachedBook, putCachedBook} = await importBookcache();
    assert.equal(await putCachedBook(book), book.key);
    fake.database.failRequest = true;
    assert.equal(await getCachedBook(book.key), null);
    assert.equal(await putCachedBook(book), null);
    assert.equal(await deleteCachedBook(book.key), null);
    fake.database.failRequest = false;
    assert.deepEqual(await getCachedBook(book.key), book);
});


test('bookcache, transaction error', async () => {
    const fake = fakeIndexedDB();
    const {getCachedBook, putCachedBook} = await importBookcache();
    assert.equal(await putCachedBook(book), book.key);
    fake.database.failTransaction = true;
    assert.equal(await getCachedBook(book.key), null);
    assert.equal(await putCachedBook(book), null);
});


test('bookcache, open error', async () => {
    const fake = fakeIndexedDB('error');
    const {getCachedBook, putCachedBook} = await importBookcache();
    assert.equal(await putCachedBook(book), null);
    assert.equal(await getCachedBook(book.key), null);

    // A failed open isn't retried
    assert.equal(fake.opens.length, 1);
});


test('bookcache, open blocked', async () => {
    const fake = fakeIndexedDB('blocked');
    const {getCachedBook} = await importBookcache();
    assert.equal(await getCachedBook(book.key), null);
    assert.equal(fake.opens.length, 1);
    assert.equal(fake.stores.books, undefined);
});


test('bookcache, IndexedDB unavailable', async () => {
    const fake = fakeIndexedDB('throw');
    const {deleteCachedBook, getCachedBook, putCachedBook} = await importBookcache();
    assert.equal(await putCachedBook(book), null);
    assert.equal(await getCachedBook(book.key), null);
    assert.equal(await deleteCachedBook(book.key), null);
    assert.equal(fake.opens.length, 1);
});
