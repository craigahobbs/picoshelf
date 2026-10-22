import test, {mock} from 'node:test';
import {strict as assert} from 'node:assert';
import {prepareText} from '../lib/gutenberg.js';
import {source} from '../lib/sources/gutenberg.js';


// A Project Gutenberg book's text
const bookText = [
    'Title: A Short Book',
    '',
    'Author: Jane Doe',
    '',
    '*** START OF THE PROJECT GUTENBERG EBOOK A SHORT BOOK ***',
    '',
    'CHAPTER I.',
    '',
    'It was a dark and stormy',
    'night, and café lights burned.',
    '',
    '*** END OF THE PROJECT GUTENBERG EBOOK A SHORT BOOK ***',
    ''
].join('\n');
const bookBytes = new TextEncoder().encode(bookText);
const book = {'id': 1, 'text': {'url': 'https://raw.githubusercontent.com/GITenberg/book/master/1.txt'}};


// A readable stream of the chunks, optionally failing after them
function chunkStream(chunks, error = null) {
    let ix = 0;
    return new ReadableStream({
        pull(controller) {
            if (ix < chunks.length) {
                controller.enqueue(chunks[ix++]);
            } else if (error !== null) {
                controller.error(error);
            } else {
                controller.close();
            }
        }
    });
}


// A fake response - {status, type, headers, body (a stream)}
function fakeResponse({status = 200, type = 'basic', headers = {}, body = null}) {
    return {status, 'ok': status >= 200 && status < 300, type, 'headers': new Headers(headers), body};
}


// Run a test function with a fake fetch, restoring the real one - returns the fetched URLs
async function withFetch(fakeFetch, fn) {
    const fetchMock = mock.method(globalThis, 'fetch', (url, options) => Promise.resolve().then(() => fakeFetch(url, options)));
    try {
        await fn();
    } finally {
        fetchMock.mock.restore();
    }
    return fetchMock.mock.calls.map((call) => call.arguments[0]);
}


// A progress callback that ignores progress
function ignoreProgress() {
    // no progress checks
}


// Record progress calls
function progressRecorder() {
    const calls = [];
    const onProgress = (loaded, total) => {
        calls.push([loaded, total]);
    };
    return {calls, onProgress};
}


test('gutenberg source, properties', () => {
    assert.equal(source.id, 'gutenberg');
    assert.equal(typeof source.load, 'function');
});


test('gutenberg source, load', async () => {
    const {calls, onProgress} = progressRecorder();
    const urls = await withFetch(
        () => fakeResponse({
            'headers': {'Content-Length': String(bookBytes.length)},
            'body': chunkStream([bookBytes.subarray(0, 50), bookBytes.subarray(50)])
        }),
        async () => {
            const result = await source.load(book, onProgress);
            assert.deepEqual(result, prepareText(bookText, book));
            assert.equal(result.title, 'A Short Book');
            assert.equal(result.author, 'Jane Doe');
            assert.match(result.text, /It was a dark and stormy night, and café lights burned\./);
            assert.equal(result.chapters.length, 1);
        }
    );
    assert.deepEqual(urls, [book.text.url]);
    assert.deepEqual(calls, [
        [0, bookBytes.length],
        [50, bookBytes.length],
        [bookBytes.length, bookBytes.length]
    ]);
});


test('gutenberg source, load encoding', async () => {
    // Windows-1252 "café" - é is 0xE9
    const latinBytes = Uint8Array.from([...'Caf'].map((char) => char.charCodeAt(0)).concat([0xE9, 0x2E]));
    const latinBook = {'id': 2, 'text': {'url': 'https://example.com/2.txt', 'encoding': 'windows-1252'}};
    await withFetch(
        () => fakeResponse({'body': chunkStream([latinBytes])}),
        async () => {
            const result = await source.load(latinBook, ignoreProgress);
            assert.match(result.text, /Café\./);
        }
    );
});


test('gutenberg source, load cross-origin length unknown', async () => {
    // A compressed cross-origin response's Content-Length is the compressed size - the total is unknown
    const {calls, onProgress} = progressRecorder();
    await withFetch(
        () => fakeResponse({
            'type': 'cors',
            'headers': {'Content-Length': '10', 'Content-Encoding': 'gzip'},
            'body': chunkStream([bookBytes])
        }),
        async () => {
            await source.load(book, onProgress);
        }
    );
    assert.deepEqual(calls, [[0, null], [bookBytes.length, null], [bookBytes.length, bookBytes.length]]);
});


test('gutenberg source, load cross-origin identity', async () => {
    const {calls, onProgress} = progressRecorder();
    await withFetch(
        () => fakeResponse({
            'type': 'cors',
            'headers': {'Content-Length': String(bookBytes.length), 'Content-Encoding': 'identity'},
            'body': chunkStream([bookBytes])
        }),
        async () => {
            await source.load(book, onProgress);
        }
    );
    assert.deepEqual(calls, [[0, bookBytes.length], [bookBytes.length, bookBytes.length]]);
});


test('gutenberg source, load length too small', async () => {
    // More bytes than the Content-Length - the total becomes unknown
    const {calls, onProgress} = progressRecorder();
    await withFetch(
        () => fakeResponse({
            'headers': {'Content-Length': '50'},
            'body': chunkStream([bookBytes.subarray(0, 40), bookBytes.subarray(40)])
        }),
        async () => {
            await source.load(book, onProgress);
        }
    );
    assert.deepEqual(calls, [[0, 50], [40, 50], [bookBytes.length, null], [bookBytes.length, bookBytes.length]]);
});


test('gutenberg source, load real response', async () => {
    // A Response (type "default") with its Content-Length
    await withFetch(
        () => new Response(bookBytes, {'headers': {'Content-Length': String(bookBytes.length)}}),
        async () => {
            const result = await source.load(book, ignoreProgress);
            assert.deepEqual(result, prepareText(bookText, book));
        }
    );
});


test('gutenberg source, load no URL', async () => {
    const message = 'This book isn\'t available from GITenberg, the Project Gutenberg mirror this app reads.';
    const urls = await withFetch(
        () => assert.fail('unexpected fetch'),
        async () => {
            await assert.rejects(source.load(null), {message});
            await assert.rejects(source.load({'id': 1}), {message});
            await assert.rejects(source.load({'id': 1, 'text': {}}), {message});
        }
    );
    assert.deepEqual(urls, []);
});


test('gutenberg source, load offline', async () => {
    await withFetch(
        () => {
            throw new TypeError('Failed to fetch');
        },
        async () => {
            await assert.rejects(source.load(book), {'message': 'Couldn\'t download the book - check your connection and try again.'});
        }
    );
});


// A response body that records its cancel
function cancelableBody() {
    const body = {'canceled': false};
    body.stream = new ReadableStream({
        cancel() {
            body.canceled = true;
        }
    });
    return body;
}


test('gutenberg source, load not found', async () => {
    // The error page's body is canceled
    const body = cancelableBody();
    await withFetch(
        () => fakeResponse({'status': 404, 'body': body.stream}),
        async () => {
            await assert.rejects(source.load(book), {
                'message': 'This book isn\'t available from GITenberg, the Project Gutenberg mirror this app reads.'
            });
        }
    );
    assert.ok(body.canceled);
});


test('gutenberg source, load error status', async () => {
    const body = cancelableBody();
    await withFetch(
        () => fakeResponse({'status': 503, 'body': body.stream}),
        async () => {
            await assert.rejects(source.load(book), {'message': 'The book couldn\'t be downloaded (error 503) - try again later.'});
        }
    );
    assert.ok(body.canceled);

    // Without a body
    await withFetch(
        () => fakeResponse({'status': 503}),
        async () => {
            await assert.rejects(source.load(book), {'message': 'The book couldn\'t be downloaded (error 503) - try again later.'});
        }
    );
});


test('gutenberg source, load read error', async () => {
    const {calls, onProgress} = progressRecorder();
    await withFetch(
        () => fakeResponse({'body': chunkStream([bookBytes.subarray(0, 10)], new Error('connection reset'))}),
        async () => {
            await assert.rejects(source.load(book, onProgress), {
                'message': 'Couldn\'t download the book - check your connection and try again.'
            });
        }
    );
    assert.deepEqual(calls, [[0, null], [10, null]]);
});
