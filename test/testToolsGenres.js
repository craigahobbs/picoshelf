import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import test, {after, before, beforeEach, mock} from 'node:test';
import {strict as assert} from 'node:assert';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {join} from 'node:path';
import process from 'node:process';
import {tmpdir} from 'node:os';


// The decisions' cache - a temporary directory, set before the tools are imported (decide.js reads PICOSHELF_CACHE at
// import)
const tempDir = mkdtempSync(join(tmpdir(), 'picoshelf-genres-'));
process.env.PICOSHELF_CACHE = join(tempDir, 'cache');
delete process.env.OLLAMA_HOST;
const {cacheDir, decisionModel, root} = await import('../tools/decide.js');
const {bookGenres, genreMinimum, genreNames, genreOthers, genreShare, genres} = await import('../tools/genres.js');


// Each book's genre probabilities from the fake decision model, by title - the others share what's left
const bookProbabilities = {
    // Two others at least a quarter of the choice's - the third left out
    'Emma': {'romance': 0.5, 'humor': 0.2, 'fiction': 0.15, 'historical': 0.13},
    // An other less than genreMinimum (though more than a quarter of the choice's)
    'Dracula': {'horror': 0.3, 'fantasy': 0.11},
    // An other less than a quarter of the choice's (though more than genreMinimum)
    'Walden: Or, Life in the Woods': {'science': 0.8, 'travel': 0.19}
};


// A fake Ollama's response to a request - [status, response]
function ollamaResponse(path, body) {
    if (path === '/api/show') {
        if (body.model === 'missing') {
            return [404, {'error': `model '${body.model}' not found`}];
        }
        return [200, {'capabilities': body.model === 'chat' ? ['completion'] : ['completion', 'decision']}];
    }
    const keys = Object.keys(body.questions.genre.criteria);
    const given = bookProbabilities[body.state.title];
    const givenTotal = Object.values(given).reduce((total, probability) => total + probability, 0);
    const rest = (1 - givenTotal) / keys.filter((key) => !(key in given)).length;
    const probabilities = Object.fromEntries(keys.map((key) => [key, given[key] ?? rest]));
    const [choice] = Object.keys(given);
    return [200, {'answers': {'genre': {choice, probabilities}}}];
}


// Run a test function with a fake Ollama fetch - returns the fetch calls, [url, body]
async function withFetch(fn) {
    const fetchMock = mock.method(globalThis, 'fetch', (url, options) => {
        const [status, response] = ollamaResponse(new URL(url).pathname, JSON.parse(options.body));
        return Promise.resolve(new Response(JSON.stringify(response), {status, 'headers': {'Content-Type': 'application/json'}}));
    });
    try {
        await fn();
    } finally {
        fetchMock.mock.restore();
    }
    return fetchMock.mock.calls.map(({'arguments': [url, options]}) => [url, JSON.parse(options.body)]);
}


// A fake Ollama server, for the command line's child processes
const serverRequests = [];
const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => {
        text += chunk;
    });
    request.on('end', () => {
        const body = JSON.parse(text);
        serverRequests.push([request.method, request.url, body]);
        const [status, result] = ollamaResponse(request.url, body);
        response.writeHead(status, {'Content-Type': 'application/json'});
        response.end(JSON.stringify(result));
    });
});
let ollamaHost;


// The test catalog
const catalogPath = join(tempDir, 'catalog.json');
const catalogBooks = [
    {'source': 'test', 'id': '1', 'title': 'Emma', 'author': 'Jane Austen', 'subjects': ['Fiction'], 'description': 'A matchmaker.'},
    {'source': 'test', 'id': '2', 'title': 'Dracula', 'author': 'Bram Stoker'},
    {'source': 'test', 'id': '3', 'title': 'Walden', 'subtitle': 'Or, Life in the Woods', 'author': 'Henry David Thoreau'}
];


before(async () => {
    writeFileSync(catalogPath, JSON.stringify({'books': catalogBooks}));
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    ollamaHost = `127.0.0.1:${server.address().port}`;
});


after(async () => {
    await new Promise((resolve) => {
        server.close(resolve);
    });
    rmSync(tempDir, {'recursive': true, 'force': true});
});


beforeEach(() => {
    rmSync(cacheDir, {'recursive': true, 'force': true});
    serverRequests.length = 0;
});


// Run genres.js - {code, stdout, stderr}
function runGenres(args) {
    const env = {...process.env, 'OLLAMA_HOST': ollamaHost, 'PICOSHELF_CATALOG': catalogPath};
    return new Promise((resolve) => {
        execFile(process.execPath, [join(root, 'tools', 'genres.js'), ...args], {env}, (error, stdout, stderr) => {
            resolve({'code': error?.code ?? 0, stdout, stderr});
        });
    });
}


test('genres', () => {
    assert.equal(Object.keys(genres).length, 23);
    assert.deepEqual(genres.scifi, [
        'Science Fiction', 'Science Fiction - the future, space, invention, and other worlds imagined from science.'
    ]);
    assert.equal(genreShare, 0.25);
    assert.equal(genreMinimum, 0.12);
    assert.equal(genreOthers, 2);
});


test('genreNames', () => {
    const names = genreNames();
    assert.deepEqual(Object.keys(names), Object.keys(genres));
    assert.equal(names.biography, 'Biography & Memoir');
    assert.equal(names.childrens, 'Children\'s');
    assert.equal(names.nonfiction, 'Practical & Reference');
});


test('bookGenres', async () => {
    const logs = [];
    let bookGenresResult;
    const calls = await withFetch(async () => {
        bookGenresResult = await bookGenres(catalogBooks, {'model': 'test:model', 'log': (line) => logs.push(line)});
    });
    assert.deepEqual(bookGenresResult, {
        'test|1': ['romance', 'humor', 'fiction'],
        'test|2': ['horror'],
        'test|3': ['science']
    });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Genres: 3 books \(3 decided with test:model, \d+ ms a book\)$/);

    // The genre question
    assert.deepEqual(calls[0], ['http://127.0.0.1:11434/api/show', {'model': 'test:model'}]);
    const [, [url, body]] = calls;
    assert.equal(url, 'http://127.0.0.1:11434/v1/systemone');
    assert.equal(body.model, 'test:model');
    assert.deepEqual(body.state, {'title': 'Emma', 'author': 'Jane Austen', 'subjects': 'Fiction', 'description': 'A matchmaker.'});
    assert.equal(body.questions.genre.type, 'choice');
    assert.equal(body.questions.genre.instructions, 'Which genre best describes this book?');
    assert.equal(body.questions.genre.criteria.poetry, 'Poetry - poems and verse.');
    assert.deepEqual(Object.keys(body.questions.genre.criteria), Object.keys(genres));
    assert.equal(calls[3][1].state.title, 'Walden: Or, Life in the Woods');

    // The cache - each book's genres and probabilities, by model
    const cache = JSON.parse(readFileSync(join(cacheDir, 'genres', 'test_model.json'), 'utf-8'));
    assert.deepEqual(cache['test|1'].genres, ['romance', 'humor', 'fiction']);
    assert.equal(cache['test|1'].probabilities.romance, 0.5);
    assert.equal(Object.keys(cache['test|1'].probabilities).length, 23);
});


test('bookGenres, default model', async () => {
    let bookGenresResult;
    const calls = await withFetch(async () => {
        bookGenresResult = await bookGenres(catalogBooks.slice(0, 1));
    });
    assert.deepEqual(bookGenresResult, {'test|1': ['romance', 'humor', 'fiction']});
    assert.deepEqual(calls.map(([, body]) => body.model), [decisionModel, decisionModel]);
    assert(existsSync(join(cacheDir, 'genres', 'kev_9b-nvfp4.json')));
});


test('genres.js --book', async () => {
    const result = await runGenres(['--model', 'test:model', '--book', 'EMMA']);
    assert.deepEqual(result, {
        'code': 0,
        'stdout': 'Emma (Jane Austen): romance, humor, fiction - romance 50%, humor 20%, fiction 15%, historical 13%\n',
        'stderr': ''
    });
    assert.deepEqual(serverRequests.map(([method, url, body]) => [method, url, body.model]), [
        ['POST', '/api/show', 'test:model'],
        ['POST', '/v1/systemone', 'test:model']
    ]);

    // Nothing cached
    assert(!existsSync(cacheDir));
});


test('genres.js, all books', async () => {
    const result = await runGenres([]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.stdout.split('\n'), [
        'Emma (Jane Austen): romance, humor, fiction - romance 50%, humor 20%, fiction 15%, historical 13%',
        'Dracula (Bram Stoker): horror - horror 30%, fantasy 11%, adventure 3%, biography 3%',
        'Walden (Henry David Thoreau): science - science 80%, travel 19%, adventure 0%, biography 0%',
        ''
    ]);
    assert.deepEqual(serverRequests.map(([, url, body]) => [url, body.model]), [
        ['/api/show', decisionModel],
        ['/v1/systemone', decisionModel],
        ['/v1/systemone', decisionModel],
        ['/v1/systemone', decisionModel]
    ]);
});


test('genres.js, not a decision model', async () => {
    const result = await runGenres(['--model', 'chat']);
    assert.deepEqual(result, {'code': 1, 'stdout': '', 'stderr': 'error: "chat" isn\'t a decision model\n'});
    assert.equal(serverRequests.length, 1);
});


test('genres.js, unknown model', async () => {
    const result = await runGenres(['--model', 'missing', '--book', 'Emma']);
    assert.deepEqual(result, {
        'code': 1,
        'stdout': '',
        'stderr': 'error: Unknown model "missing" - ollama pull missing (Ollama /api/show (404): model \'missing\' not found)\n'
    });
});


test('genres.js, unknown argument', async () => {
    const result = await runGenres(['--bogus']);
    assert.deepEqual(result, {'code': 1, 'stdout': '', 'stderr': 'error: Unknown argument "--bogus"\n'});
    assert.equal(serverRequests.length, 0);
});
