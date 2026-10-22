import {cacheDir, fakeOllama, ollamaServer, root, runTool, tempDir, withOllama} from './toolsHelpers.js';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import test, {after, before, beforeEach} from 'node:test';
import {strict as assert} from 'node:assert';
import {join} from 'node:path';


// The tools - imported after toolsHelpers.js sets their cache directory
const {decisionModel} = await import('../tools/decide.js');
const {castBook, castBooks, castScheme, castVoices} = await import('../tools/voicecast.js');


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


// The fake Ollama - a question's given probabilities are the book's, by title, else a hand-cast book's voice
// (labelVoices's, by its description) at 0.55
const ollama = fakeOllama((name, body) => {
    const labelVoice = name === 'voice' ? labelVoices[body.state.description] : undefined;
    return bookProbabilities[body.state.title]?.[name] ?? (labelVoice === undefined ? undefined : {[labelVoice]: 0.55});
});


// The fake Ollama server, for the command line's child processes
let server;


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
    server = await ollamaServer(ollama);
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
    assert.equal(castScheme, 'voice');
    assert.deepEqual(Object.keys(castVoices), [...femaleVoices, ...maleVoices]);
    assert.match(castVoices.robert, /^A man narrates in a deep, grave, weathered voice/);
});


test('castBook', async () => {
    let cast;
    const calls = await withOllama(ollama, async () => {
        cast = await castBook(catalogBooks[0], {'model': 'test:model', 'scheme': 'voice'});
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


test('castBook, split', async () => {
    let cast;
    const calls = await withOllama(ollama, async () => {
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
    const cache = JSON.parse(readFileSync(join(cacheDir, 'voices', 'test_model-voice.json'), 'utf-8'));
    assert.deepEqual(Object.keys(cache), ['test|1', 'test|2']);
    assert.equal(cache['test|1'].voice, 'sarah');
    assert.equal(cache['test|1'].probabilities.sarah, 0.6);
});


test('castBooks, split', async () => {
    const logs = [];
    let casts;
    await withOllama(ollama, async () => {
        casts = await castBooks(catalogBooks, {'model': 'test:model', 'scheme': 'split', 'log': (line) => logs.push(line)});
    });
    assert.deepEqual(casts, {'test|1': 'helen', 'test|2': 'sarah'});
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^Voices: 2 books \(2 decided with test:model, \d+ ms a book\)$/);
    const cache = JSON.parse(readFileSync(join(cacheDir, 'voices', 'test_model-split.json'), 'utf-8'));
    assert.deepEqual(cache['test|1'].probabilities, emmaSplitProbabilities());

    // Cast again - cached
    logs.length = 0;
    const calls = await withOllama(ollama, async () => {
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
    const result = await runVoicecast(['--model', 'test:model', '--scheme', 'split', '--book', 'eMMa']);
    assert.deepEqual(result, {'code': 0, 'stdout': 'Emma (Jane Austen): helen - helen 35%, sarah 21%, robert 15%\n', 'stderr': ''});
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


test('voicecast.js, unknown scheme', async () => {
    const result = await runVoicecast(['--scheme', 'bogus', '--eval']);
    assert.deepEqual(result, {'code': 1, 'stdout': '', 'stderr': 'error: Unknown scheme "bogus"\n'});
    assert.equal(server.requests.length, 0);
});


test('voicecast.js, unknown argument', async () => {
    const result = await runVoicecast(['--bogus']);
    assert.deepEqual(result, {'code': 1, 'stdout': '', 'stderr': 'error: Unknown argument "--bogus"\n'});
    assert.equal(server.requests.length, 0);
});
