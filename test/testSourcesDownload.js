import {fetchResponse, readBody} from '../lib/sources/download.js';
import test, {mock} from 'node:test';
import {strict as assert} from 'node:assert';


// A response of the chunks (with headers), optionally failing after them
function chunkResponse(chunks, headers = {}, error = null) {
    let ix = 0;
    const body = new ReadableStream({
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
    return new Response(body, {headers});
}


// Read a response's body - {bytes, calls (the progress calls)}
async function readRecorded(response, isLengthKnown = true) {
    const calls = [];
    const bytes = await readBody(response, (loaded, total) => {
        calls.push([loaded, total]);
    }, 'Offline', isLengthKnown);
    return {bytes, calls};
}


test('fetchResponse', async () => {
    const response = new Response('OK');
    const fetchMock = mock.method(globalThis, 'fetch', () => Promise.resolve(response));
    try {
        assert.equal(await fetchResponse('https://example.com/', {'method': 'HEAD'}, 'Offline'), response);
        assert.deepEqual(fetchMock.mock.calls[0].arguments, ['https://example.com/', {'method': 'HEAD'}]);
    } finally {
        fetchMock.mock.restore();
    }
});


test('fetchResponse, network error', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    try {
        await assert.rejects(fetchResponse('https://example.com/', {}, 'Offline'), {'message': 'Offline'});
    } finally {
        fetchMock.mock.restore();
    }
});


test('readBody', async () => {
    const {bytes, calls} = await readRecorded(chunkResponse([Uint8Array.of(1, 2), Uint8Array.of(3)], {'Content-Length': '3'}));
    assert.deepEqual(bytes, Uint8Array.of(1, 2, 3));
    assert.deepEqual(calls, [[0, 3], [2, 3], [3, 3]]);
});


test('readBody, empty', async () => {
    const {bytes, calls} = await readRecorded(chunkResponse([]));
    assert.deepEqual(bytes, new Uint8Array(0));
    assert.deepEqual(calls, [[0, null], [0, 0]]);
});


test('readBody, no length', async () => {
    const {bytes, calls} = await readRecorded(chunkResponse([Uint8Array.of(1, 2), Uint8Array.of(3)]));
    assert.deepEqual(bytes, Uint8Array.of(1, 2, 3));
    assert.deepEqual(calls, [[0, null], [2, null], [3, null], [3, 3]]);
});


test('readBody, length not known', async () => {
    const {calls} = await readRecorded(chunkResponse([Uint8Array.of(1, 2, 3)], {'Content-Length': '3'}), false);
    assert.deepEqual(calls, [[0, null], [3, null], [3, 3]]);
});


test('readBody, length too small', async () => {
    // More bytes than the Content-Length (a compressed response's) - the total becomes unknown
    const {calls} = await readRecorded(chunkResponse([Uint8Array.of(1, 2), Uint8Array.of(3, 4)], {'Content-Length': '3'}));
    assert.deepEqual(calls, [[0, 3], [2, 3], [4, null], [4, 4]]);
});


test('readBody, short', async () => {
    // Fewer bytes than the Content-Length - the total is what was read
    const {bytes, calls} = await readRecorded(chunkResponse([Uint8Array.of(1, 2)], {'Content-Length': '3'}));
    assert.deepEqual(bytes, Uint8Array.of(1, 2));
    assert.deepEqual(calls, [[0, 3], [2, 3], [2, 2]]);
});


test('readBody, read error', async () => {
    const calls = [];
    const response = chunkResponse([Uint8Array.of(1)], {}, new Error('connection reset'));
    await assert.rejects(readBody(response, (loaded, total) => calls.push([loaded, total]), 'Offline'), {'message': 'Offline'});
    assert.deepEqual(calls, [[0, null], [1, null]]);
});
