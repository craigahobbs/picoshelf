import {cacheDir, fakeOllama, jsonResponse, root, tempDir, withOllama} from './toolsHelpers.js';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import test, {beforeEach} from 'node:test';
import {strict as assert} from 'node:assert';
import {execFile} from 'node:child_process';
import {join} from 'node:path';
import process from 'node:process';
import {promisify} from 'node:util';


// The tools - imported after toolsHelpers.js sets their cache directory
const {
    bookState, 'cacheDir': decideCacheDir, catalogBooks, checkModel, decide, decideBooks, decisionModel, readJSONCache, writeFileAtomic
} = await import('../tools/decide.js');


// Each test starts with an empty cache and Ollama's default address
beforeEach(() => {
    rmSync(cacheDir, {'recursive': true, 'force': true});
    delete process.env.OLLAMA_HOST;
});


// The fake Ollama - each question's first option at 0.6
const ollama = fakeOllama();


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
    assert.equal(decideCacheDir, cacheDir);
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


test('writeFileAtomic and readJSONCache', () => {
    assert.deepEqual(readJSONCache('sub/test.json'), {});
    writeFileAtomic(join(cacheDir, 'sub', 'test.json'), '{"a": 1}');
    assert.deepEqual(readJSONCache('sub/test.json'), {'a': 1});
    assert.equal(existsSync(join(cacheDir, 'sub', 'test.json.tmp')), false);
});


test('checkModel', async () => {
    const calls = await withOllama(ollama, async () => {
        await checkModel('test:model');
    });
    assert.deepEqual(calls, [['http://127.0.0.1:11434/api/show', {'model': 'test:model'}]]);
});


test('checkModel, OLLAMA_HOST', async () => {
    process.env.OLLAMA_HOST = 'ollama.local:1234';
    let calls = await withOllama(ollama, async () => {
        await checkModel('test:model');
    });
    assert.deepEqual(calls.map(([url]) => url), ['http://ollama.local:1234/api/show']);

    process.env.OLLAMA_HOST = 'https://ollama.example.com';
    calls = await withOllama(ollama, async () => {
        await checkModel('test:model');
    });
    assert.deepEqual(calls.map(([url]) => url), ['https://ollama.example.com/api/show']);
});


test('checkModel, not a decision model', async () => {
    await withOllama(ollama, async () => {
        await assert.rejects(checkModel('chat'), {'message': '"chat" isn\'t a decision model'});
    });
    await withOllama(() => jsonResponse({}), async () => {
        await assert.rejects(checkModel('chat:model'), {'message': '"chat:model" isn\'t a decision model'});
    });
});


test('checkModel, unknown model', async () => {
    await withOllama(ollama, async () => {
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
    await withOllama(() => new Response('Internal Server Error', {'status': 500}), async () => {
        await assert.rejects(checkModel('test:model'), {
            'message': 'Unknown model "test:model" - ollama pull test:model (Ollama /api/show (500): Internal Server Error)'
        });
    });

    // Not JSON, success status - the response truncated
    await withOllama(() => new Response(`<html>${'x'.repeat(300)}`), async () => {
        await assert.rejects(checkModel('test:model'), {
            'message': `Unknown model "test:model" - ollama pull test:model (Ollama /api/show (200): <html>${'x'.repeat(194)})`
        });
    });

    // An error with a success status
    await withOllama(() => jsonResponse({'error': 'busy'}), async () => {
        await assert.rejects(checkModel('test:model'), {
            'message': 'Unknown model "test:model" - ollama pull test:model (Ollama /api/show (200): busy)'
        });
    });

    // JSON, error status, no error message
    await withOllama(() => jsonResponse({'status': 'bad'}, 400), async () => {
        await assert.rejects(checkModel('test:model'), {
            'message': 'Unknown model "test:model" - ollama pull test:model (Ollama /api/show (400): {"status":"bad"})'
        });
    });
});


test('decide', async () => {
    let answers;
    const calls = await withOllama(ollama, async () => {
        answers = await decide(testBook('1'), {'model': 'test:model', questions});
    });
    assert.deepEqual(answers, {'color': {'choice': 'red', 'probabilities': {'red': 0.6, 'blue': 0.4}}});
    assert.deepEqual(calls, [[
        'http://127.0.0.1:11434/v1/systemone',
        {
            'model': 'test:model',
            'state': {'title': 'Book 1', 'author': 'An Author', 'subjects': 'Fiction', 'description': 'A book.'},
            questions,
            'keep_alive': '10m'
        }
    ]]);
});


test('decide, error', async () => {
    await withOllama(() => jsonResponse({'error': 'out of memory'}, 500), async () => {
        await assert.rejects(
            decide(testBook('1'), {'model': 'test:model', questions}), {'message': 'Ollama /v1/systemone (500): out of memory'}
        );
    });
});


test('decideBooks', async () => {
    const books = [testBook('1'), testBook('2')];
    const logs = [];
    const log = (line) => logs.push(line);

    // Decide each book
    let decisions;
    let calls = await withOllama(ollama, async () => {
        decisions = await decideBooks(books, {
            'model': 'test:model', questions, answer, 'cacheName': 'colors/test', 'label': 'Colors', log
        });
    });
    assert.deepEqual(calls.map(([url]) => url), [
        'http://127.0.0.1:11434/api/show',
        'http://127.0.0.1:11434/v1/systemone',
        'http://127.0.0.1:11434/v1/systemone'
    ]);
    assert.deepEqual(calls.slice(1).map(([, body]) => body.state.title), ['Book 1', 'Book 2']);
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
    calls = await withOllama(ollama, async () => {
        decisions2 = await decideBooks(books, {
            'model': 'test:model', questions, answer, 'cacheName': 'colors/test', 'label': 'Colors', log
        });
    });
    assert.deepEqual(calls.map(([url]) => url), ['http://127.0.0.1:11434/api/show']);
    assert.deepEqual(decisions2, decisions);
    assert.deepEqual(logs, ['Colors: 2 books (0 decided with test:model)']);

    // A changed book is decided again, other cached books are kept, and only the books asked for are returned
    let decisions3;
    calls = await withOllama(ollama, async () => {
        decisions3 = await decideBooks(
            [testBook('2', 'Book Two')], {'model': 'test:model', questions, answer, 'cacheName': 'colors/test', 'label': 'Colors', log}
        );
    });
    assert.deepEqual(calls.map(([url]) => url), ['http://127.0.0.1:11434/api/show', 'http://127.0.0.1:11434/v1/systemone']);
    assert.deepEqual(Object.keys(decisions3), ['test|2']);
    assert.notEqual(decisions3['test|2'].hash, decisions['test|2'].hash);
    assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf-8')), {'test|1': decisions['test|1'], 'test|2': decisions3['test|2']});

    // Changed questions decide every book again
    calls = await withOllama(ollama, async () => {
        await decideBooks(books, {
            'model': 'test:model', 'questions': {'color': {...questions.color, 'instructions': 'Which colour?'}}, answer,
            'cacheName': 'colors/test', 'label': 'Colors', log
        });
    });
    assert.equal(calls.length, 3);
});


test('decideBooks, progress', async () => {
    const books = Array.from({'length': 101}, (_unused, ix) => testBook(`${ix}`));
    const logs = [];
    let decisions;
    const calls = await withOllama(ollama, async () => {
        decisions = await decideBooks(books, {
            'model': 'test:model', questions, answer, 'cacheName': 'colors', 'label': 'Colors', 'log': (line) => logs.push(line)
        });
    });
    assert.equal(calls.length, 102);
    assert.equal(Object.keys(decisions).length, 101);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /^Colors: 100 books decided \(\d+ ms a book\)$/);
    assert.match(logs[1], /^Colors: 101 books \(101 decided with test:model, \d+ ms a book\)$/);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(cacheDir, 'colors.json'), 'utf-8'))).length, 101);
});


test('decideBooks, not a decision model', async () => {
    const calls = await withOllama(ollama, async () => {
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
