import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import test, {after, mock} from 'node:test';
import {strict as assert} from 'node:assert';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import os from 'node:os';
import process from 'node:process';
import {promisify} from 'node:util';


// The catalog builder's cache, a temporary directory - set before the builder (tools/decide.js) is imported - and the
// fake Ollama's address
const tempDir = mkdtempSync(join(os.tmpdir(), 'picoshelf-catalog-build-'));
const cacheDir = join(tempDir, 'cache');
process.env.PICOSHELF_CACHE = cacheDir;
process.env.OLLAMA_HOST = 'http://ollama.test';
const {buildCatalog, gutenbergBooks, gutendexBooks, parseHTML, services, standardEbook, standardEbooks} =
    await import('../tools/catalog.js');
const {genreNames} = await import('../tools/genres.js');
after(() => {
    rmSync(tempDir, {'recursive': true, 'force': true});
});


// The command line tool
const catalogPath = fileURLToPath(new URL('../tools/catalog.js', import.meta.url));


// Empty the cache directory
function resetCache() {
    rmSync(cacheDir, {'recursive': true, 'force': true});
    mkdirSync(cacheDir, {'recursive': true});
}


// Write a cache file
function writeCache(name, text) {
    mkdirSync(join(cacheDir, name, '..'), {'recursive': true});
    writeFileSync(join(cacheDir, name), text);
}


// The fake clock - it moves only forward, so the builder's per-host throttle times stay in order across tests
let clock = Date.now();


// Run a test function with a fake site (a map of URL to response function, other URLs 404), a fake clock that a fake
// sleep advances, and captured output - returns the fetch calls ([url, options]) and the output lines
async function withSite(site, fn) {
    clock = Math.ceil(clock / 1000) * 1000 + 3600000;
    const fetchMock = mock.method(globalThis, 'fetch', (url, options) => Promise.resolve().then(
        () => (url in site ? site[url](options) : new Response('Not Found', {'status': 404}))
    ));
    const nowMock = mock.method(Date, 'now', () => clock);
    const sleepMock = mock.method(services, 'sleep', (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
    });
    const output = [];
    const writeMock = mock.method(services, 'write', (text) => {
        output.push(text.replace(/^\[\d+:\d\d\] /, '').replace(/\n$/, ''));
    });
    try {
        await fn();
    } finally {
        fetchMock.mock.restore();
        nowMock.mock.restore();
        sleepMock.mock.restore();
        writeMock.mock.restore();
    }
    return {'calls': fetchMock.mock.calls.map((call) => call.arguments), output};
}


// A text response function
const text = (body) => () => new Response(body);


// A JSON response function
const json = (data) => () => new Response(JSON.stringify(data), {'headers': {'Content-Type': 'application/json'}});


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


const gutendexURL = (page) => `https://gutendex.com/books/?languages=en&mime_type=text%2Fplain&page=${page}`;
const gitenbergListURL = 'https://raw.githubusercontent.com/gitenberg-dev/gitberg/master/gitenberg/data/GITenberg_repo_list.tsv';
const rawURL = (repository, file) => `https://raw.githubusercontent.com/GITenberg/${repository}/master/${file}`;
const searchURL = (id) => `https://api.github.com/search/repositories?q=_${id}+in%3Aname+org%3AGITenberg&per_page=100`;


// A Gutendex result
function gutendexResult(id, title, author, more = {}) {
    return {
        id,
        title,
        'authors': [{'name': author}],
        'summaries': [`"${title}" by ${author} is a book about ${title.toLowerCase()}.`],
        'subjects': ['Fiction'],
        'bookshelves': [],
        'languages': ['en'],
        'copyright': false,
        'media_type': 'Text',
        'formats': {'image/jpeg': `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`},
        ...more
    };
}


// A Gutenberg catalog book
function gutenbergBook(id, title, author, rank, url, more = {}) {
    return {
        'source': 'gutenberg',
        'id': String(id),
        title,
        author,
        'description': `A book about ${title.toLowerCase()}.`,
        'subjects': ['Fiction'],
        'language': 'en',
        'cover': `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
        rank,
        'words': 100000,
        'text': {url, 'format': 'gutenberg-text', 'encoding': 'utf-8'},
        ...more
    };
}


test('gutendexBooks', async () => {
    resetCache();
    const site = {
        [gutendexURL(1)]: json({'next': gutendexURL(2), 'results': [
            gutendexResult(1, 'One', 'A, B'),
            gutendexResult(2, 'Two', 'A, B', {'media_type': 'Sound'}),
            gutendexResult(3, 'Three', 'A, B', {'copyright': true}),
            gutendexResult(4, 'Four', 'A, B', {'copyright': null})
        ]}),
        [gutendexURL(2)]: json({'next': null, 'results': [gutendexResult(5, 'Five', 'A, B')]})
    };
    let results;
    let {calls, output} = await withSite(site, async () => {
        results = await gutendexBooks({'gutenberg': 10, 'maxAge': 30, 'cacheOnly': false});
    });
    assert.deepEqual(results.map((result) => result.id), [1, 4, 5]);
    assert.deepEqual(calls.map(([url]) => url), [gutendexURL(1), gutendexURL(2)]);
    assert.deepEqual(output, ['Gutendex: page 1 - 2 books', 'Gutendex: page 2 - 3 books']);

    // At most one book
    ({calls, output} = await withSite({}, async () => {
        results = await gutendexBooks({'gutenberg': 1, 'maxAge': 30, 'cacheOnly': false});
    }));
    assert.deepEqual(results.map((result) => result.id), [1]);
    assert.deepEqual(calls, []);
    assert.deepEqual(output, ['Gutendex: page 1 - 1 books']);

    // Not available
    resetCache();
    ({output} = await withSite({}, async () => {
        results = await gutendexBooks({'gutenberg': 10, 'maxAge': 30, 'cacheOnly': false});
    }));
    assert.deepEqual(results, []);
    assert.deepEqual(output, []);
});


test('gutenbergBooks', async () => {
    resetCache();
    writeCache('gitenberg/texts.json', JSON.stringify({
        '11': {
            'repository': 'Cached_11', 'text': {'url': 'https://example.com/11.txt', 'encoding': 'utf-8', 'bytes': 598000}, 'checked': 0
        },
        '12': {'repository': null, 'text': null, 'checked': 0},
        '13': {'repository': null, 'text': null, 'checked': clock + 7200000}
    }));
    const site = {
        [gutendexURL(1)]: json({'next': null, 'results': [
            gutendexResult(1001, 'A Dictionary of the English Language', 'Johnson, Samuel'),
            gutendexResult(1342, 'Pride and Prejudice', 'Austen, Jane'),
            gutendexResult(84, 'Frankenstein; Or, The Modern Prometheus', 'Shelley, Mary Wollstonecraft'),
            gutendexResult(41445, 'Frankenstein; or, the modern prometheus', 'Shelley, Mary Wollstonecraft'),
            gutendexResult(2701, 'Moby Dick; Or, The Whale', 'Melville, Herman'),
            gutendexResult(60000, 'Unlisted', 'Writer, A'),
            gutendexResult(3000, 'Not Found', 'Writer, A'),
            gutendexResult(11, 'Cached', 'Writer, A', {
                'authors': [], 'summaries': [], 'languages': ['fr', 'de'], 'formats': {}, 'bookshelves': ['Category: Novels']
            }),
            gutendexResult(12, 'Stale', 'Writer, A'),
            gutendexResult(13, 'Recent', 'Writer, A')
        ]}),
        [gitenbergListURL]: text('gutenberg_id\trepo_name\n84\tFrankenstein_84\n12\tStale_12\n50000\tLast_50000\n'),
        [rawURL('Frankenstein_84', '84-0.txt')]: () => new Response(null, {'headers': {'Content-Length': '598000'}}),
        [rawURL('Moby-Dick_2701', '2701-0.txt')]: () => new Response(null, {'headers': {'Content-Length': '598000'}}),
        [rawURL('Stale_12', '12-0.txt')]: () => new Response(null, {'headers': {'Content-Length': '598000'}}),
        [searchURL(2701)]: json({'items': [{'name': 'Moby-Dick_2701'}]}),
        [searchURL(3000)]: json({'items': []})
    };
    const seBooks = [{'title': 'Pride and Prejudice', 'author': 'Jane Austen'}];
    let books;
    const {calls, output} = await withSite(site, async () => {
        books = await gutenbergBooks({'gutenberg': 1000, 'maxAge': 30, 'cacheOnly': false}, seBooks);
    });
    assert.deepEqual(books, [
        gutenbergBook(84, 'Frankenstein', 'Mary Wollstonecraft Shelley', 1, rawURL('Frankenstein_84', '84-0.txt'), {
            'subtitle': 'Or, The Modern Prometheus',
            'description': 'A book about frankenstein; or, the modern prometheus.'
        }),
        gutenbergBook(2701, 'Moby Dick', 'Herman Melville', 2, rawURL('Moby-Dick_2701', '2701-0.txt'), {
            'subtitle': 'Or, The Whale',
            'description': 'A book about moby dick; or, the whale.'
        }),
        gutenbergBook(11, 'Cached', '', 3, 'https://example.com/11.txt', {
            'description': '', 'subjects': ['Fiction', 'Novels'], 'language': 'fr', 'cover': null
        }),
        gutenbergBook(12, 'Stale', 'A Writer', 4, rawURL('Stale_12', '12-0.txt'))
    ]);
    assert.deepEqual(calls.map(([url]) => url), [
        gutendexURL(1),
        gitenbergListURL,
        rawURL('Frankenstein_84', '84-0.txt'),
        searchURL(2701),
        rawURL('Moby-Dick_2701', '2701-0.txt'),
        searchURL(3000),
        rawURL('Stale_12', '12-0.txt')
    ]);
    assert.deepEqual(output, [
        'Gutendex: page 1 - 10 books',
        'Gutenberg: 7 candidates (1 Standard Ebooks duplicates, 1 duplicate editions, 1 reference works)',
        'Gutenberg: 4 books (3 not in GITenberg)'
    ]);
    const textCache = JSON.parse(readFileSync(join(cacheDir, 'gitenberg', 'texts.json'), 'utf-8'));
    assert.deepEqual(Object.keys(textCache).sort(), ['11', '12', '13', '2701', '3000', '60000', '84']);
    assert.deepEqual({...textCache['60000'], 'checked': 0}, {'repository': null, 'text': null, 'checked': 0});
    assert.deepEqual(textCache['2701'].text, {'url': rawURL('Moby-Dick_2701', '2701-0.txt'), 'encoding': 'utf-8', 'bytes': 598000});
    assert.deepEqual(
        JSON.parse(readFileSync(join(cacheDir, 'gitenberg', 'search.json'), 'utf-8')),
        {'2701': 'Moby-Dick_2701', '3000': null}
    );
});


test('gutenbergBooks, cache-only', async () => {
    resetCache();
    const results = Array.from({'length': 101}, (unused, index) => gutendexResult(index + 1, `Book ${index + 1}`, 'Writer, A'));
    writeCache('gutendex/page-1.json', JSON.stringify({'next': null, results}));
    const textCache = {'101': {'repository': null, 'text': null, 'checked': 0}};
    for (let id = 2; id <= 100; id++) {
        textCache[id] = {'repository': `Book_${id}`, 'text': {'url': `https://example.com/${id}.txt`, 'encoding': 'utf-8', 'bytes': 0}};
    }
    writeCache('gitenberg/texts.json', JSON.stringify(textCache));
    let books;
    const {calls, output} = await withSite({}, async () => {
        books = await gutenbergBooks({'gutenberg': 1000, 'maxAge': 30, 'cacheOnly': true}, []);
    });
    assert.equal(calls.length, 0);
    assert.equal(books.length, 99);
    assert.equal(books[0].id, '2');
    assert.equal(books[0].words, null);
    assert.deepEqual(output, [
        'Gutendex: page 1 - 101 books',
        'Gutenberg: 101 candidates (0 Standard Ebooks duplicates, 0 duplicate editions, 0 reference works)',
        'Gutenberg: 100 of 101 texts resolved',
        'Gutenberg: 99 books (1 not in GITenberg, 1 not yet resolved)'
    ]);
});


//
// The catalog
//


// The genre keys
const genreKeys = Object.keys(genreNames());


// A fake Ollama decision model's answer to a request - its voice or its genre
function ollamaAnswer(path, request) {
    if (path === '/api/show') {
        return {'capabilities': ['completion', 'decision']};
    }
    if ('voice' in request.questions) {
        return {'answers': {'voice': {'choice': 'helen', 'probabilities': {'helen': 0.9, 'sarah': 0.1}}}};
    }
    return {'answers': {'genre': {'choice': genreKeys[1], 'probabilities': {[genreKeys[0]]: 0.3, [genreKeys[1]]: 0.7}}}};
}


test('buildCatalog', async () => {
    resetCache();
    const output = join(tempDir, 'out', 'catalog.json');
    const ollama = (path) => (options) => new Response(JSON.stringify(ollamaAnswer(path, JSON.parse(options.body))));
    const site = {
        [seListURL(1)]: text(seListing([seItem(prideId, 'Pride and Prejudice', 'Jane Austen', '/images/covers/pride.jpg')], null)),
        [`${seURL}${prideId}`]: text(pridePage),
        [gutendexURL(1)]: json({'next': null, 'results': [gutendexResult(84, 'Frankenstein', 'Shelley, Mary Wollstonecraft')]}),
        [gitenbergListURL]: text('84\tFrankenstein_84\n'),
        [rawURL('Frankenstein_84', '84-0.txt')]: () => new Response(null, {'headers': {'Content-Length': '598000'}}),
        'http://ollama.test/api/show': ollama('/api/show'),
        'http://ollama.test/v1/systemone': ollama('/v1/systemone')
    };
    const options = {'gutenberg': 10, 'standardebooks': Infinity, 'maxAge': 30, 'cacheOnly': false, output, 'voiceModel': 'test:1b'};
    const {calls, output: lines} = await withSite(site, async () => {
        await buildCatalog(options);
    });
    const catalog = JSON.parse(readFileSync(output, 'utf-8'));
    assert.equal(catalog.version, 1);
    assert.match(catalog.generated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(Object.keys(catalog.sources), ['standardebooks', 'gutenberg']);
    assert.deepEqual(catalog.genres, genreNames());
    assert.deepEqual(catalog.books, [
        {...prideBook, 'voice': 'helen', 'genres': [genreKeys[1], genreKeys[0]]},
        {
            ...gutenbergBook(84, 'Frankenstein', 'Mary Wollstonecraft Shelley', 1, rawURL('Frankenstein_84', '84-0.txt')),
            'voice': 'helen',
            'genres': [genreKeys[1], genreKeys[0]]
        }
    ]);
    const systemone = calls.filter(([url]) => url === 'http://ollama.test/v1/systemone').map(([, request]) => JSON.parse(request.body));
    assert.equal(systemone.length, 4);
    assert.equal(systemone[0].model, 'test:1b');
    assert.deepEqual(systemone[0].state, {
        'title': 'Pride and Prejudice', 'author': 'Jane Austen', 'subjects': 'Fiction, Romance', 'description': 'A novel of manners.'
    });
    assert.match(lines.at(-1), /catalog\.json: 1 Standard Ebooks and 1 Gutenberg books, \d+ bytes$/);

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


const execFileAsync = promisify(execFile);


test('catalog.js, command line', async () => {
    // The cache - a Standard Ebooks book and a Gutenberg book
    resetCache();
    writeCache(
        'standardebooks/list-1.html',
        seListing([seItem(prideId, 'Pride and Prejudice', 'Jane Austen', '/images/covers/pride.jpg')], null)
    );
    writeCache('standardebooks/book_jane-austen_pride-and-prejudice.html', pridePage);
    writeCache('gutendex/page-1.json', JSON.stringify({'next': null, 'results': [gutendexResult(84, 'Frankenstein', 'Shelley, Mary')]}));
    writeCache('gitenberg/texts.json', JSON.stringify({
        '84': {
            'repository': 'Frankenstein_84', 'text': {'url': rawURL('Frankenstein_84', '84-0.txt'), 'encoding': 'utf-8', 'bytes': 598000}
        }
    }));

    // The fake Ollama
    const requests = [];
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => {
            body += chunk;
        });
        request.on('end', () => {
            requests.push(request.url);
            response.writeHead(200, {'Content-Type': 'application/json'});
            response.end(JSON.stringify(ollamaAnswer(request.url, JSON.parse(body))));
        });
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const output = join(tempDir, 'cli', 'catalog.json');
    let result;
    try {
        result = await execFileAsync(process.execPath, [catalogPath, '--cache-only', '--voice-model', 'test:1b', '-o', output], {
            'env': {...process.env, 'PICOSHELF_CACHE': cacheDir, 'OLLAMA_HOST': `127.0.0.1:${server.address().port}`}
        });
    } finally {
        server.close();
    }
    assert.equal(result.stderr, '');
    const lines = result.stdout.trimEnd().split('\n').map((line) => line.replace(/^\[\d+:\d\d\] /, ''));
    assert.deepEqual(lines.slice(0, 5), [
        'Standard Ebooks: listing page 1 - 1 books',
        'Standard Ebooks: 1 books (0 without a book page or EPUB)',
        'Gutendex: page 1 - 1 books',
        'Gutenberg: 1 candidates (0 Standard Ebooks duplicates, 0 duplicate editions, 0 reference works)',
        'Gutenberg: 1 books (0 not in GITenberg)'
    ]);
    assert.match(lines.at(-1), /catalog\.json: 1 Standard Ebooks and 1 Gutenberg books, \d+ bytes$/);
    const catalog = JSON.parse(readFileSync(output, 'utf-8'));
    assert.deepEqual(catalog.books.map((book) => [book.id, book.title, book.author, book.voice]), [
        [prideId, 'Pride and Prejudice', 'Jane Austen', 'helen'],
        ['84', 'Frankenstein', 'Mary Shelley', 'helen']
    ]);
    assert.deepEqual(requests, ['/api/show', '/v1/systemone', '/v1/systemone', '/api/show', '/v1/systemone', '/v1/systemone']);
});


test('catalog.js, command line error', async () => {
    await assert.rejects(
        execFileAsync(process.execPath, [catalogPath, '--bogus'], {'env': {...process.env, 'PICOSHELF_CACHE': cacheDir}}),
        {'code': 1, 'stdout': '', 'stderr': 'error: Unknown argument "--bogus"\n'}
    );
});
