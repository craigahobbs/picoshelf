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
const tempDir = mkdtempSync(join(tmpdir(), 'picoshelf-voicecast-'));
process.env.PICOSHELF_CACHE = join(tempDir, 'cache');
delete process.env.OLLAMA_HOST;
const {cacheDir, decisionModel, root} = await import('../tools/decide.js');
const {castBook, castBooks, castModel, castScheme, castVoices} = await import('../tools/voicecast.js');


// The voices by sex
const femaleVoices = ['sarah', 'helen', 'amy', 'kate', 'grace'];
const maleVoices = ['james', 'robert', 'michael', 'david', 'thomas'];


// The hand-cast books (tools/voicelabels.json) - the fake decision model casts every third its best voice, every third
// its last voice that suits, and every third a voice of the other sex that doesn't suit
const labels = JSON.parse(readFileSync(join(root, 'tools', 'voicelabels.json'), 'utf-8'));
const labelVoices = Object.fromEntries(labels.map((label, ix) => {
    let voice;
    if (ix % 3 === 0) {
        [voice] = label.voices;
    } else if (ix % 3 === 1) {
        voice = label.voices.at(-1);
    } else {
        const otherVoices = femaleVoices.includes(label.voices[0]) ? maleVoices : femaleVoices;
        voice = otherVoices.find((otherVoice) => !label.voices.includes(otherVoice));
    }
    return [`${label.source}|${label.id}`, voice];
}));


// Each book's question probabilities from the fake decision model, by title - the others share what's left
const bookProbabilities = {
    'Emma': {
        'sex': {'female': 0.7, 'male': 0.3},
        'style': {'grave': 0.5, 'storyteller': 0.3, 'young': 0.1, 'brisk': 0.06, 'gentle': 0.04}
    }
};


// A fake Ollama's response to a request - [status, response]. A question's choice is its first given option (a
// hand-cast book's voice is labelVoices's, by its description), else the question's first option at 0.6.
function ollamaResponse(path, body) {
    if (path === '/api/show') {
        if (body.model === 'missing') {
            return [404, {'error': `model '${body.model}' not found`}];
        }
        return [200, {'capabilities': body.model === 'chat' ? ['completion'] : ['completion', 'decision']}];
    }
    const answers = {};
    for (const [name, question] of Object.entries(body.questions)) {
        const keys = Object.keys(question.criteria);
        const labelVoice = name === 'voice' ? labelVoices[body.state.description] : undefined;
        const given = bookProbabilities[body.state.title]?.[name] ??
            (labelVoice !== undefined ? {[labelVoice]: 0.55} : {[keys[0]]: 0.6});
        const givenTotal = Object.values(given).reduce((total, probability) => total + probability, 0);
        const rest = (1 - givenTotal) / keys.filter((key) => !(key in given)).length;
        const [choice] = Object.keys(given);
        answers[name] = {choice, 'probabilities': Object.fromEntries(keys.map((key) => [key, given[key] ?? rest]))};
    }
    return [200, {answers}];
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
    {'source': 'test', 'id': '2', 'title': 'Moby Dick', 'author': 'Herman Melville'}
];

// The hand-cast books' catalog - each book's description its key
const labelsCatalogPath = join(tempDir, 'labelsCatalog.json');
const labelsCatalogBooks = labels.map(({source, id, title, author}) => ({source, id, title, author, 'description': `${source}|${id}`}));


before(async () => {
    writeFileSync(catalogPath, JSON.stringify({'books': catalogBooks}));
    writeFileSync(labelsCatalogPath, JSON.stringify({'books': labelsCatalogBooks}));
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


// Run voicecast.js - {code, stdout, stderr}
function runVoicecast(args, catalog = catalogPath) {
    const env = {...process.env, 'OLLAMA_HOST': ollamaHost, 'PICOSHELF_CATALOG': catalog};
    return new Promise((resolve) => {
        execFile(process.execPath, [join(root, 'tools', 'voicecast.js'), ...args], {env}, (error, stdout, stderr) => {
            resolve({'code': error?.code ?? 0, stdout, stderr});
        });
    });
}


// Emma's split-scheme probabilities - each voice's sex's times its style's
function emmaSplitProbabilities() {
    const {sex, style} = bookProbabilities.Emma;
    const styles = ['storyteller', 'grave', 'young', 'brisk', 'gentle'];
    return Object.fromEntries([
        ...femaleVoices.map((voice, ix) => [voice, sex.female * style[styles[ix]]]),
        ...maleVoices.map((voice, ix) => [voice, sex.male * style[styles[ix]]])
    ]);
}


test('voicecast, constants', () => {
    assert.equal(castModel, decisionModel);
    assert.equal(castScheme, 'voice');
    assert.deepEqual(Object.keys(castVoices), [...femaleVoices, ...maleVoices]);
    assert.match(castVoices.robert, /^A man narrates in a deep, grave, weathered voice/);
});


test('castBook', async () => {
    let cast;
    const calls = await withFetch(async () => {
        cast = await castBook(catalogBooks[0]);
    });
    assert.equal(cast.voice, 'sarah');
    assert.equal(cast.probabilities.sarah, 0.6);
    assert.deepEqual(Object.keys(cast.probabilities), Object.keys(castVoices));

    // The voice question
    assert.equal(calls.length, 1);
    const [[url, body]] = calls;
    assert.equal(url, 'http://127.0.0.1:11434/v1/systemone');
    assert.equal(body.model, decisionModel);
    assert.deepEqual(Object.keys(body.questions), ['voice']);
    assert.equal(body.questions.voice.type, 'choice');
    assert.match(body.questions.voice.instructions, /^Cast the narrator of this audiobook/);
    assert.deepEqual(body.questions.voice.criteria, castVoices);
});


test('castBook, split', async () => {
    let cast;
    const calls = await withFetch(async () => {
        cast = await castBook(catalogBooks[0], {'model': 'test:model', 'scheme': 'split'});
    });
    assert.deepEqual(cast, {'voice': 'helen', 'probabilities': emmaSplitProbabilities()});

    // The sex and style questions
    const [[, body]] = calls;
    assert.equal(body.model, 'test:model');
    assert.deepEqual(Object.keys(body.questions), ['sex', 'style']);
    assert.deepEqual(Object.keys(body.questions.sex.criteria), ['female', 'male']);
    assert.deepEqual(Object.keys(body.questions.style.criteria), ['storyteller', 'grave', 'young', 'brisk', 'gentle']);
});


test('castBooks', async () => {
    let casts;
    const calls = await withFetch(async () => {
        casts = await castBooks(catalogBooks);
    });
    assert.deepEqual(casts, {'test|1': 'sarah', 'test|2': 'sarah'});
    assert.deepEqual(calls.map(([url, body]) => [url, body.model]), [
        ['http://127.0.0.1:11434/api/show', decisionModel],
        ['http://127.0.0.1:11434/v1/systemone', decisionModel],
        ['http://127.0.0.1:11434/v1/systemone', decisionModel]
    ]);
    const cache = JSON.parse(readFileSync(join(cacheDir, 'voices', 'kev_9b-nvfp4-voice.json'), 'utf-8'));
    assert.deepEqual(Object.keys(cache), ['test|1', 'test|2']);
    assert.equal(cache['test|1'].voice, 'sarah');
    assert.equal(cache['test|1'].probabilities.sarah, 0.6);
});


test('castBooks, split', async () => {
    const logs = [];
    let casts;
    await withFetch(async () => {
        casts = await castBooks(catalogBooks, {'model': 'test:model', 'scheme': 'split', 'log': (line) => logs.push(line)});
    });
    assert.deepEqual(casts, {'test|1': 'helen', 'test|2': 'sarah'});
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Voices: 2 books \(2 decided with test:model, \d+ ms a book\)$/);
    const cache = JSON.parse(readFileSync(join(cacheDir, 'voices', 'test_model-split.json'), 'utf-8'));
    assert.deepEqual(cache['test|1'].probabilities, emmaSplitProbabilities());

    // Cast again - cached
    logs.length = 0;
    const calls = await withFetch(async () => {
        casts = await castBooks(catalogBooks, {'model': 'test:model', 'scheme': 'split', 'log': (line) => logs.push(line)});
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(casts, {'test|1': 'helen', 'test|2': 'sarah'});
    assert.deepEqual(logs, ['Voices: 2 books (0 decided with test:model)']);
});


test('voicecast.js --eval', async () => {
    const result = await runVoicecast(['--eval', '--model', 'test:model'], labelsCatalogPath);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');

    // The expected scores and misses
    let best = 0;
    let suits = 0;
    let sex = 0;
    const misses = [];
    for (const label of labels) {
        const voice = labelVoices[`${label.source}|${label.id}`];
        best += voice === label.voices[0] ? 1 : 0;
        suits += label.voices.includes(voice) ? 1 : 0;
        sex += femaleVoices.includes(voice) === femaleVoices.includes(label.voices[0]) ? 1 : 0;
        if (!label.voices.includes(voice)) {
            misses.push(`    ${label.title} (${label.author}): ${voice} - not ${label.voices.join(', ')}`);
        }
    }
    const percent = (count) => `${(100 * count / labels.length).toFixed(1)}%`;
    assert(best < suits && suits < labels.length && sex < labels.length && misses.length > 0);

    const lines = result.stdout.split('\n');
    const scores = `best ${percent(best)}, suits ${percent(suits)}, sex ${percent(sex)}`;
    assert.match(lines[0], new RegExp(`^test:model voice: ${scores}, \\d+ ms a book \\(${labels.length} books\\)$`));
    assert.deepEqual(lines.slice(1), [...misses, '']);

    // The model checked and warmed, then each book cast
    assert.deepEqual(serverRequests.slice(0, 2).map(([, url, body]) => [url, body.model]), [
        ['/api/show', 'test:model'],
        ['/v1/systemone', 'test:model']
    ]);
    assert.equal(serverRequests.length, 2 + labels.length);
    assert.equal(serverRequests[1][2].state.description, serverRequests[2][2].state.description);

    // Nothing cached
    assert(!existsSync(cacheDir));
});


test('voicecast.js --book', async () => {
    const result = await runVoicecast(['--model', 'test:model', '--scheme', 'split', '--book', 'eMMa']);
    assert.deepEqual(result, {'code': 0, 'stdout': 'Emma (Jane Austen): helen - helen 35%, sarah 21%, robert 15%\n', 'stderr': ''});
    assert.deepEqual(serverRequests.map(([method, url, body]) => [method, url, body.model]), [
        ['POST', '/api/show', 'test:model'],
        ['POST', '/v1/systemone', 'test:model']
    ]);
});


test('voicecast.js, all books', async () => {
    const result = await runVoicecast([]);
    assert.deepEqual(result, {
        'code': 0,
        'stdout': 'Emma (Jane Austen): sarah - sarah 60%, helen 4%, amy 4%\n' +
            'Moby Dick (Herman Melville): sarah - sarah 60%, helen 4%, amy 4%\n',
        'stderr': ''
    });
    assert.deepEqual(serverRequests.map(([, url, body]) => [url, body.model]), [
        ['/api/show', decisionModel],
        ['/v1/systemone', decisionModel],
        ['/v1/systemone', decisionModel]
    ]);
    assert(!existsSync(cacheDir));
});


test('voicecast.js --eval, not a decision model', async () => {
    const result = await runVoicecast(['--model', 'chat', '--eval'], labelsCatalogPath);
    assert.deepEqual(result, {'code': 1, 'stdout': '', 'stderr': 'error: "chat" isn\'t a decision model\n'});
    assert.equal(serverRequests.length, 1);
});


test('voicecast.js, unknown model', async () => {
    const result = await runVoicecast(['--model', 'missing']);
    assert.deepEqual(result, {
        'code': 1,
        'stdout': '',
        'stderr': 'error: Unknown model "missing" - ollama pull missing (Ollama /api/show (404): model \'missing\' not found)\n'
    });
});


test('voicecast.js, unknown scheme', async () => {
    const result = await runVoicecast(['--scheme', 'bogus', '--eval']);
    assert.deepEqual(result, {'code': 1, 'stdout': '', 'stderr': 'error: Unknown scheme "bogus"\n'});
    assert.equal(serverRequests.length, 0);
});


test('voicecast.js, unknown argument', async () => {
    const result = await runVoicecast(['--bogus']);
    assert.deepEqual(result, {'code': 1, 'stdout': '', 'stderr': 'error: Unknown argument "--bogus"\n'});
    assert.equal(serverRequests.length, 0);
});
