import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import test, {after, beforeEach, mock} from 'node:test';
import {strict as assert} from 'node:assert';
import {execFile} from 'node:child_process';
import {join} from 'node:path';
import process from 'node:process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';


// The decisions' cache - a temporary directory, set before decide.js is imported (it reads PICOSHELF_CACHE at import)
const tempDir = mkdtempSync(join(tmpdir(), 'picoshelf-decide-'));
process.env.PICOSHELF_CACHE = join(tempDir, 'cache');
const {bookState, cacheDir, catalogBooks, checkModel, decide, decideBooks, decisionModel, root} = await import('../tools/decide.js');


after(() => {
    rmSync(tempDir, {'recursive': true, 'force': true});
});


// Each test starts with an empty cache and Ollama's default address
beforeEach(() => {
    rmSync(process.env.PICOSHELF_CACHE, {'recursive': true, 'force': true});
    delete process.env.OLLAMA_HOST;
});


// Run a test function with a fake fetch (url, body -> response), restoring the real one - returns the fetch calls,
// [url, method, body]
async function withFetch(fakeFetch, fn) {
    const fetchMock = mock.method(
        globalThis, 'fetch', (url, options) => Promise.resolve().then(() => fakeFetch(url, JSON.parse(options.body)))
    );
    try {
        await fn();
    } finally {
        fetchMock.mock.restore();
    }
    return fetchMock.mock.calls.map(({'arguments': [url, options]}) => {
        assert.deepEqual(options.headers, {'Content-Type': 'application/json'});
        return [url, options.method, JSON.parse(options.body)];
    });
}


// A JSON response
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {status, 'headers': {'Content-Type': 'application/json'}});
}


// A fake Ollama - a decision model whose choice is each question's first option, at 0.6 (the others share 0.4)
function fakeOllama(url, body) {
    if (url.endsWith('/api/show')) {
        return jsonResponse({'capabilities': ['completion', 'decision']});
    }
    const answers = {};
    for (const [name, question] of Object.entries(body.questions)) {
        const keys = Object.keys(question.criteria);
        answers[name] = {
            'choice': keys[0],
            'probabilities': Object.fromEntries(keys.map((key, ix) => [key, ix === 0 ? 0.6 : 0.4 / (keys.length - 1)]))
        };
    }
    return jsonResponse({answers});
}


// The test questions
const questions = {
    'color': {'type': 'choice', 'instructions': 'Which color?', 'criteria': {'red': 'Red.', 'blue': 'Blue.'}}
};

// The test decision from the answers
const answer = (answers) => ({'color': answers.color.choice});


// A test book
function testBook(id, title = `Book ${id}`) {
    return {'source': 'test', id, title, 'author': 'An Author', 'subjects': ['Fiction'], 'description': 'A book.'};
}


test('decide, constants', () => {
    assert.equal(decisionModel, 'kev:9b-nvfp4');
    assert.equal(cacheDir, process.env.PICOSHELF_CACHE);
    assert(existsSync(join(root, 'tools', 'decide.js')));
});


test('decide, the default cache directory', async () => {
    // A child process imports decide.js without PICOSHELF_CACHE (it writes nothing)
    const env = {...process.env};
    delete env.PICOSHELF_CACHE;
    const {stdout} = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', 'import {cacheDir} from "./tools/decide.js"; process.stdout.write(cacheDir);'],
        {'cwd': root, env}
    );
    assert.equal(stdout, join(root, 'cache', 'catalog'));
});


test('bookState', () => {
    assert.deepEqual(bookState({
        'title': 'Walden', 'subtitle': 'Or, Life in the Woods', 'author': 'Henry David Thoreau',
        'subjects': ['Nature', 'Solitude'], 'description': 'Two years in a cabin.'
    }), {
        'title': 'Walden: Or, Life in the Woods',
        'author': 'Henry David Thoreau',
        'subjects': 'Nature, Solitude',
        'description': 'Two years in a cabin.'
    });
    assert.deepEqual(bookState({'title': 'Beowulf', 'author': ''}), {
        'title': 'Beowulf', 'author': 'Anonymous', 'subjects': '', 'description': ''
    });
});


test('checkModel', async () => {
    const calls = await withFetch(fakeOllama, async () => {
        await checkModel('test:model');
    });
    assert.deepEqual(calls, [['http://127.0.0.1:11434/api/show', 'POST', {'model': 'test:model'}]]);
});


test('checkModel, OLLAMA_HOST', async () => {
    process.env.OLLAMA_HOST = 'ollama.local:1234';
    let calls = await withFetch(fakeOllama, async () => {
        await checkModel('test:model');
    });
    assert.deepEqual(calls.map(([url]) => url), ['http://ollama.local:1234/api/show']);

    process.env.OLLAMA_HOST = 'https://ollama.example.com';
    calls = await withFetch(fakeOllama, async () => {
        await checkModel('test:model');
    });
    assert.deepEqual(calls.map(([url]) => url), ['https://ollama.example.com/api/show']);
});


test('checkModel, not a decision model', async () => {
    await withFetch(() => jsonResponse({'capabilities': ['completion']}), async () => {
        await assert.rejects(checkModel('chat:model'), {'message': '"chat:model" isn\'t a decision model'});
    });
    await withFetch(() => jsonResponse({}), async () => {
        await assert.rejects(checkModel('chat:model'), {'message': '"chat:model" isn\'t a decision model'});
    });
});


test('checkModel, unknown model', async () => {
    await withFetch(() => jsonResponse({'error': 'model \'missing\' not found'}, 404), async () => {
        await assert.rejects(checkModel('missing'), (error) => {
            assert.equal(
                error.message,
                'Unknown model "missing" - ollama pull missing (Ollama /api/show (404): model \'missing\' not found)'
            );
            assert.equal(error.cause.message, 'Ollama /api/show (404): model \'missing\' not found');
            return true;
        });
    });
});


test('checkModel, Ollama errors', async () => {
    // Not JSON
    await withFetch(() => new Response('Internal Server Error', {'status': 500}), async () => {
        await assert.rejects(checkModel('test:model'), {
            'message': 'Unknown model "test:model" - ollama pull test:model (Ollama /api/show (500): Internal Server Error)'
        });
    });

    // Not JSON, success status - the response truncated
    await withFetch(() => new Response(`<html>${'x'.repeat(300)}`), async () => {
        await assert.rejects(checkModel('test:model'), {
            'message': `Unknown model "test:model" - ollama pull test:model (Ollama /api/show (200): <html>${'x'.repeat(194)})`
        });
    });

    // An error with a success status
    await withFetch(() => jsonResponse({'error': 'busy'}), async () => {
        await assert.rejects(checkModel('test:model'), {
            'message': 'Unknown model "test:model" - ollama pull test:model (Ollama /api/show (200): busy)'
        });
    });

    // JSON, error status, no error message
    await withFetch(() => jsonResponse({'status': 'bad'}, 400), async () => {
        await assert.rejects(checkModel('test:model'), {
            'message': 'Unknown model "test:model" - ollama pull test:model (Ollama /api/show (400): {"status":"bad"})'
        });
    });
});


test('decide', async () => {
    let answers;
    const calls = await withFetch(fakeOllama, async () => {
        answers = await decide(testBook('1'), {'model': 'test:model', questions});
    });
    assert.deepEqual(answers, {'color': {'choice': 'red', 'probabilities': {'red': 0.6, 'blue': 0.4}}});
    assert.deepEqual(calls, [[
        'http://127.0.0.1:11434/v1/systemone',
        'POST',
        {
            'model': 'test:model',
            'state': {'title': 'Book 1', 'author': 'An Author', 'subjects': 'Fiction', 'description': 'A book.'},
            questions,
            'keep_alive': '10m'
        }
    ]]);
});


test('decide, default model', async () => {
    const calls = await withFetch(fakeOllama, async () => {
        await decide(testBook('1'), {questions});
    });
    assert.equal(calls[0][2].model, decisionModel);
});


test('decide, error', async () => {
    await withFetch(() => jsonResponse({'error': 'out of memory'}, 500), async () => {
        await assert.rejects(decide(testBook('1'), {questions}), {'message': 'Ollama /v1/systemone (500): out of memory'});
    });
});


test('decideBooks', async () => {
    const books = [testBook('1'), testBook('2')];
    const logs = [];
    const log = (line) => logs.push(line);

    // Decide each book
    let decisions;
    let calls = await withFetch(fakeOllama, async () => {
        decisions = await decideBooks(books, {
            'model': 'test:model', questions, answer, 'cacheName': 'colors/test', 'label': 'Colors', log
        });
    });
    assert.deepEqual(calls.map(([url]) => url), [
        'http://127.0.0.1:11434/api/show',
        'http://127.0.0.1:11434/v1/systemone',
        'http://127.0.0.1:11434/v1/systemone'
    ]);
    assert.deepEqual(calls.slice(1).map(([, , body]) => body.state.title), ['Book 1', 'Book 2']);
    assert.deepEqual(Object.keys(decisions), ['test|1', 'test|2']);
    assert.equal(decisions['test|1'].color, 'red');
    assert.match(decisions['test|1'].hash, /^[0-9a-f]{16}$/);
    assert.notEqual(decisions['test|1'].hash, decisions['test|2'].hash);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Colors: 2 books \(2 decided with test:model, \d+ ms a book\)$/);

    // The cache file - written whole (no temporary file left)
    const cachePath = join(cacheDir, 'colors', 'test.json');
    assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf-8')), decisions);
    assert(!existsSync(`${cachePath}.tmp`));

    // Decide again - cached
    logs.length = 0;
    let decisions2;
    calls = await withFetch(fakeOllama, async () => {
        decisions2 = await decideBooks(books, {
            'model': 'test:model', questions, answer, 'cacheName': 'colors/test', 'label': 'Colors', log
        });
    });
    assert.deepEqual(calls.map(([url]) => url), ['http://127.0.0.1:11434/api/show']);
    assert.deepEqual(decisions2, decisions);
    assert.deepEqual(logs, ['Colors: 2 books (0 decided with test:model)']);

    // A changed book is decided again, other cached books are kept, and only the books asked for are returned
    let decisions3;
    calls = await withFetch(fakeOllama, async () => {
        decisions3 = await decideBooks(
            [testBook('2', 'Book Two')], {questions, answer, 'cacheName': 'colors/test', 'label': 'Colors'}
        );
    });
    assert.deepEqual(calls.map(([url, , body]) => [url, body.model]), [
        ['http://127.0.0.1:11434/api/show', decisionModel],
        ['http://127.0.0.1:11434/v1/systemone', decisionModel]
    ]);
    assert.deepEqual(Object.keys(decisions3), ['test|2']);
    assert.notEqual(decisions3['test|2'].hash, decisions['test|2'].hash);
    assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf-8')), {'test|1': decisions['test|1'], 'test|2': decisions3['test|2']});

    // Changed questions decide every book again
    calls = await withFetch(fakeOllama, async () => {
        await decideBooks(books, {
            'questions': {'color': {...questions.color, 'instructions': 'Which colour?'}}, answer,
            'cacheName': 'colors/test', 'label': 'Colors'
        });
    });
    assert.equal(calls.length, 3);
});


test('decideBooks, progress', async () => {
    const books = Array.from({'length': 101}, (_unused, ix) => testBook(`${ix}`));
    const logs = [];
    let decisions;
    const calls = await withFetch(fakeOllama, async () => {
        decisions = await decideBooks(books, {
            questions, answer, 'cacheName': 'colors', 'label': 'Colors', 'log': (line) => logs.push(line)
        });
    });
    assert.equal(calls.length, 102);
    assert.equal(Object.keys(decisions).length, 101);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /^Colors: 100 books decided \(\d+ ms a book\)$/);
    assert.match(logs[1], new RegExp(`^Colors: 101 books \\(101 decided with ${decisionModel}, \\d+ ms a book\\)$`));
    assert.equal(Object.keys(JSON.parse(readFileSync(join(cacheDir, 'colors.json'), 'utf-8'))).length, 101);

    // Without a log, a hundred books' progress writes the cache
    rmSync(cacheDir, {'recursive': true, 'force': true});
    await withFetch(fakeOllama, async () => {
        await decideBooks(books, {questions, answer, 'cacheName': 'colors', 'label': 'Colors'});
    });
    assert.equal(Object.keys(JSON.parse(readFileSync(join(cacheDir, 'colors.json'), 'utf-8'))).length, 101);
});


test('decideBooks, not a decision model', async () => {
    const calls = await withFetch(() => jsonResponse({'capabilities': []}), async () => {
        await assert.rejects(
            decideBooks([testBook('1')], {
                'model': 'chat', questions, answer, 'cacheName': 'colors', 'label': 'Colors'
            }),
            {'message': '"chat" isn\'t a decision model'}
        );
    });
    assert.equal(calls.length, 1);
    assert(!existsSync(join(cacheDir, 'colors.json')));
});


test('catalogBooks', () => {
    const catalogPath = join(tempDir, 'catalog.json');
    const books = [testBook('1'), testBook('2')];
    writeFileSync(catalogPath, JSON.stringify({'version': 1, books}));
    process.env.PICOSHELF_CATALOG = catalogPath;
    try {
        assert.deepEqual(catalogBooks(), books);
    } finally {
        delete process.env.PICOSHELF_CATALOG;
    }

    // The catalog - data/catalog.json
    const realBooks = catalogBooks();
    assert(Array.isArray(realBooks));
    assert.deepEqual(realBooks, JSON.parse(readFileSync(join(root, 'data', 'catalog.json'), 'utf-8')).books);
});
