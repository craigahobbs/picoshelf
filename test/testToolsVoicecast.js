import {cacheDir, fakeOllama, ollamaServer, root, runTool, tempDir, withOllama} from './toolsHelpers.js';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import test, {after, before, beforeEach} from 'node:test';
import {strict as assert} from 'node:assert';
import {join} from 'node:path';


// The tools - imported after toolsHelpers.js sets their cache directory
const {decisionModel} = await import('../tools/decide.js');
const {castBook, castBooks, castVoices} = await import('../tools/voicecast.js');


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


// The fake Ollama - a hand-cast book's voice (labelVoices's, by its description) at 0.55
const ollama = fakeOllama((name, body) => {
    const labelVoice = labelVoices[body.state.description];
    return labelVoice === undefined ? undefined : {[labelVoice]: 0.55};
});


// The fake Ollama server, for the command line's child processes
const server = await ollamaServer(ollama);


// The test catalog
const catalogPath = join(tempDir, 'catalog.json');
const catalogBooks = [
    {'source': 'test', 'id': '1', 'title': 'Emma', 'author': 'Jane Austen', 'subjects': ['Fiction'], 'description': 'A matchmaker.'},
    {'source': 'test', 'id': '2', 'title': 'Moby Dick', 'author': 'Herman Melville'}
];

// The hand-cast books' catalog - each book's description its key
const labelsCatalogPath = join(tempDir, 'labelsCatalog.json');
const labelsCatalogBooks = labels.map(({source, id, title, author}) => ({source, id, title, author, 'description': `${source}|${id}`}));


before(() => {
    writeFileSync(catalogPath, JSON.stringify({'books': catalogBooks}));
    writeFileSync(labelsCatalogPath, JSON.stringify({'books': labelsCatalogBooks}));
});


after(() => server.close());


beforeEach(() => {
    rmSync(cacheDir, {'recursive': true, 'force': true});
    server.requests.length = 0;
});


// Run voicecast.js - {code, stdout, stderr}
function runVoicecast(args, catalog = catalogPath) {
    return runTool('voicecast', args, {'OLLAMA_HOST': server.host, 'PICOSHELF_CATALOG': catalog});
}


test('voicecast, constants', () => {
    assert.deepEqual(Object.keys(castVoices), [...femaleVoices, ...maleVoices]);
    assert.match(castVoices.robert, /^A man narrates in a deep, grave, steady voice/);
});


test('castBook', async () => {
    let cast;
    const calls = await withOllama(ollama, async () => {
        cast = await castBook(catalogBooks[0], {'model': 'test:model'});
    });
    assert.equal(cast.voice, 'sarah');
    assert.equal(cast.probabilities.sarah, 0.6);
    assert.deepEqual(Object.keys(cast.probabilities), Object.keys(castVoices));

    // The voice question
    assert.equal(calls.length, 1);
    const [[url, body]] = calls;
    assert.equal(url, 'http://127.0.0.1:11434/v1/systemone');
    assert.equal(body.model, 'test:model');
    assert.deepEqual(Object.keys(body.questions), ['voice']);
    assert.equal(body.questions.voice.type, 'choice');
    assert.match(body.questions.voice.instructions, /^Cast the narrator of this audiobook/);
    assert.deepEqual(body.questions.voice.criteria, castVoices);
});


test('castBooks', async () => {
    const logs = [];
    let casts;
    const calls = await withOllama(ollama, async () => {
        casts = await castBooks(catalogBooks, {'model': 'test:model', 'log': (line) => logs.push(line)});
    });
    assert.deepEqual(casts, {'test|1': 'sarah', 'test|2': 'sarah'});
    assert.deepEqual(logs.length, 1);
    assert.deepEqual(calls.map(([url, body]) => [url, body.model]), [
        ['http://127.0.0.1:11434/api/show', 'test:model'],
        ['http://127.0.0.1:11434/v1/systemone', 'test:model'],
        ['http://127.0.0.1:11434/v1/systemone', 'test:model']
    ]);
    const cache = JSON.parse(readFileSync(join(cacheDir, 'voices', 'test_model.json'), 'utf-8'));
    assert.deepEqual(Object.keys(cache), ['test|1', 'test|2']);
    assert.equal(cache['test|1'].voice, 'sarah');
    assert.equal(cache['test|1'].probabilities.sarah, 0.6);
});


test('castBooks, cached', async () => {
    // Cast again - cached
    await withOllama(ollama, () => castBooks(catalogBooks, {'model': 'test:model', 'log': () => null}));
    const logs = [];
    let casts;
    const calls = await withOllama(ollama, async () => {
        casts = await castBooks(catalogBooks, {'model': 'test:model', 'log': (line) => logs.push(line)});
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(casts, {'test|1': 'sarah', 'test|2': 'sarah'});
    assert.deepEqual(logs, ['Voices: 2 books (0 decided with test:model)']);
});


test('voicecast.js --eval, hand-cast books not in the catalog', async () => {
    // The catalog without the last two hand-cast books - the others scored, the two named
    const partialCatalogPath = join(tempDir, 'partialCatalog.json');
    writeFileSync(partialCatalogPath, JSON.stringify({'books': labelsCatalogBooks.slice(0, -2)}));
    const result = await runVoicecast(['--eval', '--model', 'test:model'], partialCatalogPath);
    assert.equal(result.code, 0);
    const lines = result.stdout.trimEnd().split('\n');
    assert.match(lines[0], new RegExp(`\\(${labels.length - 2} books\\)$`));
    assert.equal(lines.at(-1), `2 hand-cast books not in the catalog: ${labels.slice(-2).map((label) => label.title).join('; ')}`);
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
    assert.match(lines[0], new RegExp(`^test:model: ${scores}, \\d+ ms a book \\(${labels.length} books\\)$`));
    assert.deepEqual(lines.slice(1), [...misses, '']);

    // The model checked and warmed, then each book cast
    assert.deepEqual(server.requests.slice(0, 2).map(([, url, body]) => [url, body.model]), [
        ['/api/show', 'test:model'],
        ['/v1/systemone', 'test:model']
    ]);
    assert.equal(server.requests.length, 2 + labels.length);
    assert.equal(server.requests[1][2].state.description, server.requests[2][2].state.description);

    // Nothing cached
    assert(!existsSync(cacheDir));
});


test('voicecast.js --book', async () => {
    const result = await runVoicecast(['--model', 'test:model', '--book', 'eMMa']);
    assert.deepEqual(result, {'code': 0, 'stdout': 'Emma (Jane Austen): sarah - sarah 60%, helen 4%, amy 4%\n', 'stderr': ''});
    assert.deepEqual(server.requests.map(([method, url, body]) => [method, url, body.model]), [
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
    assert.deepEqual(server.requests.map(([, url, body]) => [url, body.model]), [
        ['/api/show', decisionModel],
        ['/v1/systemone', decisionModel],
        ['/v1/systemone', decisionModel]
    ]);
    assert(!existsSync(cacheDir));
});


test('voicecast.js --eval, not a decision model', async () => {
    const result = await runVoicecast(['--model', 'chat', '--eval'], labelsCatalogPath);
    assert.deepEqual(result, {'code': 1, 'stdout': '', 'stderr': 'error: "chat" isn\'t a decision model\n'});
    assert.equal(server.requests.length, 1);
});


test('voicecast.js, unknown argument', async () => {
    const result = await runVoicecast(['--bogus']);
    assert.deepEqual(result, {'code': 1, 'stdout': '', 'stderr': 'error: Unknown argument "--bogus"\n'});
    assert.equal(server.requests.length, 0);
});
