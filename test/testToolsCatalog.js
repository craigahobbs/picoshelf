import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync} from 'node:fs';
import test, {after, mock} from 'node:test';
import {strict as assert} from 'node:assert';
import {join} from 'node:path';
import os from 'node:os';
import process from 'node:process';


// The catalog builder's cache, a temporary directory - set before the builder (tools/decide.js) is imported
const cacheDir = mkdtempSync(join(os.tmpdir(), 'picoshelf-catalog-'));
process.env.PICOSHELF_CACHE = cacheDir;
const {
    catalogJSON, collapseSpace, fetchCached, fetchRetry, gitenbergRepositories, gutenbergAuthor, gutenbergDescription,
    gutenbergSubjects, gutenbergTitle, gutenbergWords, isReferenceWork, log, parseArgs, readJSONCache, resolveText,
    searchRepository, services, surnameKeys, titleCase, titleKey, trimDescription, uniqueSubjects, writeFileAtomic
} = await import('../tools/catalog.js');
after(() => {
    rmSync(cacheDir, {'recursive': true, 'force': true});
});


// Empty the cache directory
function resetCache() {
    rmSync(cacheDir, {'recursive': true, 'force': true});
    mkdirSync(cacheDir, {'recursive': true});
}


// The fake clock - it moves only forward, so the builder's per-host throttle times stay in order across tests
let clock = Date.now();


// Run a test function with a fake fetch (url, options -> response), a fake clock that a fake sleep advances, and
// captured output - returns the fetch calls ([url, options]), the sleeps (milliseconds), and the output lines. The clock
// starts an hour past the last test's, on a second, so no host's throttle carries over.
async function withSite(fakeFetch, fn) {
    clock = Math.ceil(clock / 1000) * 1000 + 3600000;
    const fetchMock = mock.method(globalThis, 'fetch', (url, options) => Promise.resolve().then(() => fakeFetch(url, options)));
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
    return {
        'calls': fetchMock.mock.calls.map((call) => call.arguments),
        'sleeps': sleepMock.mock.calls.map((call) => call.arguments[0]),
        output
    };
}


// A response with a URL (a fetched response's - a constructed one's is empty)
function urlResponse(url, body, init) {
    const response = new Response(body, init);
    Object.defineProperty(response, 'url', {'value': url});
    return response;
}


//
// Command line and logging
//


test('parseArgs, defaults', () => {
    const options = parseArgs([]);
    assert.equal(options.gutenberg, 1000);
    assert.equal(options.standardebooks, Infinity);
    assert.equal(options.maxAge, 30);
    assert.equal(options.cacheOnly, false);
    assert.equal(options.voiceModel, 'kev:9b-nvfp4');
    assert.match(options.output, /data[/\\]catalog\.json$/);
});


test('parseArgs, arguments', () => {
    assert.deepEqual(
        parseArgs([
            '--gutenberg', '10', '--standardebooks', '5', '--max-age', '0', '--cache-only', '--voice-model', 'test:1b',
            '-o', 'out.json'
        ]),
        {'gutenberg': 10, 'standardebooks': 5, 'maxAge': 0, 'cacheOnly': true, 'output': 'out.json', 'voiceModel': 'test:1b'}
    );
});


test('parseArgs, errors', () => {
    assert.throws(() => parseArgs(['--bogus']), {'message': 'Unknown argument "--bogus"'});
    assert.throws(() => parseArgs(['--gutenberg', 'many']), {'message': 'Invalid gutenberg "NaN"'});
    assert.throws(() => parseArgs(['--standardebooks', '-1']), {'message': 'Invalid standardebooks "-1"'});
    assert.throws(() => parseArgs(['--max-age']), {'message': 'Invalid maxAge "NaN"'});
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


test('gutenbergWords', () => {
    assert.equal(gutenbergWords(598000), 100000);
    assert.equal(gutenbergWords(18100), 100);
    assert.equal(gutenbergWords(0), null);
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
// Files
//


test('writeFileAtomic and readJSONCache', () => {
    resetCache();
    assert.deepEqual(readJSONCache('sub/test.json'), {});
    writeFileAtomic(join(cacheDir, 'sub', 'test.json'), '{"a": 1}');
    assert.deepEqual(readJSONCache('sub/test.json'), {'a': 1});
    assert.equal(existsSync(join(cacheDir, 'sub', 'test.json.tmp')), false);
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

        // Standard Ebooks - 500 ms apart; Gutendex - a second apart
        await fetchRetry('https://gutendex.com/books/?page=1');
        await fetchRetry('https://gutendex.com/books/?page=2');
    });
    assert.deepEqual(sleeps, [500, 1000]);
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


// Set or delete (undefined) the GitHub token
function setToken(token) {
    if (token === undefined) {
        delete process.env.GITHUB_TOKEN;
    } else {
        process.env.GITHUB_TOKEN = token;
    }
}


test('searchRepository', async () => {
    resetCache();
    const {GITHUB_TOKEN} = process.env;
    setToken(undefined);
    const searchCache = new Map([['5', 'Cached_5']]);
    const results = [];
    const resetHeader = () => String(Date.now() / 1000 + 30);
    const responses = [
        // Found, with searches left
        () => new Response(JSON.stringify({'items': [{'name': 'Other_1100'}, {'name': 'Book_100'}]}), {
            'headers': {'X-RateLimit-Remaining': '9'}
        }),
        // Not found - the limit exhausted, its reset past
        () => new Response(JSON.stringify({'items': [{'name': 'Book_1010'}]}), {
            'headers': {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1000'}
        })
    ];
    let {calls, sleeps, output} = await withSite(() => responses.shift()(), async () => {
        results.push(await searchRepository('5', searchCache));
        results.push(await searchRepository('100', searchCache));
        results.push(await searchRepository('101', searchCache));
    });
    assert.deepEqual(results, ['Cached_5', 'Book_100', null]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'https://api.github.com/search/repositories?q=_100+in%3Aname+org%3AGITenberg&per_page=100');
    assert.deepEqual(calls[0][1].headers, {'User-Agent': calls[0][1].headers['User-Agent'], 'Accept': 'application/vnd.github+json'});
    assert.deepEqual(sleeps, [1000]);
    assert.deepEqual(output, []);
    assert.deepEqual(readJSONCache('gitenberg/search.json'), {'5': 'Cached_5', '100': 'Book_100', '101': null});

    // Rate limited (a reset time, a reset time past, no reset time), then the limit exhausted
    setToken('token');
    responses.push(
        () => new Response('Limited', {'status': 403, 'headers': {'X-RateLimit-Reset': resetHeader()}}),
        () => new Response(null, {'status': 403, 'headers': {'X-RateLimit-Reset': '1000'}}),
        () => new Response(null, {'status': 403}),
        () => new Response(JSON.stringify({'items': [{'name': 'Book_102'}]}), {
            'headers': {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': resetHeader()}
        })
    );
    try {
        ({calls, sleeps, output} = await withSite(() => responses.shift()(), async () => {
            results.push(await searchRepository('102', searchCache));
        }));
    } finally {
        setToken(GITHUB_TOKEN);
    }
    assert.equal(results[3], 'Book_102');
    assert.equal(calls.length, 4);
    assert.equal(calls[0][1].headers.Authorization, 'Bearer token');
    assert.deepEqual(sleeps, [31000, 1000, 61000, 31000]);
    assert.deepEqual(output, [
        '  GitHub search rate limit - waiting 31 s',
        '  GitHub search rate limit - waiting 1 s',
        '  GitHub search rate limit - waiting 61 s',
        '  GitHub search rate limit - waiting 31 s'
    ]);
    assert.deepEqual(readJSONCache('gitenberg/search.json'), {'5': 'Cached_5', '100': 'Book_100', '101': null, '102': 'Book_102'});
});


test('searchRepository, error', async () => {
    resetCache();
    await withSite(() => new Response('{}', {'status': 422}), async () => {
        await assert.rejects(searchRepository('7', new Map()), {'message': 'GitHub search: error 422'});
    });
});


test('resolveText', async () => {
    const base = 'https://raw.githubusercontent.com/GITenberg/';
    const site = {
        // The UTF-8 file, redirected
        [`${base}Book_1/master/1-0.txt`]: () => urlResponse('https://example.com/1-0.txt', null, {'headers': {'Content-Length': '598000'}}),

        // The plain file - UTF-8, and Windows-1252
        [`${base}Book_2/master/2.txt`]: (options) => new Response(options.method === 'HEAD' ? null : 'Café'),
        [`${base}Book_3/master/3.txt`]: (options) => new Response(
            options.method === 'HEAD' ? null : new Uint8Array([0x43, 0x61, 0x66, 0xe9])
        ),

        // The Latin-1 file
        [`${base}Book_4/master/4-8.txt`]: () => new Response(null, {'headers': {'Content-Length': '1000'}}),

        // An error
        [`${base}Book_6/master/6-0.txt`]: () => new Response(null, {'status': 403})
    };
    const results = [];
    const {calls} = await withSite((url, options) => site[url]?.(options) ?? new Response(null, {'status': 404}), async () => {
        for (const id of ['1', '2', '3', '4', '5']) {
            results.push(await resolveText(id, `Book_${id}`));
        }
        await assert.rejects(resolveText('6', 'Book_6'), {'message': `${base}Book_6/master/6-0.txt: error 403`});
    });
    assert.deepEqual(results, [
        {'url': 'https://example.com/1-0.txt', 'encoding': 'utf-8', 'bytes': 598000},
        {'url': `${base}Book_2/master/2.txt`, 'encoding': 'utf-8', 'bytes': 0},
        {'url': `${base}Book_3/master/3.txt`, 'encoding': 'windows-1252', 'bytes': 0},
        {'url': `${base}Book_4/master/4-8.txt`, 'encoding': 'windows-1252', 'bytes': 1000},
        null
    ]);
    assert.deepEqual(calls.slice(0, 3).map(([url, options]) => [url, options.method, options.headers['Accept-Encoding']]), [
        [`${base}Book_1/master/1-0.txt`, 'HEAD', 'identity'],
        [`${base}Book_2/master/2-0.txt`, 'HEAD', 'identity'],
        [`${base}Book_2/master/2.txt`, 'HEAD', 'identity']
    ]);
    assert.equal(calls[3][1].method, 'GET');
    assert.equal(calls.length, 14);
});
