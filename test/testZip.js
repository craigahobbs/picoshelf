import {openZip, readZipDirectory, readZipEnd, readZipEntry, readZipText, zipEntrySpans, zipTailSize} from '../lib/zip.js';
import {strict as assert} from 'node:assert';
import {deflateRawSync} from 'node:zlib';
import test from 'node:test';


// Write a ZIP file - entries are {name, data, method, extra}: data a string or bytes, method 0 (stored, the default)
// or 8 (deflated), and extra the length of an extra field (local and central) - returns the ZIP's bytes
function writeZip(entries, comment = '') {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
        const method = entry.method ?? 0;
        const compressed = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
        const extra = new Uint8Array(entry.extra ?? 0);

        // Local header
        const local = new Uint8Array(30);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(8, method, true);
        localView.setUint32(18, compressed.length, true);
        localView.setUint32(22, data.length, true);
        localView.setUint16(26, name.length, true);
        localView.setUint16(28, extra.length, true);
        parts.push(local, name, extra, compressed);

        // Central directory header - with an extra field and a comment
        const header = new Uint8Array(46);
        const headerView = new DataView(header.buffer);
        headerView.setUint32(0, 0x02014b50, true);
        headerView.setUint16(10, method, true);
        headerView.setUint32(20, compressed.length, true);
        headerView.setUint32(24, data.length, true);
        headerView.setUint16(28, name.length, true);
        headerView.setUint16(30, extra.length, true);
        headerView.setUint16(32, 1, true);
        headerView.setUint32(42, offset, true);
        central.push(header, name, extra, new Uint8Array(1));
        offset += 30 + name.length + extra.length + compressed.length;
    }
    const directorySize = central.reduce((total, part) => total + part.length, 0);
    const commentBytes = encoder.encode(comment);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, directorySize, true);
    endView.setUint32(16, offset, true);
    endView.setUint16(20, commentBytes.length, true);
    const all = [...parts, ...central, end, commentBytes];
    const bytes = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
    let pos = 0;
    for (const part of all) {
        bytes.set(part, pos);
        pos += part.length;
    }
    return bytes;
}


test('zipTailSize', () => {
    assert.equal(zipTailSize, 65536);
});


test('readZipEnd', () => {
    const zip = writeZip([{'name': 'a.txt', 'data': 'Hello'}]);
    assert.deepEqual(readZipEnd(zip, 0, zip.length), {'offset': 40, 'size': 52, 'count': 1});

    // A tail of the file
    assert.deepEqual(readZipEnd(zip.subarray(30), 30, zip.length), {'offset': 40, 'size': 52, 'count': 1});

    // Not found
    assert.throws(() => readZipEnd(new Uint8Array(100), 0, 100), {'message': 'ZIP end of central directory not found'});
    assert.throws(() => readZipEnd(new Uint8Array(10), 0, 10), {'message': 'ZIP end of central directory not found'});
});


test('readZipEnd, signature in the comment', () => {
    // A comment holding an end record signature whose directory would be past it is skipped
    const fake = new Uint8Array(22);
    const fakeView = new DataView(fake.buffer);
    fakeView.setUint32(0, 0x06054b50, true);
    fakeView.setUint16(10, 7, true);
    fakeView.setUint32(12, 1000, true);
    fakeView.setUint32(16, 1000, true);
    const zip = writeZip([{'name': 'a.txt', 'data': 'Hello'}], 'x'.repeat(22));
    zip.set(fake, zip.length - 22);
    assert.deepEqual(readZipEnd(zip, 0, zip.length), {'offset': 40, 'size': 52, 'count': 1});
});


test('readZipDirectory', () => {
    const zip = writeZip([
        {'name': 'a.txt', 'data': 'Hello'},
        {'name': 'dir/b.txt', 'data': 'Hello, hello, hello', 'method': 8, 'extra': 4}
    ]);
    const end = readZipEnd(zip, 0, zip.length);
    const entries = readZipDirectory(zip.subarray(end.offset, end.offset + end.size), end.count);
    const compressedSize = deflateRawSync('Hello, hello, hello').length;
    assert.deepEqual([...entries.values()], [
        {'name': 'a.txt', 'method': 0, 'compressedSize': 5, 'size': 5, 'offset': 0},
        {'name': 'dir/b.txt', 'method': 8, compressedSize, 'size': 19, 'offset': 40}
    ]);
    assert.deepEqual([...entries.keys()], ['a.txt', 'dir/b.txt']);

    // Invalid
    assert.throws(() => readZipDirectory(new Uint8Array(46), 1), {'message': 'Invalid ZIP central directory'});
    assert.deepEqual(readZipDirectory(new Uint8Array(0), 0), new Map());
});


test('openZip, readZipEntry, and readZipText', async () => {
    const zip = openZip(writeZip([
        {'name': 'stored.txt', 'data': 'Stored text'},
        {'name': 'deflated.txt', 'data': 'Deflated text, deflated text', 'method': 8, 'extra': 2},
        {'name': 'unicode.txt', 'data': 'Æsop’s Fables'},
        {'name': 'empty.txt', 'data': ''}
    ]));
    assert.deepEqual([...zip.entries.keys()], ['stored.txt', 'deflated.txt', 'unicode.txt', 'empty.txt']);
    assert.equal(zip.chunks.length, 1);
    assert.equal(zip.chunks[0].start, 0);
    assert.deepEqual(await readZipEntry(zip, 'stored.txt'), new TextEncoder().encode('Stored text'));
    assert.equal(await readZipText(zip, 'stored.txt'), 'Stored text');
    assert.equal(await readZipText(zip, 'deflated.txt'), 'Deflated text, deflated text');
    assert.ok((await readZipEntry(zip, 'deflated.txt')) instanceof Uint8Array);
    assert.equal(await readZipText(zip, 'unicode.txt'), 'Æsop’s Fables');
    assert.equal(await readZipText(zip, 'empty.txt'), '');
    await assert.rejects(readZipText(zip, 'missing.txt'), {'message': 'ZIP entry not found: missing.txt'});
});


test('openZip, large file', async () => {
    // Larger than the tail - the directory is found in the last zipTailSize bytes
    const big = new Uint8Array(zipTailSize + 1000).fill(65);
    const zip = openZip(writeZip([
        {'name': 'big.txt', 'data': big},
        {'name': 'small.txt', 'data': 'Small', 'method': 8}
    ]));
    assert.equal(zip.entries.get('small.txt').offset, 30 + 7 + big.length);
    assert.deepEqual(await readZipEntry(zip, 'big.txt'), big);
    assert.equal(await readZipText(zip, 'small.txt'), 'Small');
});


test('readZipEntry, chunks', async () => {
    const bytes = writeZip([
        {'name': 'a.txt', 'data': 'First'},
        {'name': 'b.txt', 'data': 'Second'}
    ]);
    const {entries} = openZip(bytes);
    const offsetB = entries.get('b.txt').offset;
    assert.equal(offsetB, 40);

    // Only the second entry downloaded
    const zip = {entries, 'chunks': [{'start': offsetB, 'bytes': bytes.slice(offsetB, offsetB + 41)}]};
    assert.equal(await readZipText(zip, 'b.txt'), 'Second');
    await assert.rejects(readZipEntry(zip, 'a.txt'), {'message': 'ZIP entry not downloaded: a.txt'});

    // A chunk too short for the local header
    const short = {entries, 'chunks': [{'start': 0, 'bytes': bytes.slice(0, 29)}]};
    await assert.rejects(readZipEntry(short, 'a.txt'), {'message': 'ZIP entry not downloaded: a.txt'});

    // Truncated data
    const truncated = {entries, 'chunks': [{'start': 0, 'bytes': bytes.slice(0, 38)}]};
    await assert.rejects(readZipEntry(truncated, 'a.txt'), {'message': 'ZIP entry truncated: a.txt'});

    // Invalid local header
    const invalid = {entries, 'chunks': [{'start': 1, bytes}]};
    await assert.rejects(readZipEntry(invalid, 'b.txt'), {'message': 'Invalid ZIP local header: b.txt'});
});


test('readZipEntry, unsupported method', async () => {
    const bytes = writeZip([{'name': 'a.txt', 'data': 'Hello'}]);
    const zip = openZip(bytes);
    zip.entries.get('a.txt').method = 12;
    await assert.rejects(readZipEntry(zip, 'a.txt'), {'message': 'Unsupported ZIP compression method 12: a.txt'});
});


test('zipEntrySpans', () => {
    const entries = new Map([
        ['c', {'name': 'c', 'offset': 300}],
        ['a', {'name': 'a', 'offset': 0}],
        ['b', {'name': 'b', 'offset': 100}],
        ['d', {'name': 'd', 'offset': 1000}],
        ['e', {'name': 'e', 'offset': 5000}]
    ]);

    // Each needed entry runs to the next entry, or to the directory
    assert.deepEqual(zipEntrySpans(entries, 6000, (name) => name !== 'b', 0), [
        {'start': 0, 'end': 100},
        {'start': 300, 'end': 1000},
        {'start': 1000, 'end': 5000},
        {'start': 5000, 'end': 6000}
    ]);

    // Close spans merged
    assert.deepEqual(zipEntrySpans(entries, 6000, (name) => name !== 'b' && name !== 'd', 250), [
        {'start': 0, 'end': 1000},
        {'start': 5000, 'end': 6000}
    ]);
    assert.deepEqual(zipEntrySpans(entries, 6000, () => true, 1), [{'start': 0, 'end': 6000}]);
    assert.deepEqual(zipEntrySpans(entries, 6000, () => false, 1), []);
    assert.deepEqual(zipEntrySpans(new Map(), 0, () => true, 1), []);
});
