// The downloaded-book cache in IndexedDB - each prepared book (text and chapters) by its key, so reopening a book (or
// reloading the page) doesn't download it again, and books keep working offline. IndexedDB may be unavailable (private
// browsing), in which case the cache is simply empty.


// Open the database - resolves to null if IndexedDB is unavailable. The connection is kept, but a failed open, a
// failed request, or a connection the browser closes (Safari can lose its IndexedDB server - "Connection to Indexed
// Database server lost") is forgotten, so the next call opens the database again.
let databasePromise = null;
function openDatabase() {
    if (databasePromise === null) {
        const opened = new Promise((resolve) => {
            try {
                const request = indexedDB.open('audiobooks', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('books', {'keyPath': 'key'});
                request.onsuccess = () => {
                    request.result.onclose = () => forgetDatabase(opened);
                    resolve(request.result);
                };
                request.onerror = () => resolve(null);
                request.onblocked = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
        opened.then((database) => {
            if (database === null) {
                forgetDatabase(opened);
            }
        });
        databasePromise = opened;
    }
    return databasePromise;
}


// Forget a database connection (a promise of it) - unless it's been replaced already
function forgetDatabase(opened) {
    if (databasePromise === opened) {
        databasePromise = null;
    }
}


// Run a request on the books store - resolves to its result, or null on failure
async function withStore(mode, makeRequest) {
    const opened = openDatabase();
    const database = await opened;
    if (database === null) {
        return null;
    }
    return new Promise((resolve) => {
        const fail = () => {
            forgetDatabase(opened);
            resolve(null);
        };
        try {
            const request = makeRequest(database.transaction('books', mode).objectStore('books'));
            request.onsuccess = () => resolve(request.result === undefined ? null : request.result);
            request.onerror = fail;
        } catch {
            fail();
        }
    });
}


// Get a cached book - {key, text, chapters, title, author}, or null
export function getCachedBook(key) {
    return withStore('readonly', (store) => store.get(key));
}


// Cache a book
export function putCachedBook(record) {
    return withStore('readwrite', (store) => store.put(record));
}


// Remove a cached book
export function deleteCachedBook(key) {
    return withStore('readwrite', (store) => store.delete(key));
}
