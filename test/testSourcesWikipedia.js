import {articleBook, articleVoice, prepareArticle, searchArticles, source, todaysArticles} from '../lib/sources/wikipedia.js';
import test, {mock} from 'node:test';
import {strict as assert} from 'node:assert';


// Run a test function with a fake fetch (url -> response), restoring the real one - returns the fetch calls,
// [url, options]
async function withFetch(fakeFetch, fn) {
    const fetchMock = mock.method(globalThis, 'fetch', (url, options) => Promise.resolve().then(() => fakeFetch(url, options)));
    try {
        await fn();
    } finally {
        fetchMock.mock.restore();
    }
    return fetchMock.mock.calls.map((call) => call.arguments);
}


// A JSON response
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {status, 'headers': {'Content-Type': 'application/json'}});
}


// The app's request options
const requestOptions = {'headers': {'Api-User-Agent': 'PicoShelf (https://craigahobbs.github.io/picoshelf/)'}};


// A feed page
function feedPage(title, {description = null, thumbnail = null, namespace = 0, canonical = true} = {}) {
    const page = {
        'titles': {'normalized': title, 'canonical': canonical ? title.replaceAll(' ', '_') : undefined},
        'namespace': {'id': namespace}
    };
    if (description !== null) {
        page.description = description;
    }
    if (thumbnail !== null) {
        page.thumbnail = {'source': thumbnail};
    }
    return page;
}


test('wikipedia source, properties', () => {
    assert.equal(source.id, 'wikipedia');
    assert.equal(source.name, 'Wikipedia');
    assert.equal(typeof source.load, 'function');
    assert.equal(articleVoice, 'michael');
});


test('articleBook', () => {
    assert.deepEqual(articleBook({'title': 'Moon', 'description': 'Natural satellite', 'cover': 'https://example.com/moon.jpg'}), {
        'source': 'wikipedia',
        'id': 'Moon',
        'title': 'Moon',
        'author': 'Wikipedia',
        'description': 'Natural satellite',
        'cover': 'https://example.com/moon.jpg',
        'voice': 'michael'
    });
});


test('articleBook, defaults', () => {
    assert.deepEqual(articleBook({'title': 'Moon'}), {
        'source': 'wikipedia',
        'id': 'Moon',
        'title': 'Moon',
        'author': 'Wikipedia',
        'description': '',
        'cover': null,
        'voice': 'michael'
    });
});


test('todaysArticles', async () => {
    const feed = {
        'tfa': feedPage('Featured One', {'description': 'The featured article', 'thumbnail': 'https://example.com/f.jpg'}),
        'mostread': {
            'articles': [
                feedPage('Popular Two'),
                feedPage('Featured One'),
                feedPage('Special:Search', {'namespace': -1}),
                feedPage('No Canonical', {'canonical': false}),
                null,
                feedPage('Popular Three', {'description': 'A third', 'thumbnail': 'https://example.com/3.jpg'})
            ]
        }
    };
    let articles;
    const calls = await withFetch(
        () => jsonResponse(feed),
        async () => {
            articles = await todaysArticles(new Date(2026, 0, 5, 12));
        }
    );
    assert.deepEqual(calls, [['https://en.wikipedia.org/api/rest_v1/feed/featured/2026/01/05', requestOptions]]);
    assert.deepEqual(articles, [
        articleBook({'title': 'Featured One', 'description': 'The featured article', 'cover': 'https://example.com/f.jpg'}),
        articleBook({'title': 'Popular Two'}),
        articleBook({'title': 'Popular Three', 'description': 'A third', 'cover': 'https://example.com/3.jpg'})
    ]);
});


test('todaysArticles, default date', async () => {
    const calls = await withFetch(
        () => jsonResponse({}),
        async () => {
            assert.deepEqual(await todaysArticles(), []);
        }
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /^https:\/\/en\.wikipedia\.org\/api\/rest_v1\/feed\/featured\/\d{4}\/\d{2}\/\d{2}$/);
});


test('todaysArticles, yesterday', async () => {
    // Today's feed isn't published yet - yesterday's is used
    let articles;
    const calls = await withFetch(
        (url) => (url.endsWith('/2026/11/01') ? jsonResponse({}, 404) : jsonResponse({'tfa': feedPage('Yesterday')})),
        async () => {
            articles = await todaysArticles(new Date(2026, 10, 1, 12));
        }
    );
    assert.deepEqual(calls.map(([url]) => url), [
        'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/11/01',
        'https://en.wikipedia.org/api/rest_v1/feed/featured/2026/10/31'
    ]);
    assert.deepEqual(articles, [articleBook({'title': 'Yesterday'})]);
});


test('todaysArticles, error', async () => {
    const calls = await withFetch(
        (url) => jsonResponse({}, url.endsWith('/2026/03/10') ? 404 : 500),
        async () => {
            await assert.rejects(todaysArticles(new Date(2026, 2, 10, 12)), {
                'message': 'Wikipedia couldn\'t be reached (error 500) - try again later.'
            });
        }
    );
    assert.equal(calls.length, 2);
});


test('todaysArticles, offline', async () => {
    await withFetch(
        () => {
            throw new TypeError('Failed to fetch');
        },
        async () => {
            await assert.rejects(todaysArticles(new Date(2026, 2, 10, 12)), {
                'message': 'Couldn\'t reach Wikipedia - check your connection and try again.'
            });
        }
    );
});


test('searchArticles', async () => {
    const data = {
        'continue': {'gsroffset': 24, 'continue': 'gsroffset||'},
        'query': {
            'pages': [
                {'pageid': 2, 'title': 'Moon landing', 'index': 2, 'description': 'Arrival on the Moon'},
                {'pageid': 1, 'title': 'Moon', 'index': 1, 'thumbnail': {'source': 'https://example.com/moon.jpg'}}
            ]
        }
    };
    let result;
    const calls = await withFetch(
        () => jsonResponse(data),
        async () => {
            result = await searchArticles('moon');
        }
    );
    assert.equal(calls.length, 1);
    const [[url, options]] = calls;
    assert.deepEqual(options, requestOptions);
    const parsed = new URL(url);
    assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://en.wikipedia.org/w/api.php');
    assert.deepEqual(Object.fromEntries(parsed.searchParams), {
        'action': 'query',
        'generator': 'search',
        'gsrsearch': 'moon',
        'gsrnamespace': '0',
        'gsrlimit': '24',
        'gsroffset': '0',
        'prop': 'description|pageimages',
        'piprop': 'thumbnail',
        'pithumbsize': '200',
        'format': 'json',
        'formatversion': '2',
        'origin': '*'
    });
    assert.deepEqual(result, {
        'books': [
            articleBook({'title': 'Moon', 'cover': 'https://example.com/moon.jpg'}),
            articleBook({'title': 'Moon landing', 'description': 'Arrival on the Moon'})
        ],
        'next': 24
    });
});


test('searchArticles, last page', async () => {
    let result;
    const calls = await withFetch(
        () => jsonResponse({'query': {'pages': [{'title': 'Moon', 'index': 49}]}}),
        async () => {
            result = await searchArticles('moon', 48, 12);
        }
    );
    const params = new URL(calls[0][0]).searchParams;
    assert.equal(params.get('gsroffset'), '48');
    assert.equal(params.get('gsrlimit'), '12');
    assert.deepEqual(result, {'books': [articleBook({'title': 'Moon'})], 'next': null});
});


test('searchArticles, no results', async () => {
    await withFetch(
        () => jsonResponse({'batchcomplete': true}),
        async () => {
            assert.deepEqual(await searchArticles('xyzzy'), {'books': [], 'next': null});
        }
    );
});


test('prepareArticle', () => {
    const extract = [
        'The Moon is   Earth\'s only natural satellite.',
        '',
        'It orbits at about 384,400 km.',
        '',
        '== Name and etymology ==',
        'The usual English proper name is "Moon".',
        '',
        '== Natural history ==',
        '',
        '=== Formation ===',
        'The Moon formed 4.51 billion years ago.',
        '=== Empty subsection ===',
        '',
        '== Why the Moon? ==',
        'Because it is there.',
        '== See also ==',
        'Lunar phase',
        '=== Lists ===',
        'List of moons',
        '== References ==',
        '== Further reading ==',
        'A book.'
    ].join('\n');
    const result = prepareArticle('Moon', extract);
    assert.deepEqual(result, {
        'text': [
            'Moon.',
            'The Moon is Earth\'s only natural satellite.',
            'It orbits at about 384,400 km.',
            'Name and etymology.',
            'The usual English proper name is "Moon".',
            'Natural history.',
            'Formation.',
            'The Moon formed 4.51 billion years ago.',
            'Why the Moon?',
            'Because it is there.'
        ].join('\n\n'),
        'chapters': [
            {'title': 'Moon', 'char': 0, 'level': 1},
            {'title': 'Name and etymology', 'char': 84, 'level': 1},
            {'title': 'Natural history', 'char': 147, 'level': 1},
            {'title': 'Formation', 'char': 165, 'level': 2},
            {'title': 'Why the Moon?', 'char': 218, 'level': 1}
        ],
        'title': 'Moon',
        'author': 'Wikipedia'
    });
    for (const chapter of result.chapters) {
        assert.ok(result.text.startsWith(chapter.title, chapter.char));
    }
});


test('prepareArticle, title with punctuation', () => {
    assert.deepEqual(prepareArticle('Who Framed Roger Rabbit?', 'A film.\n== Plot ==\n'), {
        'text': 'Who Framed Roger Rabbit?\n\nA film.',
        'chapters': [{'title': 'Who Framed Roger Rabbit?', 'char': 0, 'level': 1}],
        'title': 'Who Framed Roger Rabbit?',
        'author': 'Wikipedia'
    });
});


test('wikipedia source, load', async () => {
    const extract = 'Paris is the capital of France.\n\n== History ==\nParis was founded long ago.';
    const progress = [];
    let result;
    const calls = await withFetch(
        () => jsonResponse({'query': {'pages': [{'pageid': 1, 'title': 'Paris', extract}]}}),
        async () => {
            result = await source.load(articleBook({'title': 'Paris, France'}), (loaded, total) => {
                progress.push([loaded, total]);
            });
        }
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], requestOptions);
    assert.deepEqual(Object.fromEntries(new URL(calls[0][0]).searchParams), {
        'action': 'query',
        'prop': 'extracts',
        'explaintext': '1',
        'exsectionformat': 'wiki',
        'redirects': '1',
        'titles': 'Paris, France',
        'format': 'json',
        'formatversion': '2',
        'origin': '*'
    });
    assert.deepEqual(result, prepareArticle('Paris', extract));
    assert.deepEqual(progress, [[extract.length, null]]);
});


test('wikipedia source, load default progress', async () => {
    await withFetch(
        () => jsonResponse({'query': {'pages': [{'title': 'Paris', 'extract': 'Paris is a city.'}]}}),
        async () => {
            assert.deepEqual(await source.load(articleBook({'title': 'Paris'})), prepareArticle('Paris', 'Paris is a city.'));
        }
    );
});


test('wikipedia source, load missing', async () => {
    const message = 'This article isn\'t on Wikipedia.';
    for (const data of [
        {},
        {'query': {}},
        {'query': {'pages': []}},
        {'query': {'pages': [{'title': 'Nowhere', 'missing': true}]}},
        {'query': {'pages': [{'title': 'Nowhere', 'extract': ''}]}}
    ]) {
        await withFetch(
            () => jsonResponse(data),
            async () => {
                await assert.rejects(source.load(articleBook({'title': 'Nowhere'})), {message});
            }
        );
    }
});


test('wikipedia source, load error', async () => {
    await withFetch(
        () => jsonResponse({}, 429),
        async () => {
            await assert.rejects(source.load(articleBook({'title': 'Paris'})), {
                'message': 'Wikipedia couldn\'t be reached (error 429) - try again later.'
            });
        }
    );
});
