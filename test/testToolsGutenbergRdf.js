import {rdfRecord, tempDir, writeArchive} from './toolsHelpers.js';
import {Buffer} from 'node:buffer';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {strict as assert} from 'node:assert';
import {join} from 'node:path';
import {setImmediate} from 'node:timers';
import test from 'node:test';


// The tools - imported after toolsHelpers.js sets their cache directory
const {parseRecord, readArchive} = await import('../tools/gutenbergrdf.js');


// Frankenstein's record (much as the real one, pg84.rdf) and its result
const frankensteinRecord = rdfRecord(84, {
    'title': 'Frankenstein; or, the modern prometheus',
    'creators': ['Shelley, Mary Wollstonecraft', 'Godwin, William &amp; Sons'],
    'rights': 'Public domain in the USA.',
    'downloads': 144008,
    'descriptions': [
        'Wikipedia page about this book: https://en.wikipedia.org/wiki/Frankenstein',
        'There are improved editions of this title, eBook #41445 (1818 ed.) and #42324 (1831 ed.).'
    ],
    'summaries': [
        '"Frankenstein; Or, The Modern Prometheus" by Mary Wollstonecraft Shelley is a Gothic novel. ' +
            '(This is an automatically generated summary.)',
        '  Another &lt;summary&gt;.  '
    ],
    'languages': ['en'],
    'type': 'Text',
    'subjects': [
        ['LCSH', 'Science fiction'],
        ['LCSH', 'Horror tales'],
        ['LCSH', 'Frankenstein, Victor (Fictitious character) -- Fiction'],
        ['LCC', 'PR']
    ],
    'bookshelves': ['Gothic Fiction', 'Category: Science-Fiction &amp; Fantasy', 'Category: Novels'],
    'files': [
        ['https://www.gutenberg.org/ebooks/84.html.images', 468371, ['text/html']],
        ['https://www.gutenberg.org/files/84/84-h/84-h.htm', 434252, ['text/html']],
        ['https://www.gutenberg.org/ebooks/84.txt.utf-8', 448885, ['text/plain; charset=utf-8']],
        ['https://www.gutenberg.org/files/84/84-0.txt', 421633, ['text/plain; charset=utf-8']],
        ['https://www.gutenberg.org/cache/epub/84/pg84.cover.small.jpg', 3073, ['image/jpeg']],
        ['https://www.gutenberg.org/cache/epub/84/pg84.cover.medium.jpg', 14661, ['image/jpeg']],
        ['https://www.gutenberg.org/cache/epub/84/pg84.txt.zip', 900000, ['text/plain; charset=us-ascii', 'application/zip']],
        ['https://www.gutenberg.org/cache/epub/84/pg84-h.zip', 807365, ['application/octet-stream', 'application/zip']]
    ]
});
const frankenstein = {
    'id': 84,
    'title': 'Frankenstein; or, the modern prometheus',
    'authors': [{'name': 'Shelley, Mary Wollstonecraft'}, {'name': 'Godwin, William & Sons'}],
    'subjects': ['Frankenstein, Victor (Fictitious character) -- Fiction', 'Horror tales', 'Science fiction'],
    'bookshelves': ['Category: Novels', 'Category: Science-Fiction & Fantasy', 'Gothic Fiction'],
    'languages': ['en'],
    'copyright': false,
    'media_type': 'Text',
    'formats': {
        'text/html': 'https://www.gutenberg.org/ebooks/84.html.images',
        'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/84.txt.utf-8',
        'image/jpeg': 'https://www.gutenberg.org/cache/epub/84/pg84.cover.medium.jpg',
        'text/plain; charset=us-ascii': 'https://www.gutenberg.org/cache/epub/84/pg84.txt.zip',
        'application/zip': 'https://www.gutenberg.org/cache/epub/84/pg84.txt.zip',
        'application/octet-stream': 'https://www.gutenberg.org/cache/epub/84/pg84-h.zip'
    },
    'summaries': [
        '"Frankenstein; Or, The Modern Prometheus" by Mary Wollstonecraft Shelley is a Gothic novel. ' +
            '(This is an automatically generated summary.)',
        'Another <summary>.'
    ],
    'download_count': 144008,
    'text_bytes': 448885,
    'wikipedia': 'https://en.wikipedia.org/wiki/Frankenstein'
};


// A record that isn't an ebook's
const workRecord = '<?xml version="1.0" encoding="utf-8"?>\n<rdf:RDF>\n  <cc:Work rdf:about=""/>\n</rdf:RDF>\n';


//
// parseRecord
//


test('parseRecord', () => {
    assert.deepEqual(parseRecord(frankensteinRecord), frankenstein);
});


test('parseRecord, entities', () => {
    const record = parseRecord(rdfRecord(1, {'title': ' Caf&#233; &amp; Th&#xE9;&#xe2;tre &lt;1&gt; &quot;A&quot; &apos;B&apos; &nbsp; '}));
    assert.equal(record.title, 'Café & Théâtre <1> "A" \'B\' &nbsp;');
});


test('parseRecord, rights', () => {
    const copyright = (rights) => parseRecord(rdfRecord(1, {rights})).copyright;
    assert.equal(copyright('Copyrighted. Read the copyright notice inside this book for details.'), true);
    assert.equal(copyright('Public domain in the USA.'), false);
    assert.equal(copyright('None'), null);
    assert.equal(copyright(null), null);
});


test('parseRecord, formats', () => {
    const record = parseRecord(rdfRecord(2, {'files': [
        // The medium cover first - not replaced by another cover
        ['https://www.gutenberg.org/cache/epub/2/pg2.cover.medium.jpg', 100, ['image/jpeg']],
        ['https://www.gutenberg.org/cache/epub/2/pg2.cover.small.jpg', 50, ['image/jpeg']],

        // A text without a size, and a zipped text - no text size
        ['https://www.gutenberg.org/files/2/2.txt', null, ['text/plain']],
        ['https://www.gutenberg.org/files/2/2.zip', 5000, ['text/plain', 'application/zip']]
    ]}));
    assert.deepEqual(record.formats, {
        'image/jpeg': 'https://www.gutenberg.org/cache/epub/2/pg2.cover.medium.jpg',
        'text/plain': 'https://www.gutenberg.org/files/2/2.txt',
        'application/zip': 'https://www.gutenberg.org/files/2/2.zip'
    });
    assert.equal(record.text_bytes, 0);

    // No plain text
    const epubOnly = rdfRecord(3, {'files': [['https://www.gutenberg.org/ebooks/3.epub', 10, ['application/epub+zip']]]});
    assert.equal(parseRecord(epubOnly).text_bytes, null);
});


test('parseRecord, subjects', () => {
    // Only Library of Congress subject headings, sorted - and a heading without a value
    const xml = rdfRecord(4, {'subjects': [['LCSH', 'Whaling'], ['LCC', 'PS'], ['LCSH', '  Sea stories ']]}).replace(
        '  </pgterms:ebook>',
        '    <dcterms:subject><rdf:Description><dcam:memberOf rdf:resource="http://purl.org/dc/terms/LCSH"/></rdf:Description>' +
            '</dcterms:subject>\n  </pgterms:ebook>'
    );
    assert.deepEqual(parseRecord(xml).subjects, ['Sea stories', 'Whaling']);
});


test('parseRecord, empty', () => {
    assert.deepEqual(parseRecord(rdfRecord(5)), {
        'id': 5,
        'title': '',
        'authors': [],
        'subjects': [],
        'bookshelves': [],
        'languages': [],
        'copyright': null,
        'media_type': null,
        'formats': {},
        'summaries': [],
        'download_count': 0,
        'text_bytes': null,
        'wikipedia': null
    });
});


test('parseRecord, wikipedia', () => {
    const wikipedia = (descriptions) => parseRecord(rdfRecord(6, {descriptions})).wikipedia;

    // The Wikipedia link - after another description, and its first
    assert.equal(wikipedia([
        'There are improved editions of this title, eBook #41445.',
        'Wikipedia page about this book: https://en.wikipedia.org/wiki/Walden',
        'Wikipedia page about this book: https://en.wikipedia.org/wiki/Other'
    ]), 'https://en.wikipedia.org/wiki/Walden');

    // Only other descriptions - or a Wikipedia mention that isn't the link
    assert.equal(wikipedia(['There are improved editions of this title, eBook #41445.']), null);
    assert.equal(wikipedia(['See the Wikipedia page about this book: https://en.wikipedia.org/wiki/Walden']), null);
    assert.equal(wikipedia([]), null);
});


test('parseRecord, not an ebook', () => {
    assert.equal(parseRecord(workRecord), null);
    assert.equal(parseRecord(''), null);
});


//
// readArchive
//


test('readArchive', async () => {
    // A large record (its text read in many chunks), a record that isn't an ebook's, and a small record
    const largeRecord = rdfRecord(1342, {'title': 'Pride and prejudice', 'summaries': ['A novel of manners. '.repeat(20000)]});
    const smallRecord = rdfRecord(11, {'title': 'Alice\'s Adventures in Wonderland', 'type': 'Text'});
    const archivePath = join(tempDir, 'readArchive', 'rdf-files.tar.bz2');
    writeArchive(archivePath, [largeRecord, frankensteinRecord, workRecord, smallRecord]);
    const records = await readArchive(archivePath);
    assert.deepEqual(records, [parseRecord(largeRecord), frankenstein, parseRecord(smallRecord)]);
    assert.equal(records[0].summaries[0].length, 'A novel of manners. '.repeat(20000).trim().length);
});


test('readArchive, error', async () => {
    const archivePath = join(tempDir, 'readArchive', 'missing.tar.bz2');
    await assert.rejects(readArchive(archivePath), (error) => {
        assert.match(error.message, /^tar .+missing\.tar\.bz2: tar: \S/);
        return true;
    });
});


// A fake tar process - its output (Buffers), its error text, and its exit code; its spawns' arguments in args
function fakeTar(chunks, errors, code, args = []) {
    return (spawnArgs) => {
        args.push(spawnArgs);
        const tar = new EventEmitter();
        tar.stdout = new PassThrough();
        tar.stderr = new PassThrough();
        for (const chunk of chunks) {
            tar.stdout.write(chunk);
        }
        tar.stdout.end();
        tar.stderr.end(errors);
        setImmediate(() => {
            tar.emit('close', code);
        });
        return tar;
    };
}


test('readArchive, chunks', async () => {
    // The records' text in chunks split inside a record's XML declaration, inside a multi-byte character, and between
    // records - and a chunk of several records
    const first = rdfRecord(1, {'title': 'First'});
    const second = rdfRecord(2, {'title': 'Café'});
    const third = rdfRecord(3, {'title': 'Third'});
    const bytes = Buffer.from(`${first}${second}${workRecord}${third}${first}`);
    const secondStart = Buffer.byteLength(first);
    const accent = bytes.indexOf('é');
    const thirdStart = bytes.indexOf('<?xml', bytes.indexOf('<rdf:RDF>'));
    const splits = [0, 10, secondStart + 3, accent + 1, thirdStart, bytes.length - 20, bytes.length];
    const chunks = splits.slice(1).map((end, ix) => bytes.subarray(splits[ix], end));
    const args = [];
    const records = await readArchive('rdf-files.tar.bz2', fakeTar(chunks, '', 0, args));
    assert.deepEqual(args, [['-xOjf', 'rdf-files.tar.bz2']]);
    assert.deepEqual(records.map((record) => [record.id, record.title]), [[1, 'First'], [2, 'Café'], [3, 'Third'], [1, 'First']]);

    // Nothing
    assert.deepEqual(await readArchive('rdf-files.tar.bz2', fakeTar([], '', 0)), []);
});


test('readArchive, tar errors', async () => {
    await assert.rejects(
        readArchive('bad.tar.bz2', fakeTar([Buffer.from(rdfRecord(1))], 'tar: Damaged archive\n', 1)),
        {'message': 'tar bad.tar.bz2: tar: Damaged archive'}
    );
    await assert.rejects(readArchive('bad.tar.bz2', fakeTar([], '', 2)), {'message': 'tar bad.tar.bz2: exit 2'});
});
