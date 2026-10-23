import {
    cacheDir, fakeOllama, gutenbergFile, ollamaServer, rdfRecord, resetCache, runTool, tempDir, withSite, writeArchive, writeCache
} from './toolsHelpers.js';
import {existsSync, readFileSync} from 'node:fs';
import {Buffer} from 'node:buffer';
import {strict as assert} from 'node:assert';
import {gzipSync} from 'node:zlib';
import {join} from 'node:path';
import process from 'node:process';
import {setImmediate} from 'node:timers';
import test from 'node:test';


// The tools - imported after toolsHelpers.js sets their cache directory - and the fake Ollama's address
const {
    buildCatalog, chooseGutenberg, gutenbergCandidates, gutenbergRecords, parseHTML, standardEbook, standardEbooks
} = await import('../tools/catalog.js');
const {genreNames} = await import('../tools/genres.js');
const {qualityVersion} = await import('../tools/quality.js');
const {readJSONCache} = await import('../tools/decide.js');
process.env.OLLAMA_HOST = 'http://ollama.test';


// The genre keys
const genreKeys = Object.keys(genreNames());


// A text response function
const text = (body) => () => new Response(body);


//
// Standard Ebooks fixtures
//


const seURL = 'https://standardebooks.org';


// A Standard Ebooks listing page URL
const seListURL = (page) => `${seURL}/ebooks?sort=popularity&per-page=48&page=${page}`;


// A Standard Ebooks listing page - its items' HTML, its page navigation (null for none)
function seListing(items, nav) {
    const navHTML = nav === null ? '' : `<nav class="pagination">${nav}</nav>`;
    return `<!DOCTYPE html><html><body><main><ol>${items.join('')}</ol>${navHTML}</main></body></html>`;
}


// A Standard Ebooks listing item
function seItem(id, title, author, cover = null) {
    return `<li typeof="schema:Book" about="${id}">${cover === null ? '' : `<a href="${id}"><img src="${cover}" alt=""></a>`}` +
        `<p><a href="${id}" property="schema:url"><span property="schema:name">${title}</span></a></p>` +
        `<p class="author"><a href="/ebooks/x"><span property="schema:name">${author}</span></a></p></li>`;
}


// A Standard Ebooks book page
function seBookPage(id, options = {}) {
    const {title = null, subtitle = null, authors = [], meta = {}, description = null, tags = [], downloads = ['.epub']} = options;
    const slug = id.slice('/ebooks/'.length).replace(/\//g, '_');
    const authorsHTML = authors.map(
        (author) => `<p property="schema:author" typeof="schema:Person"><a><span property="schema:name">${author}</span></a></p>`
    ).join('');
    const hgroup = title === null ? '' : `<hgroup><h1 property="schema:name">${title}</h1>` +
        `${subtitle === null ? '' : `<p property="schema:alternativeHeadline">${subtitle}</p>`}${authorsHTML}</hgroup>`;
    const downloadsHTML = downloads.map((suffix) => `<li><a href="${id}/downloads/${slug}${suffix}">Download</a></li>`).join('');
    return `<!DOCTYPE html><html><body><main><article typeof="schema:Book" about="${id}">${hgroup}` +
        `${Object.entries(meta).map(([name, content]) => `<meta property="schema:${name}" content="${content}">`).join('')}` +
        `<aside><ul class="tags">${tags.map((tag) => `<li><a href="/subjects/x">${tag}</a></li>`).join('')}</ul></aside>` +
        `${description === null ? '' : `<section property="schema:description"><h2>Description</h2><p>${description}</p></section>`}` +
        `<section id="download"><ul>${downloadsHTML}</ul></section>` +
        '</article></main></body></html>';
}


// The listing and book page fixtures of Standard Ebooks books - its listing items, and its book pages by URL
const prideId = '/ebooks/jane-austen/pride-and-prejudice';
const pridePage = seBookPage(prideId, {
    'title': 'Pride and  Prejudice',
    'authors': ['Jane Austen'],
    'meta': {'abstract': 'A novel of manners.', 'wordCount': '122000', 'inLanguage': 'en-GB'},
    'tags': ['Fiction', 'Romance', 'fiction'],
    'downloads': ['.kepub.epub', '_advanced.epub', '.epub', '.azw3']
});
const prideBook = {
    'source': 'standardebooks',
    'id': prideId,
    'title': 'Pride and Prejudice',
    'author': 'Jane Austen',
    'description': 'A novel of manners.',
    'subjects': ['Fiction', 'Romance'],
    'language': 'en',
    'cover': 'https://standardebooks.org/images/covers/pride.jpg',
    'rank': 1,
    'words': 122000,
    'text': {'url': `${seURL}${prideId}/downloads/jane-austen_pride-and-prejudice.epub?source=download`, 'format': 'epub'}
};


test('standardEbook', () => {
    const item = {'id': '/ebooks/a/b', 'title': 'Listed', 'authors': ['Listed Author', ''], 'cover': null};
    const book = (html) => standardEbook(item, parseHTML(html));

    // The page's details
    assert.deepEqual(book(seBookPage('/ebooks/a/b', {
        'title': 'Paged', 'subtitle': 'A  Subtitle', 'authors': ['First Author', 'Second Author'], 'meta': {'wordCount': '0'},
        'description': 'The description.', 'downloads': ['_advanced.epub', '.kepub.epub']
    })), {
        'source': 'standardebooks',
        'id': '/ebooks/a/b',
        'title': 'Paged',
        'subtitle': 'A Subtitle',
        'author': 'First Author, Second Author',
        'description': 'The description.',
        'subjects': [],
        'language': 'en',
        'cover': null,
        'rank': 0,
        'words': null,
        'text': {'url': 'https://standardebooks.org/ebooks/a/b/downloads/a_b_advanced.epub?source=download', 'format': 'epub'}
    });

    // The listing's details - no article, no description
    const listed = book('<a href="/ebooks/a/b/downloads/a_b.epub">EPUB</a>');
    assert.equal(listed.title, 'Listed');
    assert.equal(listed.author, 'Listed Author');
    assert.equal(listed.description, '');

    // No EPUB download
    assert.equal(book(seBookPage('/ebooks/a/b', {'downloads': ['.kepub.epub']})), null);
    assert.equal(book(seBookPage('/ebooks/a/b', {'downloads': []})), null);
});


test('standardEbooks', async () => {
    resetCache();
    const site = {
        [seListURL(1)]: text(seListing([
            seItem(prideId, 'Pride and Prejudice', 'Jane Austen', '/images/covers/pride.jpg'),
            seItem('/authors/jane-austen', 'Not a Book', 'Nobody'),
            '<li typeof="schema:Book"><p><span property="schema:name">No Id</span></p></li>',
            seItem(prideId, 'Pride and Prejudice', 'Jane Austen'),
            seItem('/ebooks/anonymous/beowulf/j-lesslie-hall', 'Beowulf', '')
        ], '<a href="?page=1" aria-current="page">1</a><a href="?page=2" rel="next">Next</a>')),
        [seListURL(2)]: text(seListing([
            seItem('/ebooks/x/missing', 'Missing', 'Nobody'),
            `<li typeof="schema:Book" about="/ebooks/x/no-epub"></li>`
        ], '<a href="?page=1">1</a><a href="?page=2" aria-current="page"> 2 </a><a rel="next">Next</a>')),
        [`${seURL}${prideId}`]: text(pridePage),
        [`${seURL}/ebooks/anonymous/beowulf/j-lesslie-hall`]: text(
            '<html><body><section property="schema:description"><p>An  epic.</p></section>' +
            '<a href="/ebooks/anonymous/beowulf/j-lesslie-hall/downloads/beowulf.epub">EPUB</a></body></html>'
        ),
        [`${seURL}/ebooks/x/no-epub`]: text(seBookPage('/ebooks/x/no-epub', {'downloads': []}))
    };
    let books;
    const {calls, output} = await withSite(site, async () => {
        books = await standardEbooks({'standardebooks': Infinity, 'maxAge': 30, 'cacheOnly': false});
    });
    assert.deepEqual(books, [
        prideBook,
        {
            'source': 'standardebooks',
            'id': '/ebooks/anonymous/beowulf/j-lesslie-hall',
            'title': 'Beowulf',
            'author': '',
            'description': 'An epic.',
            'subjects': [],
            'language': 'en',
            'cover': null,
            'rank': 2,
            'words': null,
            'text': {'url': `${seURL}/ebooks/anonymous/beowulf/j-lesslie-hall/downloads/beowulf.epub?source=download`, 'format': 'epub'}
        }
    ]);
    assert.deepEqual(calls.map(([url]) => url), [
        seListURL(1),
        seListURL(2),
        `${seURL}${prideId}`,
        `${seURL}/ebooks/anonymous/beowulf/j-lesslie-hall`,
        `${seURL}/ebooks/x/missing`,
        `${seURL}/ebooks/x/no-epub`
    ]);
    assert.deepEqual(output, [
        'Standard Ebooks: listing page 1 - 2 books',
        'Standard Ebooks: listing page 2 - 4 books',
        '  Standard Ebooks: /ebooks/x/missing - no book page or EPUB download',
        '  Standard Ebooks: /ebooks/x/no-epub - no book page or EPUB download',
        'Standard Ebooks: 2 books (2 without a book page or EPUB)'
    ]);
    assert.equal(readFileSync(join(cacheDir, 'standardebooks', 'book_jane-austen_pride-and-prejudice.html'), 'utf-8'), pridePage);
    assert.ok(existsSync(join(cacheDir, 'standardebooks', 'book_x_missing.html.404')));
});


test('standardEbooks, listing ends', async () => {
    const options = {'standardebooks': Infinity, 'maxAge': 30, 'cacheOnly': false};
    const listing = (nav) => text(seListing([seItem(prideId, 'Pride and Prejudice', 'Jane Austen')], nav));
    const runs = [
        // A page past the end shows the last page
        {
            [seListURL(1)]: listing('<a href="?page=2" rel="next">Next</a>'),
            [seListURL(2)]: listing('<a aria-current="page">1</a>')
        },
        // The next page is missing
        {
            [seListURL(1)]: listing('<a aria-current="page">1</a><a href="?page=2" rel="next">Next</a>')
        },
        // No page navigation - the only page
        {
            [seListURL(1)]: listing(null)
        }
    ];
    const outputs = [];
    for (const site of runs) {
        resetCache();
        const {calls, output} = await withSite(site, async () => {
            await standardEbooks(options);
        });
        outputs.push([calls.length, output[0], output.at(-1)]);
    }
    assert.deepEqual(outputs, [
        [3, 'Standard Ebooks: listing page 1 - 1 books', 'Standard Ebooks: 0 books (1 without a book page or EPUB)'],
        [3, 'Standard Ebooks: listing page 1 - 1 books', 'Standard Ebooks: 0 books (1 without a book page or EPUB)'],
        [2, 'Standard Ebooks: listing page 1 - 1 books', 'Standard Ebooks: 0 books (1 without a book page or EPUB)']
    ]);
});


test('standardEbooks, many', async () => {
    resetCache();
    const ids = Array.from({'length': 101}, (unused, index) => `/ebooks/author/book-${index + 1}`);
    const site = {[seListURL(1)]: text(seListing(ids.map((id, index) => seItem(id, `Book ${index + 1}`, 'An Author')), null))};
    for (const id of ids) {
        site[`${seURL}${id}`] = text(seBookPage(id));
    }

    // At most 100 books
    let books;
    const {output} = await withSite(site, async () => {
        books = await standardEbooks({'standardebooks': 100, 'maxAge': 30, 'cacheOnly': false});
    });
    assert.equal(books.length, 100);
    assert.deepEqual(books.at(-1).rank, 100);
    assert.equal(books.at(-1).title, 'Book 100');
    assert.equal(books.at(-1).author, 'An Author');
    assert.deepEqual(output, [
        'Standard Ebooks: listing page 1 - 100 books',
        'Standard Ebooks: 100 of 100 book pages',
        'Standard Ebooks: 100 books (0 without a book page or EPUB)'
    ]);

    // Cache-only
    const {calls} = await withSite({}, async () => {
        books = await standardEbooks({'standardebooks': Infinity, 'maxAge': 30, 'cacheOnly': true});
    });
    assert.equal(books.length, 100);
    assert.equal(calls.length, 0);
});


//
// Project Gutenberg fixtures
//


const gutenbergCatalogURL = 'https://www.gutenberg.org/cache/epub/feeds/rdf-files.tar.bz2';
const gitenbergListURL = 'https://raw.githubusercontent.com/gitenberg-dev/gitberg/master/gitenberg/data/GITenberg_repo_list.tsv';
const rawURL = (repository, file) => `https://raw.githubusercontent.com/GITenberg/${repository}/master/${file}`;


// A Gutenberg RDF record - an English public-domain text, with a summary, an LCSH subject, a plain text, and a cover
function gutenbergRDF(id, title, author, downloads, more = {}) {
    return rdfRecord(id, {
        title,
        'creators': [author],
        'rights': 'Public domain in the USA.',
        downloads,
        'summaries': [`"${title}" by ${author} is a book about ${title.toLowerCase()}. (This is an automatically generated summary.)`],
        'languages': ['en'],
        'type': 'Text',
        'subjects': [['LCSH', 'Fiction']],
        'files': [
            [`https://www.gutenberg.org/ebooks/${id}.txt.utf-8`, 1000, ['text/plain; charset=utf-8']],
            [`https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`, 100, ['image/jpeg']]
        ],
        ...more
    });
}


// A Gutenberg record (gutenbergRecords's - Gutendex-style)
function gutenbergRecord(id, title, author, downloads) {
    return {
        id,
        title,
        'authors': [{'name': author}],
        'subjects': ['Fiction'],
        'bookshelves': [],
        'languages': ['en'],
        'copyright': false,
        'media_type': 'Text',
        'formats': {
            'text/plain; charset=utf-8': `https://www.gutenberg.org/ebooks/${id}.txt.utf-8`,
            'image/jpeg': `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`
        },
        'summaries': [`"${title}" by ${author} is a book about ${title.toLowerCase()}.`],
        'download_count': downloads,
        'text_bytes': 1000,
        'wikipedia': null
    };
}


// A Gutenberg candidate (gutenbergCandidates's) - neither notable nor a serial
function gutenbergCandidate(id, title, author, downloads, more = {}) {
    return {
        'source': 'gutenberg',
        'id': String(id),
        title,
        author,
        'description': `A book about ${title.toLowerCase()}.`,
        'subjects': ['Fiction'],
        'language': 'en',
        'cover': `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
        downloads,
        'notable': false,
        'serial': false,
        ...more
    };
}


test('gutenbergRecords', async () => {
    resetCache();
    const archivePath = join(tempDir, 'gutenbergRecords', 'rdf-files.tar.bz2');
    writeArchive(archivePath, [
        gutenbergRDF(84, 'Frankenstein', 'Shelley, Mary Wollstonecraft', 100),
        gutenbergRDF(1342, 'Pride and Prejudice', 'Austen, Jane', 200),
        gutenbergRDF(11, 'Alice\'s Adventures in Wonderland', 'Carroll, Lewis', 100),
        gutenbergRDF(5, 'English and French', 'Writer, A', 5, {'languages': ['fr', 'en'], 'rights': 'None'}),

        // Not English public-domain texts
        gutenbergRDF(6, 'A Recording', 'Writer, A', 1000, {'type': 'Sound'}),
        gutenbergRDF(7, 'Un Livre', 'Writer, A', 1000, {'languages': ['fr']}),
        gutenbergRDF(8, 'Copyrighted', 'Writer, A', 1000, {'rights': 'Copyrighted. Read the copyright notice inside this book.'}),
        gutenbergRDF(9, 'No Plain Text', 'Writer, A', 1000, {
            'files': [['https://www.gutenberg.org/ebooks/9.epub3.images', 10, ['application/epub+zip']]]
        })
    ]);
    const archive = readFileSync(archivePath);
    let records;
    let {calls, output} = await withSite({[gutenbergCatalogURL]: () => new Response(archive)}, async () => {
        records = await gutenbergRecords({'maxAge': 30, 'cacheOnly': false});
    });
    assert.deepEqual(records.map((record) => [record.id, record.title, record.download_count]), [
        [1342, 'Pride and Prejudice', 200],
        [11, 'Alice\'s Adventures in Wonderland', 100],
        [84, 'Frankenstein', 100],
        [5, 'English and French', 5]
    ]);
    assert.deepEqual(records[2].authors, [{'name': 'Shelley, Mary Wollstonecraft'}]);
    assert.equal(records[3].copyright, null);
    assert.deepEqual(calls.map(([url]) => url), [gutenbergCatalogURL]);
    assert.deepEqual(output, ['Gutenberg: 4 English texts in its catalog']);
    assert.deepEqual(readFileSync(join(cacheDir, 'gutenberg', 'rdf-files.tar.bz2')), archive);

    // Not cached, cache-only
    resetCache();
    ({calls, output} = await withSite({}, async () => {
        records = await gutenbergRecords({'maxAge': 30, 'cacheOnly': true});
    }));
    assert.deepEqual(records, []);
    assert.deepEqual(calls, []);
    assert.deepEqual(output, ['Gutenberg: no cached catalog']);
});


test('gutenbergCandidates', async () => {
    const prideSE = '/ebooks/jane-austen/pride-and-prejudice';
    const eyreSE = '/ebooks/charlotte-bronte/jane-eyre';
    const records = [
        gutenbergRecord(1001, 'A Dictionary of the English Language', 'Johnson, Samuel', 900),
        gutenbergRecord(1342, 'Pride and Prejudice', 'Austen, Jane', 800),
        {...gutenbergRecord(84, 'Frankenstein; Or, The Modern Prometheus', 'Shelley, Mary Wollstonecraft', 700),
            'wikipedia': 'https://en.wikipedia.org/wiki/Frankenstein'},
        gutenbergRecord(41445, 'Frankenstein; or, the modern prometheus', 'Shelley, Mary Wollstonecraft', 600),
        // (a Standard Ebooks book's edition that isn't in GITenberg - a duplicate, its downloads counted)
        gutenbergRecord(42671, 'Pride and Prejudice', 'Austen, Jane', 550),
        gutenbergRecord(60000, 'Not in GITenberg', 'Writer, A', 500),
        {
            ...gutenbergRecord(11, 'Anonymous', 'Writer, A', 400),
            'authors': [], 'summaries': [], 'formats': {'text/plain': 'https://www.gutenberg.org/ebooks/11.txt'},
            'bookshelves': ['Category: Novels']
        },
        gutenbergRecord(13, 'The History of England, Vol. 2 (of 6)', 'Hume, David', 300),
        {...gutenbergRecord(2701, 'Moby Dick', 'Melville, Herman', 250), 'bookshelves': ['Best Books Ever Listings']},
        gutenbergRecord(12, 'Past the Candidates', 'Writer, A', 200),
        // (a Standard Ebooks book's edition past the candidates - its downloads counted, not its duplicate)
        gutenbergRecord(1260, 'Jane Eyre: An Autobiography', 'Brontë, Charlotte', 150)
    ];
    const repositories = new Map([1001, 1342, 84, 41445, 11, 13, 2701, 12, 1260].map((id) => [String(id), `Book_${id}`]));
    const seBooks = [
        {'id': prideSE, 'title': 'Pride and Prejudice', 'author': 'Jane Austen'},
        {'id': eyreSE, 'title': 'Jane Eyre', 'author': 'Charlotte Brontë'},
        {'id': '/ebooks/henry-david-thoreau/walden', 'title': 'Walden', 'author': 'Henry David Thoreau'}
    ];
    let result;
    const {output} = await withSite({}, () => {
        result = gutenbergCandidates(records, seBooks, repositories, {'gutenberg': 4});
    });
    assert.deepEqual(result.candidates, [
        gutenbergCandidate(84, 'Frankenstein', 'Mary Wollstonecraft Shelley', 700, {
            'subtitle': 'Or, The Modern Prometheus',
            'description': 'A book about frankenstein; or, the modern prometheus.',
            'notable': true
        }),
        gutenbergCandidate(11, 'Anonymous', '', 400, {'description': '', 'subjects': ['Fiction', 'Novels'], 'cover': null}),
        gutenbergCandidate(13, 'The History of England, Vol. 2 (of 6)', 'David Hume', 300, {
            'description': 'A book about the history of england, vol. 2 (of 6).',
            'serial': true
        }),
        gutenbergCandidate(2701, 'Moby Dick', 'Herman Melville', 250, {'notable': true})
    ]);

    // The Standard Ebooks books' downloads - their editions' summed (Walden has none)
    assert.deepEqual(result.seDownloads, new Map([[prideSE, 1350], [eyreSE, 150]]));
    assert.deepEqual(output, [
        'Gutenberg: 4 candidates (1 not in GITenberg, 2 Standard Ebooks duplicates, 1 duplicate editions, 1 reference works)'
    ]);
});


// The fake Ollama's genres for the books - by "source|id"
function bookGenreKeys(books, genre) {
    return Object.fromEntries(books.map((book) => [`${book.source}|${book.id}`, [genre(book), 'adventure']]));
}


test('chooseGutenberg', async () => {
    resetCache();

    // Two Standard Ebooks books - general fiction
    const seBooks = [{'source': 'standardebooks', 'id': '/ebooks/a/one'}, {'source': 'standardebooks', 'id': '/ebooks/a/two'}];

    // Thirty general fiction candidates (ids 101-130, 150 downloads each) and fifty mysteries (ids 201-250, 10 downloads
    // each) - the genres' downloads 9 to 1, so their quotas are 75 and 25 of the catalog's 100 (the mysteries' the floor,
    // 40), and every other genre's the floor
    const fiction = Array.from({'length': 30}, (unused, ix) => gutenbergCandidate(101 + ix, `Fiction ${ix + 1}`, 'A Writer', 150));
    const mysteries = Array.from({'length': 50}, (unused, ix) => gutenbergCandidate(201 + ix, `Mystery ${ix + 1}`, 'A Writer', 10));
    const candidates = [...fiction, ...mysteries];
    const genres = bookGenreKeys([...seBooks, ...candidates], (book) => (book.id.startsWith('2') ? 'mystery' : 'fiction'));
    const repositories = new Map(candidates.map((book) => [book.id, `Book_${book.id}`]));

    // The texts - most pass; general fiction's 103 (notes) and 110 and 120 (too short), and mystery's 205 (notes) and 245
    // (no text file) fail - and 101's measure is cached
    writeCache('gitenberg/quality.json', JSON.stringify({
        '101': {'version': qualityVersion, 'file': '101.txt', 'encoding': 'windows-1252', 'words': 1234, 'reason': null}
    }));
    const failing = {
        '103': gutenbergFile('[See the note.] '.repeat(20).trim()),
        '110': 'A short text.',
        '120': 'Another short text.',
        '205': gutenbergFile('[See the note.] '.repeat(20).trim())
    };
    let active = 0;
    let mostActive = 0;
    const site = (url) => {
        const [, id, file] = /\/Book_(\d+)\/master\/(\d+(?:-\d)?\.txt)$/.exec(url);
        if (id === '245' || file !== `${id}-0.txt`) {
            return new Response('Not Found', {'status': 404});
        }
        active++;
        mostActive = Math.max(mostActive, active);
        return new Promise((resolve) => {
            setImmediate(() => {
                active--;
                resolve(new Response(failing[id] ?? gutenbergFile()));
            });
        });
    };
    let books;
    const {calls, output} = await withSite(site, async () => {
        const options = {'books': 100, 'popular': 0, 'maxAge': 30, 'cacheOnly': false};
        books = await chooseGutenberg(seBooks, candidates, genres, repositories, options);
    });

    // The books - general fiction's 27 passing texts and 48 mysteries' (none notable, so the genres' quotas take none and
    // the catalog's room takes every candidate that passes), most downloaded first - with their downloads (rankBooks
    // ranks them), without their notable and serial flags
    const chosen = [
        ...fiction.filter((book) => !['103', '110', '120'].includes(book.id)),
        ...mysteries.filter((book) => !['205', '245'].includes(book.id))
    ];
    assert.deepEqual(books.map((book) => book.id), chosen.map((book) => book.id));
    assert.deepEqual(books.map((book) => book.downloads), chosen.map((book) => book.downloads));
    const [{notable, serial, ...first}] = fiction;
    assert.deepEqual([notable, serial], [false, false]);
    assert.deepEqual(books[0], {
        ...first,
        'words': 1234,
        'text': {'url': rawURL('Book_101', '101.txt'), 'format': 'gutenberg-text', 'encoding': 'windows-1252'}
    });
    assert.deepEqual(books[1].words, 740);
    assert.deepEqual(books[1].text, {'url': rawURL('Book_102', '102-0.txt'), 'format': 'gutenberg-text', 'encoding': 'utf-8'});

    // Each text checked once - at most eight at once
    const textURLs = calls.map(([url]) => url).filter((url) => url.endsWith('-0.txt'));
    assert.equal(textURLs.length, 79);
    assert.equal(new Set(textURLs).size, 79);
    assert.equal(mostActive, 8);
    assert.deepEqual(calls.map(([url]) => url).filter((url) => url.includes('/Book_245/')), [
        rawURL('Book_245', '245-0.txt'), rawURL('Book_245', '245.txt'), rawURL('Book_245', '245-8.txt')
    ]);

    // The texts' measures are cached
    const textCache = readJSONCache('gitenberg/quality.json');
    assert.equal(Object.keys(textCache).length, 80);
    assert.deepEqual(
        textCache['110'], {'version': qualityVersion, 'file': '110-0.txt', 'encoding': 'utf-8', 'words': 8, 'reason': 'too short'}
    );

    // Each genre's coverage - the reasons by count
    const coverage = {
        'fiction': '  fiction: 29 books of 75 - 2 Standard Ebooks, 27 Gutenberg of 30 tried (2 too short, 1 notes)',
        'mystery': '  mystery: 48 books of 40 - 0 Standard Ebooks, 48 Gutenberg of 50 tried (1 notes, 1 no text file)'
    };
    assert.deepEqual(output, [
        'Gutenberg: 0 popular books (of the top 0 candidates)',
        ...genreKeys.map((genre) => coverage[genre] ?? `  ${genre}: 0 books of 40 - 0 Standard Ebooks, 0 Gutenberg of 0 tried`)
    ]);
});


test('chooseGutenberg, notable books first, no serials', async () => {
    resetCache();

    // Forty-one Standard Ebooks mysteries - more than the mysteries' quota, so its notable candidate is left to the
    // catalog's room
    const seBooks = Array.from({'length': 41}, (unused, ix) => ({'source': 'standardebooks', 'id': `/ebooks/a/mystery-${ix + 1}`}));

    // The candidates, most downloaded first - a serial (the most popular), a notable serial, five general fiction books,
    // three notable general fiction books (fewer downloads), and a notable mystery (the fewest)
    const candidates = [
        gutenbergCandidate(501, 'Fiction, Vol. 2', 'A Writer', 1000, {'serial': true}),
        gutenbergCandidate(502, 'Notable Fiction, Vol. 2', 'A Writer', 900, {'notable': true, 'serial': true}),
        ...Array.from({'length': 5}, (unused, ix) => gutenbergCandidate(601 + ix, `Fiction ${ix + 1}`, 'A Writer', 500)),
        ...[30, 20, 10].map((downloads, ix) => gutenbergCandidate(701 + ix, `Notable ${ix + 1}`, 'A Writer', downloads, {'notable': true})),
        gutenbergCandidate(801, 'Notable Mystery', 'A Writer', 5, {'notable': true})
    ];
    const isMystery = (book) => book.id.includes('mystery') || book.id === '801';
    const genres = bookGenreKeys([...seBooks, ...candidates], (book) => (isMystery(book) ? 'mystery' : 'fiction'));
    const repositories = new Map(candidates.map((book) => [book.id, `Book_${book.id}`]));
    let books;
    const {calls, output} = await withSite(() => new Response(gutenbergFile()), async () => {
        const options = {'books': 47, 'popular': 1, 'maxAge': 30, 'cacheOnly': false};
        books = await chooseGutenberg(seBooks, candidates, genres, repositories, options);
    });

    // The popular serial; general fiction's quota of 40 takes only its notable books, by downloads - not the notable
    // serial; and the catalog's room of 2 takes the notable mystery before the most downloaded general fiction book
    assert.deepEqual(calls.map(([url]) => url), [
        rawURL('Book_501', '501-0.txt'),
        rawURL('Book_701', '701-0.txt'), rawURL('Book_702', '702-0.txt'), rawURL('Book_703', '703-0.txt'),
        rawURL('Book_801', '801-0.txt'), rawURL('Book_601', '601-0.txt')
    ]);
    assert.deepEqual(books.map((book) => [book.id, book.downloads]), [
        ['501', 1000], ['601', 500], ['701', 30], ['702', 20], ['703', 10], ['801', 5]
    ]);
    assert.deepEqual(Object.keys(books[0]), [
        'source', 'id', 'title', 'author', 'description', 'subjects', 'language', 'cover', 'downloads', 'words', 'text'
    ]);
    const coverage = {
        'fiction': '  fiction: 5 books of 40 - 0 Standard Ebooks, 5 Gutenberg of 5 tried',
        'mystery': '  mystery: 42 books of 41 - 41 Standard Ebooks, 1 Gutenberg of 1 tried'
    };
    assert.deepEqual(output, [
        'Gutenberg: 1 popular books (of the top 1 candidates)',
        ...genreKeys.map((genre) => coverage[genre] ?? `  ${genre}: 0 books of 40 - 0 Standard Ebooks, 0 Gutenberg of 0 tried`)
    ]);
});


test('chooseGutenberg, the most popular first', async () => {
    resetCache();

    // Ten general fiction candidates (ids 301-310, the most downloaded) and sixty mysteries (ids 401-460)
    const fiction = Array.from({'length': 10}, (unused, ix) => gutenbergCandidate(301 + ix, `Fiction ${ix + 1}`, 'A Writer', 1000));
    const mysteries = Array.from({'length': 60}, (unused, ix) => gutenbergCandidate(401 + ix, `Mystery ${ix + 1}`, 'A Writer', 1));
    const candidates = [...fiction, ...mysteries];
    const genres = bookGenreKeys(candidates, (book) => (book.id.startsWith('3') ? 'fiction' : 'mystery'));
    const repositories = new Map(candidates.map((book) => [book.id, `Book_${book.id}`]));
    // (each text the UTF-8 file, the first tried)
    const site = () => new Response(gutenbergFile());

    // The top three first - checked before any genre's, then the genres' quotas
    let books;
    const first = await withSite(site, async () => {
        books = await chooseGutenberg([], candidates, genres, repositories, {'books': 200, 'popular': 3, 'maxAge': 30, 'cacheOnly': false});
    });
    const {calls} = first;
    let {output} = first;
    assert.deepEqual(calls.slice(0, 3).map(([url]) => url), [
        rawURL('Book_301', '301-0.txt'), rawURL('Book_302', '302-0.txt'), rawURL('Book_303', '303-0.txt')
    ]);
    assert.equal(output[0], 'Gutenberg: 3 popular books (of the top 3 candidates)');
    assert.equal(books.length, 70);

    // No more popular books than the catalog has room for
    resetCache();
    ({output} = await withSite(site, async () => {
        const options = {'books': 2, 'popular': 1000, 'maxAge': 30, 'cacheOnly': false};
        books = await chooseGutenberg([], candidates, genres, repositories, options);
    }));
    assert.equal(output[0], 'Gutenberg: 2 popular books (of the top 2 candidates)');
    assert.deepEqual(books.slice(0, 2).map((book) => book.id), ['301', '302']);
});


test('chooseGutenberg, cache-only', async () => {
    resetCache();

    // 201 general fiction candidates - 200 of their texts measured, the last not downloaded
    const candidates = Array.from({'length': 201}, (unused, ix) => gutenbergCandidate(ix + 1, `Book ${ix + 1}`, 'A Writer', 1));
    const genres = bookGenreKeys(candidates, () => 'fiction');
    const repositories = new Map(candidates.map((book) => [book.id, `Book_${book.id}`]));
    const textCache = Object.fromEntries(candidates.slice(0, 200).map((book) => [
        book.id, {'version': qualityVersion, 'file': `${book.id}-0.txt`, 'encoding': 'utf-8', 'words': 1000, 'reason': null}
    ]));
    writeCache('gitenberg/quality.json', JSON.stringify(textCache));
    let books;
    const {calls, output} = await withSite({}, async () => {
        books = await chooseGutenberg([], candidates, genres, repositories, {'books': 300, 'popular': 0, 'maxAge': 30, 'cacheOnly': true});
    });
    assert.equal(books.length, 200);
    assert.deepEqual(books.at(-1).text, {'url': rawURL('Book_200', '200-0.txt'), 'format': 'gutenberg-text', 'encoding': 'utf-8'});
    assert.deepEqual(calls, []);
    assert.deepEqual(output.slice(0, 2), ['Gutenberg: 0 popular books (of the top 0 candidates)', 'Gutenberg: 200 texts checked']);
    assert.equal(
        output[genreKeys.indexOf('fiction') + 2],
        '  fiction: 200 books of 300 - 0 Standard Ebooks, 200 Gutenberg of 201 tried (1 not downloaded)'
    );
    assert.deepEqual(readJSONCache('gitenberg/quality.json'), textCache);
});


//
// The catalog
//


// The fake Ollama - each book's voice helen, and its genres the second and first
const ollama = fakeOllama((name) => ({
    'voice': {'helen': 0.9, 'sarah': 0.1},
    'genre': {[genreKeys[1]]: 0.7, [genreKeys[0]]: 0.3}
})[name]);


// Gutenberg's catalog - Frankenstein (notable - its UTF-8 text passes), Pride and Prejudice (a Standard Ebooks book's
// edition - its downloads rank the Standard Ebooks book), Moby Dick (its text is too short), and A Tale of Two Cities
// (its plain text is Windows-1252)
const catalogRecords = [
    gutenbergRDF(1342, 'Pride and Prejudice', 'Austen, Jane', 450),
    gutenbergRDF(84, 'Frankenstein; or, the modern prometheus', 'Shelley, Mary Wollstonecraft', 500, {
        'descriptions': [
            'Wikipedia page about this book: https://en.wikipedia.org/wiki/Frankenstein',
            'There are improved editions of this title, eBook #41445 (1818 ed.) and #42324 (1831 ed.).'
        ]
    }),
    gutenbergRDF(2701, 'Moby Dick; Or, The Whale', 'Melville, Herman', 400),
    gutenbergRDF(98, 'A Tale of Two Cities', 'Dickens, Charles', 300)
];
const gitenbergList = 'gutenberg_id\trepo_name\n84\tFrankenstein_84\n1342\tPride-and-Prejudice_1342\n2701\tMoby-Dick_2701\n' +
    '98\tA-Tale-of-Two-Cities_98\n';
const frankensteinBook = {
    'source': 'gutenberg',
    'id': '84',
    'title': 'Frankenstein',
    'subtitle': 'Or, the Modern Prometheus',
    'author': 'Mary Wollstonecraft Shelley',
    'description': 'A book about frankenstein; or, the modern prometheus.',
    'subjects': ['Fiction'],
    'language': 'en',
    'cover': 'https://www.gutenberg.org/cache/epub/84/pg84.cover.medium.jpg',
    'rank': 1,
    'words': 740,
    'text': {'url': rawURL('Frankenstein_84', '84-0.txt'), 'format': 'gutenberg-text', 'encoding': 'utf-8'}
};


test('buildCatalog', async () => {
    resetCache();
    const archivePath = join(tempDir, 'buildCatalog', 'rdf-files.tar.bz2');
    writeArchive(archivePath, catalogRecords);
    const output = join(tempDir, 'out', 'catalog.json');
    const site = {
        [seListURL(1)]: text(seListing([seItem(prideId, 'Pride and Prejudice', 'Jane Austen', '/images/covers/pride.jpg')], null)),
        [`${seURL}${prideId}`]: text(pridePage),
        [gutenbergCatalogURL]: () => new Response(readFileSync(archivePath)),
        [gitenbergListURL]: text(gitenbergList),
        [rawURL('Frankenstein_84', '84-0.txt')]: text(gutenbergFile()),
        [rawURL('Moby-Dick_2701', '2701-0.txt')]: text('A short text.'),
        [rawURL('A-Tale-of-Two-Cities_98', '98.txt')]: text(Buffer.from(gutenbergFile('Café crème.'), 'latin1')),
        'http://ollama.test/api/show': (options) => ollama('/api/show', JSON.parse(options.body)),
        'http://ollama.test/v1/systemone': (options) => ollama('/v1/systemone', JSON.parse(options.body))
    };
    const options = {
        'books': 10, 'popular': 0, 'gutenberg': 10, 'standardebooks': Infinity, 'maxAge': 30, 'pageMaxAge': 365, 'cacheOnly': false, output,
        'voiceModel': 'test:1b'
    };
    const {calls, output: lines} = await withSite(site, async () => {
        await buildCatalog(options);
    });
    const catalog = JSON.parse(readFileSync(output, 'utf-8'));
    assert.equal(catalog.version, 1);
    assert.match(catalog.generated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(Object.keys(catalog.sources), ['standardebooks', 'gutenberg']);
    assert.deepEqual(catalog.genres, genreNames());
    // The books ranked by their Gutenberg downloads - Frankenstein's 500, Pride and Prejudice's edition's 450, and A Tale
    // of Two Cities' 300
    const bookGenres = [genreKeys[1], genreKeys[0]];
    assert.deepEqual(catalog.books, [
        {...frankensteinBook, 'voice': 'helen', 'genres': bookGenres},
        {...prideBook, 'rank': 2, 'voice': 'helen', 'genres': bookGenres},
        {
            'source': 'gutenberg',
            'id': '98',
            'title': 'A Tale of Two Cities',
            'author': 'Charles Dickens',
            'description': 'A book about a tale of two cities.',
            'subjects': ['Fiction'],
            'language': 'en',
            'cover': 'https://www.gutenberg.org/cache/epub/98/pg98.cover.medium.jpg',
            'rank': 3,
            'words': 742,
            'text': {'url': rawURL('A-Tale-of-Two-Cities_98', '98.txt'), 'format': 'gutenberg-text', 'encoding': 'windows-1252'},
            'voice': 'helen',
            'genres': bookGenres
        }
    ]);

    // The genres decided for every book and candidate, and the voices cast for the catalog's books
    const systemone = calls.filter(([url]) => url === 'http://ollama.test/v1/systemone').map(([, request]) => JSON.parse(request.body));
    assert.deepEqual(systemone.map((request) => [request.state.title, Object.keys(request.questions)]), [
        ['Pride and Prejudice', ['genre']],
        ['Frankenstein: Or, the Modern Prometheus', ['genre']],
        ['Moby Dick: Or, The Whale', ['genre']],
        ['A Tale of Two Cities', ['genre']],
        ['Frankenstein: Or, the Modern Prometheus', ['voice']],
        ['Pride and Prejudice', ['voice']],
        ['A Tale of Two Cities', ['voice']]
    ]);
    assert.equal(systemone[0].model, 'test:1b');
    assert.deepEqual(systemone[0].state, {
        'title': 'Pride and Prejudice', 'author': 'Jane Austen', 'subjects': 'Fiction, Romance', 'description': 'A novel of manners.'
    });
    assert.deepEqual(calls.filter(([url]) => url.includes('/GITenberg/')).map(([url]) => url), [
        rawURL('Frankenstein_84', '84-0.txt'),
        rawURL('Moby-Dick_2701', '2701-0.txt'),
        rawURL('A-Tale-of-Two-Cities_98', '98-0.txt'),
        rawURL('A-Tale-of-Two-Cities_98', '98.txt')
    ]);
    assert.deepEqual(lines.filter((line) => /^(?:Gutenberg| {2}biography)/.test(line)), [
        'Gutenberg: 4 English texts in its catalog',
        'Gutenberg: 3 candidates (0 not in GITenberg, 1 Standard Ebooks duplicates, 0 duplicate editions, 0 reference works)',
        'Gutenberg: 0 popular books (of the top 0 candidates)',
        '  biography: 3 books of 40 - 1 Standard Ebooks, 2 Gutenberg of 3 tried (1 too short)'
    ]);
    assert.match(lines.at(-1), /catalog\.json: 1 Standard Ebooks and 2 Gutenberg books, \d+ bytes$/);

    // No Gutenberg books - the decisions cached
    const {calls: noGutenbergCalls} = await withSite(site, async () => {
        await buildCatalog({...options, 'gutenberg': 0});
    });
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf-8')).books.map((book) => book.id), [prideId]);
    assert.deepEqual(noGutenbergCalls.map(([url]) => url), ['http://ollama.test/api/show', 'http://ollama.test/api/show']);
});


//
// The command line
//


test('catalog.js, command line', async () => {
    // The cache - a Standard Ebooks book, Gutenberg's catalog, the GITenberg list, and Frankenstein's text (measured
    // with older rules); A Tale of Two Cities' text isn't cached
    resetCache();
    writeCache(
        'standardebooks/list-1.html',
        seListing([seItem(prideId, 'Pride and Prejudice', 'Jane Austen', '/images/covers/pride.jpg')], null)
    );
    writeCache('standardebooks/book_jane-austen_pride-and-prejudice.html', pridePage);
    writeArchive(join(cacheDir, 'gutenberg', 'rdf-files.tar.bz2'), catalogRecords);
    writeCache('gitenberg/GITenberg_repo_list.tsv', gitenbergList);
    writeCache('gitenberg/texts/84.txt.gz', gzipSync(gutenbergFile()));
    writeCache('gitenberg/quality.json', JSON.stringify({
        '84': {'version': qualityVersion - 1, 'file': '84-0.txt', 'encoding': 'utf-8', 'words': 0, 'reason': 'old'},
        '2701': {'version': qualityVersion, 'file': '2701-0.txt', 'encoding': 'utf-8', 'words': 8, 'reason': 'too short'}
    }));

    // The fake Ollama
    const server = await ollamaServer(ollama);
    const output = join(tempDir, 'cli', 'catalog.json');
    let result;
    try {
        result = await runTool(
            'catalog', ['--cache-only', '--books', '5', '--voice-model', 'test:1b', '-o', output], {'OLLAMA_HOST': server.host}
        );
    } finally {
        await server.close();
    }
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
    const lines = result.stdout.trimEnd().split('\n').map((line) => line.replace(/^\[\d+:\d\d\] /, ''));
    assert.deepEqual(lines.filter((line) => /^(?:Standard Ebooks|Gutenberg| {2}biography)/.test(line)), [
        'Standard Ebooks: listing page 1 - 1 books',
        'Standard Ebooks: 1 books (0 without a book page or EPUB)',
        'Gutenberg: 4 English texts in its catalog',
        'Gutenberg: 3 candidates (0 not in GITenberg, 1 Standard Ebooks duplicates, 0 duplicate editions, 0 reference works)',
        // (the default 1,000 popular - the three candidates, the catalog's room for four)
        'Gutenberg: 1 popular books (of the top 3 candidates)',
        '  biography: 2 books of 40 - 1 Standard Ebooks, 1 Gutenberg of 3 tried (1 too short, 1 not downloaded)'
    ]);
    assert.match(lines.at(-1), /catalog\.json: 1 Standard Ebooks and 1 Gutenberg books, \d+ bytes$/);
    const catalog = JSON.parse(readFileSync(output, 'utf-8'));
    assert.deepEqual(catalog.books.map((book) => [book.id, book.title, book.author, book.rank, book.words, book.voice]), [
        ['84', 'Frankenstein', 'Mary Wollstonecraft Shelley', 1, 740, 'helen'],
        [prideId, 'Pride and Prejudice', 'Jane Austen', 2, 122000, 'helen']
    ]);
    assert.deepEqual(
        server.requests.map(([, url]) => url),
        ['/api/show', '/v1/systemone', '/v1/systemone', '/v1/systemone', '/v1/systemone', '/api/show', '/v1/systemone', '/v1/systemone']
    );

    // Frankenstein's text measured again
    assert.deepEqual(
        readJSONCache('gitenberg/quality.json')['84'],
        {'version': qualityVersion, 'file': '84-0.txt', 'encoding': 'utf-8', 'words': 740, 'reason': null}
    );
});


test('catalog.js, command line error', async () => {
    assert.deepEqual(await runTool('catalog', ['--bogus']), {'code': 1, 'stdout': '', 'stderr': 'error: Unknown argument "--bogus"\n'});
});
