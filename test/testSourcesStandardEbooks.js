import {crc32, deflateRawSync} from 'node:zlib';
import test, {mock} from 'node:test';
import {JSDOM} from 'jsdom';
import {strict as assert} from 'node:assert';
import {convertEpub} from '../lib/epub.js';
import {openZip} from '../lib/zip.js';
import {source} from '../lib/sources/standardebooks.js';


// lib/epub.js parses XML with the global DOMParser
globalThis.DOMParser = new JSDOM('').window.DOMParser;


// Build a ZIP file - entries is an array of {name, data (string or Uint8Array), deflate}; returns
// {bytes, offsets (name to local header offset), directoryOffset}
function buildZip(entries, comment = '') {
    const encoder = new TextEncoder();
    const locals = [];
    const centrals = [];
    const offsets = new Map();
    let offset = 0;
    for (const {name, data, deflate = false} of entries) {
        const nameBytes = encoder.encode(name);
        const raw = typeof data === 'string' ? encoder.encode(data) : data;
        const stored = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
        const method = deflate ? 8 : 0;
        const crc = crc32(raw);

        // Local header
        const local = new Uint8Array(30 + nameBytes.length + stored.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(8, method, true);
        localView.setUint32(14, crc, true);
        localView.setUint32(18, stored.length, true);
        localView.setUint32(22, raw.length, true);
        localView.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        local.set(stored, 30 + nameBytes.length);
        locals.push(local);

        // Central directory header
        const central = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(10, method, true);
        centralView.setUint32(16, crc, true);
        centralView.setUint32(20, stored.length, true);
        centralView.setUint32(24, raw.length, true);
        centralView.setUint16(28, nameBytes.length, true);
        centralView.setUint32(42, offset, true);
        central.set(nameBytes, 46);
        centrals.push(central);

        offsets.set(name, offset);
        offset += local.length;
    }

    // End of central directory
    const directoryOffset = offset;
    const directorySize = centrals.reduce((sum, central) => sum + central.length, 0);
    const commentBytes = encoder.encode(comment);
    const end = new Uint8Array(22 + commentBytes.length);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, directorySize, true);
    endView.setUint32(16, directoryOffset, true);
    endView.setUint16(20, commentBytes.length, true);
    end.set(commentBytes, 22);

    // Concatenate
    const parts = [...locals, ...centrals, end];
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let pos = 0;
    for (const part of parts) {
        bytes.set(part, pos);
        pos += part.length;
    }
    return {bytes, offsets, directoryOffset};
}


// An EPUB's entries - with an image of imageSize bytes (stored) between the package and the chapter
function epubEntries(imageSize) {
    return [
        {'name': 'mimetype', 'data': 'application/epub+zip'},
        {
            'name': 'META-INF/container.xml',
            'data': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
                '<rootfiles><rootfile full-path="epub/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
                '</container>'
        },
        {
            'name': 'epub/content.opf',
            'deflate': true,
            'data': '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
                '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Short Story</dc:title>' +
                '<dc:creator>Ann Author</dc:creator></metadata>' +
                '<manifest><item id="chapter-1" href="text/chapter-1.xhtml" media-type="application/xhtml+xml"/>' +
                '<item id="cover" href="images/cover.jpg" media-type="image/jpeg"/></manifest>' +
                '<spine><itemref idref="chapter-1"/></spine></package>'
        },
        {'name': 'epub/images/cover.jpg', 'data': new Uint8Array(imageSize)},
        {
            'name': 'epub/text/chapter-1.xhtml',
            'deflate': true,
            'data': '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
                '<head><title>I</title></head><body><section id="chapter-1" epub:type="chapter">' +
                '<h2 epub:type="title">The Beginning</h2><p>Once upon a time there was a story.</p>' +
                '<p>It was short.</p></section></body></html>'
        }
    ];
}


// The EPUBs - small (downloaded whole), large (downloaded in ranges), and large with a long ZIP comment (its directory
// before the tail)
const smallEpub = buildZip(epubEntries(1000));
const largeEpub = buildZip(epubEntries(1600000));
const commentEpub = buildZip(epubEntries(1600000), ' '.repeat(65500));
const epubUrl = 'https://standardebooks.org/ebooks/ann-author/the-short-story/downloads/ann-author_the-short-story.epub';
const book = {'id': 'ann-author/the-short-story', 'text': {'url': epubUrl}};


// The expected book
const expected = await convertEpub(openZip(smallEpub.bytes));

test('standard ebooks fixture', () => {
    assert.equal(expected.title, 'The Short Story');
    assert.equal(expected.author, 'Ann Author');
    assert.match(expected.text, /Once upon a time there was a story\./);
    assert.deepEqual(expected.chapters.map((chapter) => chapter.title), ['The Beginning']);
});


// A fake Standard Ebooks server for a file's bytes - responds to HEAD, Range, and whole-file requests; respond
// (request) may return a response to override the default. Returns the fetch function and its requests, each
// {method, range (or null)}.
function fakeServer(bytes, respond = () => null) {
    const requests = [];
    const fakeFetch = (url, options) => {
        assert.equal(url, epubUrl);
        const method = options.method ?? 'GET';
        const range = options.headers?.Range ?? null;
        const request = {method, range};
        requests.push(request);
        const response = respond(request);
        if (response !== null) {
            return Promise.resolve(response);
        }
        if (method === 'HEAD') {
            return Promise.resolve(new Response(null, {
                'headers': {'Content-Length': String(bytes.length), 'Content-Type': 'application/epub+zip'}
            }));
        }
        if (range !== null) {
            const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
            const slice = bytes.slice(Number(start), Number(end) + 1);
            return Promise.resolve(new Response(slice, {'status': 206, 'headers': {'Content-Length': String(slice.length)}}));
        }
        return Promise.resolve(new Response(bytes, {'headers': {'Content-Length': String(bytes.length)}}));
    };
    return {fakeFetch, requests};
}


// Run a test function with a fake fetch, restoring the real one
async function withFetch(fakeFetch, fn) {
    const fetchMock = mock.method(globalThis, 'fetch', (url, options) => Promise.resolve().then(() => fakeFetch(url, options)));
    try {
        await fn();
    } finally {
        fetchMock.mock.restore();
    }
}


// Record progress calls
function progressRecorder() {
    const calls = [];
    const onProgress = (loaded, total) => {
        calls.push([loaded, total]);
    };
    return {calls, onProgress};
}


// The range header for bytes [start, end)
function rangeHeader(start, end) {
    return `bytes=${start}-${end - 1}`;
}


// The requests of a whole-file download
const wholeRequests = [{'method': 'HEAD', 'range': null}, {'method': 'GET', 'range': null}];


test('standard ebooks source, properties', () => {
    assert.equal(source.id, 'standardebooks');
    assert.equal(source.name, 'Standard Ebooks');
    assert.equal(typeof source.load, 'function');
});


test('standard ebooks source, load small', async () => {
    const {fakeFetch, requests} = fakeServer(smallEpub.bytes);
    const {calls, onProgress} = progressRecorder();
    await withFetch(fakeFetch, async () => {
        assert.deepEqual(await source.load(book, onProgress), expected);
    });
    assert.deepEqual(requests, wholeRequests);
    const {length} = smallEpub.bytes;
    assert.deepEqual(calls[0], [0, length]);
    assert.deepEqual(calls.at(-1), [length, length]);
});


test('standard ebooks source, load default progress', async () => {
    const {fakeFetch} = fakeServer(smallEpub.bytes);
    await withFetch(fakeFetch, async () => {
        assert.deepEqual(await source.load(book), expected);
    });
});


test('standard ebooks source, load unknown length', async () => {
    // A whole download without a Content-Length - the total is unknown
    const {fakeFetch, requests} = fakeServer(smallEpub.bytes, ({method}) => (
        method === 'GET' ? new Response(smallEpub.bytes) : null
    ));
    const {calls, onProgress} = progressRecorder();
    await withFetch(fakeFetch, async () => {
        assert.deepEqual(await source.load(book, onProgress), expected);
    });
    assert.deepEqual(requests, wholeRequests);
    assert.deepEqual(calls[0], [0, null]);
    assert.deepEqual(calls.at(-1), [smallEpub.bytes.length, null]);
});


test('standard ebooks source, load size not a number', async () => {
    const {fakeFetch, requests} = fakeServer(largeEpub.bytes, ({method}) => (
        method === 'HEAD' ? new Response(null, {'headers': {'Content-Length': 'big', 'Content-Type': 'application/epub+zip'}}) : null
    ));
    await withFetch(fakeFetch, async () => {
        assert.deepEqual(await source.load(book), expected);
    });
    assert.deepEqual(requests, wholeRequests);
});


test('standard ebooks source, load ranges', async () => {
    const {bytes, offsets, directoryOffset} = largeEpub;
    const {fakeFetch, requests} = fakeServer(bytes);
    const {calls, onProgress} = progressRecorder();
    await withFetch(fakeFetch, async () => {
        assert.deepEqual(await source.load(book, onProgress), expected);
    });

    // The tail, then the text entries' spans - not the mimetype or the image
    const span1 = [offsets.get('META-INF/container.xml'), offsets.get('epub/images/cover.jpg')];
    const span2 = [offsets.get('epub/text/chapter-1.xhtml'), directoryOffset];
    assert.deepEqual(requests, [
        {'method': 'HEAD', 'range': null},
        {'method': 'GET', 'range': rangeHeader(bytes.length - 65536, bytes.length)},
        {'method': 'GET', 'range': rangeHeader(...span1)},
        {'method': 'GET', 'range': rangeHeader(...span2)}
    ]);

    // Progress over the spans' total size
    const length1 = span1[1] - span1[0];
    const total = length1 + span2[1] - span2[0];
    assert.ok(total < 2000);
    assert.deepEqual(calls, [[0, null], [0, total], [length1, total], [length1, total], [total, total], [total, total]]);
});


test('standard ebooks source, load ranges directory', async () => {
    // A long ZIP comment - the directory is before the tail and is fetched separately
    const {bytes, offsets, directoryOffset} = commentEpub;
    const {fakeFetch, requests} = fakeServer(bytes);
    await withFetch(fakeFetch, async () => {
        assert.deepEqual(await source.load(book), expected);
    });
    const tailStart = bytes.length - 65536;
    assert.ok(directoryOffset < tailStart);
    assert.deepEqual(requests.map(({range}) => range), [
        null,
        rangeHeader(tailStart, bytes.length),
        rangeHeader(directoryOffset, bytes.length - 22 - 65500),
        rangeHeader(offsets.get('META-INF/container.xml'), offsets.get('epub/images/cover.jpg')),
        rangeHeader(offsets.get('epub/text/chapter-1.xhtml'), directoryOffset)
    ]);
});


test('standard ebooks source, load ranges ignored', async () => {
    // The server ignores the range and sends the whole file
    const {bytes} = largeEpub;
    const {fakeFetch, requests} = fakeServer(bytes, ({range}) => (
        range !== null ? new Response(bytes, {'headers': {'Content-Length': String(bytes.length)}}) : null
    ));
    const {calls, onProgress} = progressRecorder();
    await withFetch(fakeFetch, async () => {
        assert.deepEqual(await source.load(book, onProgress), expected);
    });
    assert.deepEqual(requests, [
        {'method': 'HEAD', 'range': null},
        {'method': 'GET', 'range': rangeHeader(bytes.length - 65536, bytes.length)}
    ]);
    assert.deepEqual(calls[0], [0, null]);
    assert.deepEqual(calls[1], [0, bytes.length]);
    assert.deepEqual(calls.at(-1), [bytes.length, bytes.length]);
});


// Test a range-request failure that falls back to downloading the whole file - respond(request, index) returns the
// failing response for the index'th range request (or null)
async function testRangeFallback(epub, respond, rangeCount) {
    let rangeIndex = 0;
    const {fakeFetch, requests} = fakeServer(epub.bytes, (request) => (
        request.range !== null ? respond(request, rangeIndex++) : null
    ));
    await withFetch(fakeFetch, async () => {
        assert.deepEqual(await source.load(book), expected);
    });
    assert.equal(rangeIndex, rangeCount);
    assert.deepEqual(requests.at(-1), {'method': 'GET', 'range': null});
    assert.equal(requests.length, rangeCount + 2);
}


test('standard ebooks source, load ranges tail not satisfiable', async () => {
    await testRangeFallback(largeEpub, () => new Response(null, {'status': 416}), 1);
});


test('standard ebooks source, load ranges tail wrong length', async () => {
    // The body is canceled
    let canceled = false;
    const body = new ReadableStream({
        cancel() {
            canceled = true;
        }
    });
    await testRangeFallback(largeEpub, () => new Response(body, {'status': 206, 'headers': {'Content-Length': '10'}}), 1);
    assert.ok(canceled);
});


test('standard ebooks source, load ranges tail short', async () => {
    // The Content-Length is right, but the body is short
    await testRangeFallback(
        largeEpub, () => new Response(new Uint8Array(100), {'status': 206, 'headers': {'Content-Length': '65536'}}), 1
    );
});


test('standard ebooks source, load ranges tail invalid', async () => {
    // The tail isn't a ZIP's
    await testRangeFallback(
        largeEpub, () => new Response(new Uint8Array(65536), {'status': 206, 'headers': {'Content-Length': '65536'}}), 1
    );
});


test('standard ebooks source, load ranges fetch error', async () => {
    await testRangeFallback(largeEpub, () => {
        throw new TypeError('Failed to fetch');
    }, 1);
});


test('standard ebooks source, load ranges directory fails', async () => {
    await testRangeFallback(commentEpub, (_request, index) => (index === 1 ? new Response(null, {'status': 416}) : null), 2);
});


test('standard ebooks source, load ranges span fails', async () => {
    await testRangeFallback(largeEpub, (_request, index) => (index === 2 ? new Response(null, {'status': 416}) : null), 3);
});


test('standard ebooks source, load no URL', async () => {
    const message = 'This book isn\'t available from Standard Ebooks.';
    await withFetch(() => assert.fail('unexpected fetch'), async () => {
        await assert.rejects(source.load(undefined), {message});
        await assert.rejects(source.load({'id': 'x'}), {message});
        await assert.rejects(source.load({'id': 'x', 'text': {'url': ''}}), {message});
    });
});


test('standard ebooks source, load offline', async () => {
    await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), async () => {
        await assert.rejects(source.load(book), {'message': 'Couldn\'t reach Standard Ebooks. Check your connection and try again.'});
    });
});


test('standard ebooks source, load offline download', async () => {
    const {fakeFetch} = fakeServer(smallEpub.bytes, ({method}) => {
        if (method === 'GET') {
            throw new TypeError('Failed to fetch');
        }
        return null;
    });
    await withFetch(fakeFetch, async () => {
        await assert.rejects(source.load(book), {'message': 'Couldn\'t reach Standard Ebooks. Check your connection and try again.'});
    });
});


test('standard ebooks source, load read error', async () => {
    const body = new ReadableStream({
        pull(controller) {
            controller.error(new Error('connection reset'));
        }
    });
    const {fakeFetch} = fakeServer(smallEpub.bytes, ({method}) => (method === 'GET' ? new Response(body) : null));
    await withFetch(fakeFetch, async () => {
        await assert.rejects(source.load(book), {'message': 'Couldn\'t reach Standard Ebooks. Check your connection and try again.'});
    });
});


test('standard ebooks source, load unavailable', async () => {
    const message = 'This book isn\'t available from Standard Ebooks.';
    const heads = [
        new Response(null, {'status': 404, 'headers': {'Content-Type': 'application/epub+zip'}}),
        new Response('<html></html>', {'headers': {'Content-Type': 'text/html; charset=utf-8'}}),
        new Response(null)
    ];
    for (const head of heads) {
        const {fakeFetch, requests} = fakeServer(smallEpub.bytes, () => head);
        await withFetch(fakeFetch, async () => {
            await assert.rejects(source.load(book), {message});
        });
        assert.deepEqual(requests, [{'method': 'HEAD', 'range': null}]);
    }
});


test('standard ebooks source, load unavailable download', async () => {
    const {fakeFetch, requests} = fakeServer(smallEpub.bytes, ({method}) => (
        method === 'GET' ? new Response('Not found', {'status': 404}) : null
    ));
    await withFetch(fakeFetch, async () => {
        await assert.rejects(source.load(book), {'message': 'This book isn\'t available from Standard Ebooks.'});
    });
    assert.deepEqual(requests, wholeRequests);
});


test('standard ebooks source, load unreadable', async () => {
    const message = 'This book from Standard Ebooks couldn\'t be read.';

    // Not a ZIP
    const notZip = new TextEncoder().encode('This is not a ZIP file.');
    await withFetch(fakeServer(notZip).fakeFetch, async () => {
        await assert.rejects(source.load(book), (error) => {
            assert.equal(error.message, message);
            assert.equal(error.cause.message, 'ZIP end of central directory not found');
            return true;
        });
    });

    // A ZIP that isn't an EPUB
    const notEpub = buildZip([{'name': 'readme.txt', 'data': 'Hello'}]);
    await withFetch(fakeServer(notEpub.bytes).fakeFetch, async () => {
        await assert.rejects(source.load(book), (error) => {
            assert.equal(error.message, message);
            assert.equal(error.cause.message, 'ZIP entry not found: META-INF/container.xml');
            return true;
        });
    });
});
