import {cacheDir, gutenbergFile, resetCache, withSite, writeCache} from './toolsHelpers.js';
import {existsSync, readFileSync, utimesSync} from 'node:fs';
import {gunzipSync, gzipSync} from 'node:zlib';
import test, {mock} from 'node:test';
import {Buffer} from 'node:buffer';
import {strict as assert} from 'node:assert';
import {join} from 'node:path';
import process from 'node:process';


// The tools - imported after toolsHelpers.js sets their cache directory
const {
    catalogJSON, collapseSpace, fetchCached, fetchFile, fetchRetry, genreQuotas, gitenbergRepositories, gutenbergAuthor,
    gutenbergDescription, gutenbergSubjects, gutenbergText, gutenbergTitle, isReferenceWork, isSameWork, log, parseArgs, services,
    surnameKeys,
    titleCase, titleKey, trimDescription, uniqueSubjects
} = await import('../tools/catalog.js');
const {qualityVersion} = await import('../tools/quality.js');


//
// Command line and logging
//


test('parseArgs, defaults', () => {
    const options = parseArgs([]);
    assert.equal(options.books, 5000);
    assert.equal(options.popular, 1000);
    assert.equal(options.gutenberg, 8000);
    assert.equal(options.standardebooks, Infinity);
    assert.equal(options.maxAge, 30);
    assert.equal(options.pageMaxAge, 365);
    assert.equal(options.cacheOnly, false);
    assert.equal(options.voiceModel, 'kev:9b-nvfp4');
    assert.match(options.output, /data[/\\]catalog\.json$/);
});


test('parseArgs, arguments', () => {
    assert.deepEqual(
        parseArgs([
            '--books', '100', '--popular', '20', '--gutenberg', '10', '--standardebooks', '5', '--max-age', '0', '--page-max-age', '7',
            '--cache-only', '--voice-model', 'test:1b', '-o', 'out.json'
        ]),
        {
            'books': 100, 'popular': 20, 'gutenberg': 10, 'standardebooks': 5, 'maxAge': 0, 'pageMaxAge': 7, 'cacheOnly': true,
            'output': 'out.json', 'voiceModel': 'test:1b'
        }
    );
});


test('parseArgs, errors', () => {
    assert.throws(() => parseArgs(['--bogus']), {'message': 'Unknown argument "--bogus"'});
    assert.throws(() => parseArgs(['--books', 'all']), {'message': 'Invalid books "NaN"'});
    assert.throws(() => parseArgs(['--popular', '-5']), {'message': 'Invalid popular "-5"'});
    assert.throws(() => parseArgs(['--gutenberg', 'many']), {'message': 'Invalid gutenberg "NaN"'});
    assert.throws(() => parseArgs(['--standardebooks', '-1']), {'message': 'Invalid standardebooks "-1"'});
    assert.throws(() => parseArgs(['--max-age']), {'message': 'Invalid maxAge "NaN"'});
    assert.throws(() => parseArgs(['--page-max-age', '-2']), {'message': 'Invalid pageMaxAge "-2"'});
});


test('log', async () => {
    const {output} = await withSite(null, () => {
        log('Hello');
    });
    assert.deepEqual(output, ['Hello']);
});


test('services, real', async () => {
    const writeMock = mock.method(process.stdout, 'write', () => true);
    try {
        services.write('');
    } finally {
        writeMock.mock.restore();
    }
    assert.deepEqual(writeMock.mock.calls.map((call) => call.arguments), [['']]);
    const start = Date.now();
    assert.equal(await services.sleep(5), undefined);
    assert.ok(Date.now() - start >= 4);
});


//
// Text helpers
//


test('collapseSpace', () => {
    assert.equal(collapseSpace('  A\n\tbook  of\r\nwords '), 'A book of words');
});


test('trimDescription', () => {
    // Short enough
    assert.equal(trimDescription(' A short\ndescription. '), 'A short description.');

    // At a sentence end past a third of the limit (a closing quote too)
    const sentence = `${'word '.repeat(50)}ends "here."`;
    assert.equal(trimDescription(`${sentence} ${'more '.repeat(150)}`), sentence);

    // At a word break, with an ellipsis (a sentence end only before a third of the limit)
    const trimmed = trimDescription(`Short. ${'word, '.repeat(150)}`);
    assert.equal(trimmed, `Short. ${'word, '.repeat(98)}word…`);
    assert.ok(trimmed.length <= 601);
});


test('uniqueSubjects', () => {
    assert.deepEqual(uniqueSubjects(['Fiction', ' fiction ', '', '...', 'Love  stories']), ['Fiction', 'Love stories']);
    assert.deepEqual(uniqueSubjects(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
});


test('titleKey', () => {
    assert.equal(titleKey('The Case-Book of Sherlock Holmes'), titleKey('The Casebook of Sherlock Holmes'));
    assert.equal(titleKey('An Essay'), 'essay');
});


test('isSameWork', () => {
    // The same title, or a Gutenberg title beginning with the Standard Ebooks title's words
    assert.equal(isSameWork('The Casebook of Sherlock Holmes', 'The Case-Book of Sherlock Holmes'), true);
    assert.equal(isSameWork('The Adventures of Tom Sawyer, Complete', 'The Adventures of Tom Sawyer'), true);
    assert.equal(isSameWork('Whose Body? A Lord Peter Wimsey Novel', 'Whose Body?'), true);
    assert.equal(isSameWork('The Odyssey of Homer', 'The Odyssey'), true);

    // A longer word, or another title
    assert.equal(isSameWork('Dracula\'s Guest', 'Dracula'), false);
    assert.equal(isSameWork('Emmanuel', 'Emma'), false);
    assert.equal(isSameWork('Persuasion', 'Emma'), false);
});


test('surnameKeys', () => {
    assert.deepEqual(surnameKeys('Mary Shelley, Percy Bysshe Shelley'), ['shel', 'shel']);
    assert.deepEqual(surnameKeys('Fyodor Dostoevsky'), surnameKeys('Fyodor Dostoyevsky'));
    assert.deepEqual(surnameKeys(''), ['']);
});


//
// Project Gutenberg metadata
//


test('gutenbergTitle', () => {
    assert.deepEqual(gutenbergTitle('Pride and prejudice'), {'title': 'Pride and Prejudice', 'subtitle': ''});
    assert.deepEqual(
        gutenbergTitle('Frankenstein; Or, The Modern Prometheus'),
        {'title': 'Frankenstein', 'subtitle': 'Or, The Modern Prometheus'}
    );
    assert.deepEqual(
        gutenbergTitle('Frankenstein; or, the modern prometheus'),
        {'title': 'Frankenstein', 'subtitle': 'Or, the Modern Prometheus'}
    );

    // Lines - a line break after punctuation is a space, else a separator
    assert.deepEqual(gutenbergTitle('The Adventures of Tom Sawyer\r\nComplete'), {'title': 'The Adventures of Tom Sawyer', 'subtitle': ''});
    assert.deepEqual(gutenbergTitle('Ivanhoe;\n  A Romance'), {'title': 'Ivanhoe', 'subtitle': ''});

    // Separators - not in the first three characters or in parentheses; a dash; a trailing comma dropped
    assert.deepEqual(gutenbergTitle('Ab: Cd: Ef'), {'title': 'Ab: Cd', 'subtitle': 'Ef'});
    assert.deepEqual(
        gutenbergTitle('Essays (First Series: Self-Reliance) - Volume 1'),
        {'title': 'Essays (First Series: Self-Reliance)', 'subtitle': 'Volume 1'}
    );
    assert.deepEqual(
        gutenbergTitle('Uncle Tom\'s Cabin, — Life among the lowly'),
        {'title': 'Uncle Tom\'s Cabin', 'subtitle': 'Life Among the Lowly'}
    );

    // A long subtitle shortened
    const {subtitle} = gutenbergTitle(`Letters: ${'Written From Abroad '.repeat(10)}`);
    assert.equal(subtitle, `${'Written From Abroad '.repeat(5).trim()}…`);
});


test('titleCase', () => {
    assert.equal(titleCase('the three musketeers'), 'The Three Musketeers');
    assert.equal(titleCase('or, the modern prometheus'), 'Or, the Modern Prometheus');
    assert.equal(titleCase('memoirs of d\'artagnan'), 'Memoirs of d\'artagnan');
    assert.equal(titleCase('A Tale of Two Cities'), 'A Tale of Two Cities');
    assert.equal(titleCase('the Count of Monte cristo'), 'The Count of Monte cristo');
    assert.equal(titleCase(''), '');
});


test('gutenbergAuthor', () => {
    assert.equal(gutenbergAuthor('Austen, Jane'), 'Jane Austen');
    assert.equal(gutenbergAuthor('Shelley, Mary Wollstonecraft (Godwin)'), 'Mary Wollstonecraft Shelley');
    assert.equal(gutenbergAuthor('Homer'), 'Homer');
    assert.equal(gutenbergAuthor(''), '');
    assert.equal(gutenbergAuthor('Marcus Aurelius, Emperor of Rome'), 'Marcus Aurelius');
    assert.equal(gutenbergAuthor('Augustine, of Hippo, Saint'), 'Augustine of Hippo');
    assert.equal(gutenbergAuthor('Doyle, Arthur Conan, Sir'), 'Arthur Conan Doyle');
    assert.equal(gutenbergAuthor('Dumas, Alexandre, Jr.'), 'Alexandre Dumas Jr.');
});


test('gutenbergDescription', () => {
    assert.equal(
        gutenbergDescription('"Pride and Prejudice" by Jane Austen is a novel  of manners. (This is an automatically generated summary.)'),
        'A novel of manners.'
    );
    assert.equal(
        gutenbergDescription('“Hamlet” (1603) by William Shakespeare is the tragedy of a prince.'),
        'The tragedy of a prince.'
    );
    assert.equal(gutenbergDescription('A tale of two cities.'), 'A tale of two cities.');
    assert.equal(gutenbergDescription(''), '');
});


test('gutenbergSubjects', () => {
    assert.deepEqual(
        gutenbergSubjects({
            'bookshelves': ['Category: Novels', 'Browsing: Crime/Mystery', 'Best Books Ever Listings'],
            'subjects': [
                'Holmes, Sherlock (Fictitious character) -- Fiction',
                'Dickens, Charles, 1812-1870 -- Fiction',
                'Detective and mystery stories, English',
                'London (England) -- Social life and customs'
            ]
        }),
        ['Fiction', 'Novels', 'Crime/Mystery', 'Sherlock Holmes', 'Charles Dickens', 'Detective and mystery stories, English', 'London']
    );
    assert.deepEqual(gutenbergSubjects({'bookshelves': [], 'subjects': ['Philosophy']}), ['Philosophy']);
});


test('isReferenceWork', () => {
    assert.equal(isReferenceWork({'title': 'A Dictionary of the English Language', 'subjects': []}), true);
    assert.equal(isReferenceWork({'title': 'The Encyclopaedia Britannica', 'subjects': []}), true);
    assert.equal(isReferenceWork({'title': 'Words', 'subjects': ['English language -- Dictionaries']}), true);
    assert.equal(isReferenceWork({'title': 'Moby Dick', 'subjects': ['Whaling -- Fiction', 'Sea stories']}), false);
});


test('catalogJSON', () => {
    const catalog = {'version': 1, 'genres': {'fiction': 'Fiction'}, 'books': [{'id': 'a', 'title': 'A'}, {'id': 'b', 'title': 'B'}]};
    const json = catalogJSON(catalog);
    assert.equal(json, `{
    "version": 1,
    "genres": {
        "fiction": "Fiction"
    },
    "books": [
        {"id":"a","title":"A"},
        {"id":"b","title":"B"}
    ]
}
`);
    assert.deepEqual(JSON.parse(json), catalog);
});


//
// Fetching
//


test('fetchRetry', async () => {
    const url = 'https://retry-ok.test/page';
    let result;
    const {calls, sleeps} = await withSite(() => new Response('OK'), async () => {
        const response = await fetchRetry(url, {'method': 'HEAD', 'headers': {'Accept': 'text/plain'}, 'timeout': 1000});
        result = await response.text();
    });
    assert.equal(result, 'OK');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], url);
    assert.equal(calls[0][1].method, 'HEAD');
    assert.deepEqual(calls[0][1].headers, {
        'User-Agent': 'picoshelf-catalog/1.0 (+https://github.com/craigahobbs/picoshelf)',
        'Accept': 'text/plain'
    });
    assert.ok(calls[0][1].signal instanceof AbortSignal);
    assert.deepEqual(sleeps, []);
});


test('fetchRetry, throttle', async () => {
    const {sleeps} = await withSite(() => new Response('OK'), async () => {
        // An unknown host - 500 ms apart
        await fetchRetry('https://throttle.test/1');
        await fetchRetry('https://throttle.test/2');

        // Gutenberg - a second apart; GitHub's raw files - 100 ms apart
        await fetchRetry('https://www.gutenberg.org/cache/epub/feeds/rdf-files.tar.bz2');
        await fetchRetry('https://www.gutenberg.org/cache/epub/feeds/rdf-files.tar.bz2');
        await fetchRetry('https://raw.githubusercontent.com/GITenberg/Book_1/master/1-0.txt');
        await fetchRetry('https://raw.githubusercontent.com/GITenberg/Book_2/master/2-0.txt');
    });
    assert.deepEqual(sleeps, [500, 1000, 100]);
});


test('fetchRetry, retries', async () => {
    const url = 'https://retry.test/page';
    const responses = [
        () => new Response('Busy', {'status': 503, 'headers': {'Retry-After': '10'}}),
        () => new Response(null, {'status': 429}),
        () => {
            throw Object.assign(new TypeError('fetch failed'), {'cause': {'code': 'ECONNRESET'}});
        },
        () => {
            throw new DOMException('The operation timed out.', 'TimeoutError');
        },
        () => new Response('OK')
    ];
    let result;
    const {calls, sleeps, output} = await withSite(() => responses.shift()(), async () => {
        result = await (await fetchRetry(url)).text();
    });
    assert.equal(result, 'OK');
    assert.equal(calls.length, 5);
    assert.deepEqual(sleeps, [10000, 4000, 8000, 16000]);
    assert.deepEqual(output, [
        `  ${url}: error 503 - retrying in 10 s`,
        `  ${url}: error 429 - retrying in 4 s`,
        `  ${url}: ECONNRESET - retrying in 8 s`,
        `  ${url}: TimeoutError - retrying in 16 s`
    ]);
});


test('fetchRetry, errors', async () => {
    const url = 'https://retry-error.test/page';
    await withSite(() => new Response('Error', {'status': 500}), async () => {
        await assert.rejects(fetchRetry(url, {'attempts': 2}), {'message': `${url}: error 500`});
    });
    const {calls} = await withSite(() => Promise.reject(new TypeError('fetch failed')), async () => {
        await assert.rejects(fetchRetry(url, {'attempts': 3}), {'message': 'fetch failed'});
    });
    assert.equal(calls.length, 3);
});


test('fetchCached', async () => {
    resetCache();
    const url = 'https://cached.test/page';
    const options = {'maxAge': 30, 'cacheOnly': false};
    const results = [];
    const {calls} = await withSite(() => new Response('Page'), async () => {
        // Fetched, then cached
        results.push(await fetchCached(url, 'site/page.html', options));
        results.push(await fetchCached(url, 'site/page.html', options));

        // Too old - refetched
        results.push(await fetchCached(url, 'site/page.html', {'maxAge': 0, 'cacheOnly': false}));

        // Old but cache-only
        utimesSync(join(cacheDir, 'site', 'page.html'), 0, 0);
        results.push(await fetchCached(url, 'site/page.html', {'maxAge': 30, 'cacheOnly': true}));

        // Uncached and cache-only
        results.push(await fetchCached(url, 'site/other.html', {'maxAge': 30, 'cacheOnly': true}));
    });
    assert.deepEqual(results, ['Page', 'Page', 'Page', 'Page', null]);
    assert.equal(calls.length, 2);
    assert.equal(readFileSync(join(cacheDir, 'site', 'page.html'), 'utf-8'), 'Page');
});


test('fetchCached, 404', async () => {
    resetCache();
    const options = {'maxAge': 30, 'cacheOnly': false};
    const responses = [new Response('Not Found', {'status': 404}), new Response(null, {'status': 404})];
    const results = [];
    const {calls} = await withSite(() => responses.shift(), async () => {
        results.push(await fetchCached('https://cached.test/missing', 'site/missing.html', options));
        results.push(await fetchCached('https://cached.test/missing', 'site/missing.html', options));
        results.push(await fetchCached('https://cached.test/gone', 'site/gone.html', options));
    });
    assert.deepEqual(results, [null, null, null]);
    assert.equal(calls.length, 2);
    assert.equal(readFileSync(join(cacheDir, 'site', 'missing.html.404'), 'utf-8'), '');
    assert.equal(existsSync(join(cacheDir, 'site', 'missing.html')), false);
    assert.equal(existsSync(join(cacheDir, 'site', 'gone.html.404')), true);
});


test('fetchCached, error', async () => {
    resetCache();
    await withSite(() => new Response('Forbidden', {'status': 403}), async () => {
        await assert.rejects(
            fetchCached('https://cached.test/forbidden', 'site/forbidden.html', {'maxAge': 30, 'cacheOnly': false}, 1000),
            {'message': 'https://cached.test/forbidden: error 403'}
        );
    });
    assert.equal(existsSync(join(cacheDir, 'site')), false);
});


test('fetchFile', async () => {
    resetCache();
    const url = 'https://file.test/archive.tar.bz2';
    const path = join(cacheDir, 'site', 'archive.tar.bz2');
    const bodies = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const results = [];
    const {calls} = await withSite(() => new Response(bodies.shift()), async () => {
        // Fetched, then cached
        results.push(await fetchFile(url, 'site/archive.tar.bz2', {'maxAge': 30, 'cacheOnly': false}, 1000));
        results.push([...readFileSync(path)]);
        results.push(await fetchFile(url, 'site/archive.tar.bz2', {'maxAge': 30, 'cacheOnly': false}));

        // Too old - refetched
        results.push(await fetchFile(url, 'site/archive.tar.bz2', {'maxAge': 0, 'cacheOnly': false}));
        results.push([...readFileSync(path)]);

        // Old but cache-only
        utimesSync(path, 0, 0);
        results.push(await fetchFile(url, 'site/archive.tar.bz2', {'maxAge': 30, 'cacheOnly': true}));

        // Uncached and cache-only
        results.push(await fetchFile(url, 'site/other.tar.bz2', {'maxAge': 30, 'cacheOnly': true}));
    });
    assert.deepEqual(results, [path, [1, 2, 3], path, path, [4, 5], path, null]);
    assert.deepEqual(calls.map(([callURL]) => callURL), [url, url]);
    assert.equal(existsSync(`${path}.tmp`), false);
});


test('fetchFile, error', async () => {
    resetCache();
    await withSite(() => new Response('Not Found', {'status': 404}), async () => {
        await assert.rejects(
            fetchFile('https://file.test/missing', 'site/missing.tar.bz2', {'maxAge': 30, 'cacheOnly': false}),
            {'message': 'https://file.test/missing: error 404'}
        );
    });
    assert.equal(existsSync(join(cacheDir, 'site')), false);
});


//
// GITenberg
//


test('gitenbergRepositories', async () => {
    resetCache();
    const tsv = 'gutenberg_id\trepo_name\n84\tFrankenstein_84\r\n84\tFrankenstein-Again_84\n11\tAlice_11_x\nabc\tBad_abc\n\n' +
        '1342\tPride-and-Prejudice_1342\n';
    let repositories;
    const {calls} = await withSite(() => new Response(tsv), async () => {
        repositories = await gitenbergRepositories({'maxAge': 30, 'cacheOnly': false});
    });
    assert.deepEqual([...repositories], [['84', 'Frankenstein_84'], ['1342', 'Pride-and-Prejudice_1342']]);
    assert.equal(calls[0][0], 'https://raw.githubusercontent.com/gitenberg-dev/gitberg/master/gitenberg/data/GITenberg_repo_list.tsv');
    assert.equal(readFileSync(join(cacheDir, 'gitenberg', 'GITenberg_repo_list.tsv'), 'utf-8'), tsv);

    // Not available
    resetCache();
    await withSite(() => new Response('', {'status': 404}), async () => {
        repositories = await gitenbergRepositories({'maxAge': 30, 'cacheOnly': false});
    });
    assert.equal(repositories.size, 0);
});



test('gutenbergText', async () => {
    resetCache();
    const base = 'https://raw.githubusercontent.com/GITenberg/';
    const site = {
        // The UTF-8 file
        [`${base}Book_1/master/1-0.txt`]: () => new Response(gutenbergFile('Café — crème.')),

        // The plain file - UTF-8, and Windows-1252
        [`${base}Book_2/master/2.txt`]: () => new Response(gutenbergFile('Café — crème.')),
        [`${base}Book_3/master/3.txt`]: () => new Response(Buffer.from(gutenbergFile('Café crème.'), 'latin1')),

        // The Latin-1 file
        [`${base}Book_4/master/4-8.txt`]: () => new Response(gutenbergFile()),

        // A text that fails the quality rules
        [`${base}Book_6/master/6-0.txt`]: () => new Response(
            gutenbergFile('[See the note.] '.repeat(20).trim(), 'A ~tilde~ word. '.repeat(10).trim())
        ),
        [`${base}Book_7/master/7-0.txt`]: () => new Response('A short text.'),

        // An error
        [`${base}Book_8/master/8-0.txt`]: () => new Response('Forbidden', {'status': 403})
    };
    const book = (id) => ({'id': String(id), 'title': 'A Book', 'author': 'An Author'});
    const options = {'maxAge': 30, 'cacheOnly': false};
    const textCache = {};
    const results = [];
    const {calls} = await withSite(site, async () => {
        for (const id of [1, 2, 3, 4, 5, 6, 7]) {
            results.push(await gutenbergText(book(id), `Book_${id}`, textCache, options));
        }
        await assert.rejects(gutenbergText(book(8), 'Book_8', textCache, options), {'message': `${base}Book_8/master/8-0.txt: error 403`});
    });
    const text = (file, encoding, words, reason = null) => ({'version': qualityVersion, file, encoding, words, reason});
    assert.deepEqual(results, [
        text('1-0.txt', 'utf-8', 743),
        text('2.txt', 'utf-8', 743),
        text('3.txt', 'windows-1252', 742),
        text('4-8.txt', 'windows-1252', 740),
        text(null, null, 0, 'no text file'),
        text('6-0.txt', 'utf-8', 830, 'notes, marks'),
        text('7-0.txt', 'utf-8', 8, 'too short')
    ]);
    assert.deepEqual(textCache, {
        '1': results[0], '2': results[1], '3': results[2], '4': results[3], '5': results[4], '6': results[5], '7': results[6]
    });
    assert.deepEqual(calls.map(([url]) => url.slice(base.length)), [
        'Book_1/master/1-0.txt',
        'Book_2/master/2-0.txt', 'Book_2/master/2.txt',
        'Book_3/master/3-0.txt', 'Book_3/master/3.txt',
        'Book_4/master/4-0.txt', 'Book_4/master/4.txt', 'Book_4/master/4-8.txt',
        'Book_5/master/5-0.txt', 'Book_5/master/5.txt', 'Book_5/master/5-8.txt',
        'Book_6/master/6-0.txt',
        'Book_7/master/7-0.txt',
        'Book_8/master/8-0.txt'
    ]);

    // The texts are cached, gzipped
    const textPath = (id) => join(cacheDir, 'gitenberg', 'texts', `${id}.txt.gz`);
    assert.equal(gunzipSync(readFileSync(textPath(1))).toString('utf-8'), gutenbergFile('Café — crème.'));
    assert.equal(gunzipSync(readFileSync(textPath(3))).toString('latin1'), gutenbergFile('Café crème.'));
    assert.equal(existsSync(textPath(5)), false);
    assert.equal(existsSync(textPath(8)), false);
});


test('gutenbergText, cached', async () => {
    resetCache();
    const base = 'https://raw.githubusercontent.com/GITenberg/';
    const book = (id) => ({'id': String(id), 'title': 'A Book', 'author': 'An Author'});
    const old = qualityVersion - 1;
    writeCache('gitenberg/texts/2.txt.gz', gzipSync(Buffer.from(gutenbergFile('Café crème.'), 'latin1')));
    writeCache('gitenberg/texts/3.txt.gz', gzipSync(Buffer.from('A short text.')));
    const textCache = {
        // Measured with these rules
        '1': {'version': qualityVersion, 'file': '1-0.txt', 'encoding': 'utf-8', 'words': 1234, 'reason': null},

        // Measured with older rules - the cached text measured again (the plain file, Windows-1252)
        '2': {'version': old, 'file': '2.txt', 'encoding': 'utf-8', 'words': 0, 'reason': 'old'},

        // Measured with older rules, cached as "no text file" - downloaded again
        '4': {'version': old, 'file': null, 'encoding': null, 'words': 0, 'reason': 'no text file'},

        // Measured with older rules, its text not cached - downloaded again
        '5': {'version': old, 'file': '5-0.txt', 'encoding': 'utf-8', 'words': 0, 'reason': null}
    };
    const site = {
        [`${base}Book_4/master/4-0.txt`]: () => new Response(gutenbergFile()),
        [`${base}Book_5/master/5.txt`]: () => new Response(gutenbergFile())
    };
    const results = [];
    let {calls} = await withSite(site, async () => {
        for (const id of [1, 2, 4, 5]) {
            results.push(await gutenbergText(book(id), `Book_${id}`, textCache, {'maxAge': 30, 'cacheOnly': false}));
        }
    });
    const text = (file, encoding, words, reason = null) => ({'version': qualityVersion, file, encoding, words, reason});
    assert.deepEqual(results, [
        text('1-0.txt', 'utf-8', 1234),
        text('2.txt', 'windows-1252', 742),
        text('4-0.txt', 'utf-8', 740),
        text('5.txt', 'utf-8', 740)
    ]);
    assert.deepEqual(calls.map(([url]) => url.slice(base.length)), [
        'Book_4/master/4-0.txt', 'Book_5/master/5-0.txt', 'Book_5/master/5.txt'
    ]);

    // Cache-only - an uncached text isn't downloaded, a cached text is measured again
    textCache['3'] = {'version': old, 'file': '3-0.txt', 'encoding': 'utf-8', 'words': 0, 'reason': null};
    results.length = 0;
    ({calls} = await withSite({}, async () => {
        for (const id of [3, 6]) {
            results.push(await gutenbergText(book(id), `Book_${id}`, textCache, {'maxAge': 30, 'cacheOnly': true}));
        }
    }));
    assert.deepEqual(results, [text('3-0.txt', 'utf-8', 8, 'too short'), null]);
    assert.deepEqual(calls, []);
    assert.equal('6' in textCache, false);
});


test('genreQuotas', () => {
    // By the square root of each genre's weight, at least the floor
    assert.deepEqual(genreQuotas({'a': 900, 'b': 100, 'c': 0}, {}, 100, 10), {'a': 75, 'b': 25, 'c': 10});
    assert.deepEqual(genreQuotas({'a': 400, 'b': 100}, {}, 100, 40), {'a': 67, 'b': 40});

    // Rounded
    assert.deepEqual(genreQuotas({'a': 1, 'b': 1, 'c': 1}, {}, 10, 0), {'a': 3, 'b': 3, 'c': 3});

    // A genre's fixed books - kept when over its share, and the other genres share the rest
    assert.deepEqual(genreQuotas({'a': 900, 'b': 100}, {'a': 10, 'b': 20}, 100, 10), {'a': 75, 'b': 25});
    assert.deepEqual(genreQuotas({'a': 900, 'b': 100}, {'b': 40}, 100, 10), {'a': 60, 'b': 40});
    assert.deepEqual(genreQuotas({'a': 400, 'b': 100, 'c': 100}, {'b': 30, 'c': 24}, 100, 0), {'a': 46, 'b': 30, 'c': 24});
    assert.deepEqual(genreQuotas({'a': 1}, {'a': 50}, 10, 0), {'a': 50});

    // No weights - the floor; no weight and no floor - none
    assert.deepEqual(genreQuotas({'a': 0, 'b': 0}, {}, 100, 10), {'a': 10, 'b': 10});
    assert.deepEqual(genreQuotas({'a': 1, 'b': 0}, {}, 10, 0), {'a': 10, 'b': 0});
});
