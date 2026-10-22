import {loadNeuralModel, picovoxVoice, unitBlocks} from '../lib/worker.js';
import {modelLoader, paragraphPause, sentenceBlocks, sentenceFrames, sentencePause, spanFrames} from 'picovox/lib/synthesis.js';
import {strict as assert} from 'node:assert';
import {paragraphBeats} from 'picovox/lib/style.js';
import test from 'node:test';


// The package's models - the voice model, and the G2P network set as the pronouncer
const importG2p = () => import('picovox/lib/models/g2pModel.js');
const importVoice = () => import('picovox/lib/models/voiceModel.js');
const model = await modelLoader(importG2p, importVoice)();
const {g2pModel} = await importG2p();
const {manifest, encoding, weights} = await importVoice();


// The worker globals - WorkerGlobalScope, self (its posted messages and transfer lists), Worker (the render worker -
// its posted messages, and an optional hook on each), and MessageChannel (the worker's yield - delivered on the next
// turn of the event loop). Worker and MessageChannel are used only on the worker module's import.
class FakeWorkerGlobalScope {
    constructor() {
        this.posted = [];
    }

    postMessage(message, transfer) {
        this.posted.push({message, transfer});
    }
}

const renderWorkers = [];
class FakeWorker {
    constructor(url, options) {
        this.url = url;
        this.options = options;
        this.posted = [];
        this.onPost = null;
        renderWorkers.push(this);
    }

    postMessage(message, transfer) {
        this.posted.push({message, transfer});
        if (this.onPost !== null) {
            this.onPost(message);
        }
    }
}

class FakeMessageChannel {
    constructor() {
        this.port1 = {'onmessage': null};
        this.port2 = {'postMessage': (data) => setTimeout(() => this.port1.onmessage({data}), 0)};
    }
}


// Start a worker - a fresh worker.js module instance with the worker globals; returns {self, renderWorker, send}
const {MessageChannel} = globalThis;
function restoreGlobals() {
    globalThis.MessageChannel = MessageChannel;
    delete globalThis.Worker;
}
let workerCount = 0;
async function startWorker() {
    const workerSelf = new FakeWorkerGlobalScope();
    globalThis.WorkerGlobalScope = FakeWorkerGlobalScope;
    globalThis.self = workerSelf;
    globalThis.Worker = FakeWorker;
    globalThis.MessageChannel = FakeMessageChannel;
    try {
        workerCount += 1;
        await import(`../lib/worker.js?worker=${workerCount}`);
    } finally {
        restoreGlobals();
    }
    const {onmessage} = workerSelf;
    return {'self': workerSelf, 'renderWorker': renderWorkers.at(-1), 'send': (data) => onmessage({data})};
}


// Wait for a condition (failing after a while, so a failed test doesn't hang)
async function waitFor(condition) {
    const start = Date.now();
    while (!condition()) {
        assert.ok(Date.now() - start < 10000, 'waitFor timed out');
        await new Promise((resolve) => {
            setTimeout(resolve, 1);
        });
    }
}


// A posted list's messages, and its trace events
const messages = (posted) => posted.map(({message}) => message);
const traces = (posted) => messages(posted).filter((message) => message.type === 'trace').map((message) => message.event);
const untraced = (posted) => messages(posted).filter((message) => message.type !== 'trace');


// A render worker's frames messages' frames - [rows], each row a Float64Array
function sentFrames(posted, id, unit) {
    const rows = [];
    for (const {message} of posted) {
        if (message.type === 'frames' && message.id === id && message.unit === unit) {
            const width = message.frames.length / message.count;
            for (let row = 0; row < message.count; row++) {
                rows.push(message.frames.slice(row * width, (row + 1) * width));
            }
        }
    }
    return rows;
}


// A worker.js module outside a worker - no message loop
globalThis.WorkerGlobalScope = FakeWorkerGlobalScope;
globalThis.self = {};
await import('../lib/worker.js?not-worker');
const notWorkerOnmessage = globalThis.self.onmessage;


// The worker - started, given the models (and a slowdown), and its voice model prepared - for the tests below
const worker = await startWorker();
const startedPosted = [...worker.self.posted];
worker.self.posted.length = 0;
worker.send({'type': 'models', g2pModel, 'voiceModel': {manifest, encoding, weights}, 'slowdown': 2});
await waitFor(() => untraced(worker.self.posted).length > 0);
const modelsPosted = [...worker.self.posted];
worker.self.posted.length = 0;
worker.send({'type': 'prepare', 'voice': 'neural-male'});
await waitFor(() => worker.self.posted.length === 2);
const preparePosted = [...worker.self.posted];


test('picovoxVoice', () => {
    assert.equal(picovoxVoice('neural-male'), 'male');
    assert.equal(picovoxVoice('neural-female'), 'female');
    assert.equal(picovoxVoice('sarah'), 'sarah');
});


test('loadNeuralModel', async () => {
    // A failed import or unpack is tried again on the next load
    const events = [];
    const trace = (event) => events.push(event);
    await assert.rejects(loadNeuralModel(() => Promise.reject(new Error('dropped')), trace), /dropped/);
    assert.deepEqual(events, []);
    const badModule = {'manifest': null, 'encoding': 'other', 'weights': ''};
    await assert.rejects(loadNeuralModel(() => Promise.resolve(badModule), trace), /unknown package encoding other/);
    assert.deepEqual(events, ['voice model imported']);

    // The default import
    const loading = loadNeuralModel();
    const neuralModel = await loading;
    assert.deepEqual(neuralModel.manifest, model.manifest);

    // Loaded once
    assert.equal(loadNeuralModel(() => Promise.reject(new Error('not imported')), trace), loading);
    assert.deepEqual(events, ['voice model imported']);
});


test('unitBlocks', async () => {
    const neuralModel = await loadNeuralModel();
    const text = 'Call me Ishmael.';

    // A sentence
    const blocks = [...unitBlocks(neuralModel, text, {'voice': 'neural-female'})];
    const expected = [...sentenceBlocks(neuralModel, text, {'voice': 'female', 'rate': 1, 'seed': 1, 'pause': sentencePause})];
    assert.deepEqual(blocks, expected);
    assert.equal(blocks[0].length, Math.round(24000 * sentencePause));

    // A paragraph's first sentence, faster, with another seed
    const options = {'voice': 'james', 'rate': 1.5, 'seed': 7, 'paragraphStart': true};
    assert.deepEqual(
        [...unitBlocks(neuralModel, text, options)],
        [...sentenceBlocks(neuralModel, text, {'voice': 'james', 'rate': 1.5, 'seed': 7, 'pause': paragraphPause})]
    );
});


test('worker, not a worker', () => {
    assert.equal(notWorkerOnmessage, undefined);
});


test('worker, startup', () => {
    const {renderWorker, send} = worker;
    assert.equal(renderWorker.url.href, new URL('../lib/renderworker.js', import.meta.url).href);
    assert.deepEqual(renderWorker.options, {'type': 'module'});

    // Started, with its speed check
    const started = traces(startedPosted);
    assert.equal(started.length, 2);
    assert.equal(started[0], 'started');
    assert.match(started[1], /^speed check: \d+ ms \(checksum \d+\)$/);
    assert.ok(startedPosted.every(({message}) => Number.isInteger(message.ms) && message.ms >= 0));

    // The models - the G2P network loads, then the worker is ready
    assert.deepEqual(untraced(modelsPosted), [{'type': 'ready'}]);
    assert.deepEqual(traces(modelsPosted), ['models received', 'G2P model unpacked']);

    // Prepare - the voice model loads
    assert.deepEqual(traces(preparePosted), ['voice model imported', 'voice model unpacked']);

    // An unknown message
    const {posted} = worker.self;
    posted.length = 0;
    send({'type': 'other'});
    assert.deepEqual(posted, []);
});


test('worker, render worker relay', () => {
    const {renderWorker} = worker;
    const {posted} = worker.self;
    posted.length = 0;

    // A block - its samples transferred
    const samples = new Float32Array(4);
    renderWorker.onmessage({'data': {'type': 'unitBlock', 'id': 1, 'unit': 2, samples, 'sampleRate': 24000}});
    assert.deepEqual(posted, [
        {'message': {'type': 'unitBlock', 'id': 1, 'unit': 2, samples, 'sampleRate': 24000}, 'transfer': [samples.buffer]}
    ]);

    // A unit's end - traced
    posted.length = 0;
    renderWorker.onmessage({'data': {'type': 'unitDone', 'id': 1, 'unit': 2, 'renderMs': 15}});
    assert.equal(posted.length, 2);
    assert.equal(posted[0].message.event, 'unit 2: render 15 ms');
    assert.deepEqual(posted[1], {'message': {'type': 'unitDone', 'id': 1, 'unit': 2, 'renderMs': 15}, 'transfer': []});

    // A run's end, and an error
    posted.length = 0;
    renderWorker.onmessage({'data': {'type': 'runDone', 'id': 1}});
    renderWorker.onmessage({'data': {'type': 'error', 'message': 'boom'}});
    assert.deepEqual(posted, [
        {'message': {'type': 'runDone', 'id': 1}, 'transfer': []},
        {'message': {'type': 'error', 'message': 'boom'}, 'transfer': []}
    ]);

    // The render worker's uncaught errors are the worker's
    posted.length = 0;
    let prevented = 0;
    const preventDefault = () => {
        prevented += 1;
    };
    renderWorker.onerror({'message': 'Script error', preventDefault});
    renderWorker.onerror({'message': '', preventDefault});
    assert.equal(prevented, 2);
    assert.deepEqual(messages(posted), [
        {'type': 'error', 'id': null, 'message': 'render worker: Script error'},
        {'type': 'error', 'id': null, 'message': 'render worker: (no message)'}
    ]);
});


// Run units on the worker - waits for the render worker's runEnd (or, with a superseded run, for the given condition);
// returns {posted (the worker's), rendered (the render worker's)}
async function runUnits(data, done = null) {
    const {renderWorker, send} = worker;
    const {posted} = worker.self;
    posted.length = 0;
    renderWorker.posted.length = 0;
    send({'type': 'units', ...data});
    await waitFor(done ?? (() => renderWorker.posted.some(({message}) => message.type === 'runEnd')));
    return {'posted': [...posted], 'rendered': [...renderWorker.posted]};
}


// The render worker's messages, without the frames
const renderedSummary = (rendered) => messages(rendered).map(({type, unit}) => (unit === undefined ? type : `${type} ${unit}`));


test('worker, units', async () => {
    const units = [
        {'index': 0, 'text': 'Call me Ishmael.', 'paragraphStart': true},
        {'index': 1, 'text': 'Some years ago.', 'paragraphStart': false}
    ];
    const {posted, rendered} = await runUnits({'id': 5, units, 'voice': 'neural-male', 'rate': 1.2});

    // The units' starts
    assert.deepEqual(untraced(posted), [{'type': 'unitStart', 'id': 5, 'unit': 0}, {'type': 'unitStart', 'id': 5, 'unit': 1}]);
    const events = traces(posted);
    assert.equal(events.length, 4);
    assert.match(events[0], /^unit 0: G2P 3 words in \d+ ms$/);
    assert.match(events[1], /^unit 0: network \d+ ms$/);
    assert.match(events[2], /^unit 1: G2P 3 words in \d+ ms$/);
    assert.match(events[3], /^unit 1: network \d+ ms$/);

    // The render worker's messages - each unit's begin, frames, and end, then the run's end
    const summary = renderedSummary(rendered);
    assert.equal(summary[0], 'begin 0');
    assert.deepEqual(summary.slice(-1), ['runEnd']);
    assert.deepEqual(rendered.at(-1).message, {'type': 'runEnd', 'id': 5});
    const end0 = summary.indexOf('end 0');
    assert.ok(end0 > 1);
    assert.ok(summary.slice(1, end0).every((type) => type === 'frames 0'));
    assert.equal(summary[end0 + 1], 'begin 1');
    const [{message: begin0}] = rendered;
    const expected0 = sentenceFrames(model, units[0].text, {'voice': 'male', 'rate': 1.2});
    assert.deepEqual(begin0, {
        'type': 'begin', 'id': 5, 'unit': 0, 'eq': expected0.eq, 'seed': 1000, 'pause': paragraphPause, 'rate': 1.2
    });
    const {message: begin1} = rendered[end0 + 1];
    assert.equal(begin1.seed, 1001);
    assert.equal(begin1.pause, sentencePause);

    // Each frames message - its rows end to end, transferred - the unit's frames
    for (const {message, transfer} of rendered) {
        if (message.type === 'frames') {
            assert.equal(message.id, 5);
            assert.ok(message.count > 0);
            assert.equal(message.frames.length % message.count, 0);
            assert.deepEqual(transfer, [message.frames.buffer]);
        }
    }
    assert.deepEqual(sentFrames(rendered, 5, 0), [...expected0.chunks].flat());
    const expected1 = sentenceFrames(model, units[1].text, {'voice': 'male', 'rate': 1.2});
    assert.deepEqual(sentFrames(rendered, 5, 1), [...expected1.chunks].flat());
});


test('worker, units with spans and beats', async () => {
    const spans = [{'text': 'Hello,', 'style': 'dialogue'}, {'text': 'he said.', 'style': 'neutral'}];
    const beats = paragraphBeats([{'index': 0, 'paragraphStart': true}, {'index': 1, 'paragraphStart': false}]);
    const units = [
        {'index': 3, 'text': '"Hello," he said.', 'paragraphStart': true, spans, 'beat': beats[0]},
        {'index': 4, 'text': 'Go.', 'paragraphStart': false, 'spans': null, 'beat': beats[1]}
    ];
    const {posted, rendered} = await runUnits({'id': 6, units, 'voice': 'sarah', 'rate': 1});
    assert.deepEqual(untraced(posted), [{'type': 'unitStart', 'id': 6, 'unit': 3}, {'type': 'unitStart', 'id': 6, 'unit': 4}]);
    const events = traces(posted);
    assert.match(events[0], /^unit 3: G2P 3 words in \d+ ms \(spans dialogue, neutral\) \(beat pitch 1\.080, rate 1\)$/);
    assert.match(events[2], /^unit 4: G2P 1 words in \d+ ms \(beat pitch 0\.960, rate 0\.9299+\)$/);

    // The spans' frames, in the beat
    const expected3 = spanFrames(model, spans, {'voice': 'sarah', 'rate': 1, 'beat': beats[0]});
    assert.deepEqual(rendered[0].message.eq, expected3.eq);
    assert.deepEqual(sentFrames(rendered, 6, 3), [...expected3.chunks].flat());
    const expected4 = sentenceFrames(model, 'Go.', {'voice': 'sarah', 'rate': 1, 'beat': beats[1]});
    assert.deepEqual(sentFrames(rendered, 6, 4), [...expected4.chunks].flat());
});


test('worker, units with an empty chunk', async () => {
    // Spans at a very high speed - no silence between them, an empty chunk
    const spans = [{'text': 'Hi, there my friend,', 'style': 'neutral'}, {'text': 'he said.', 'style': 'dialogue'}];
    const {rendered} = await runUnits({'id': 7, 'units': [{'index': 0, 'text': '', spans}], 'voice': 'neural-male', 'rate': 25});
    const empty = messages(rendered).filter((message) => message.type === 'frames' && message.count === 0);
    assert.equal(empty.length, 1);
    assert.equal(empty[0].frames.length, 0);
});


test('worker, unit already finished', async () => {
    const units = [{'index': 10, 'text': 'One.'}, {'index': 11, 'text': 'Two.'}, {'index': 12, 'text': 'Three.'}];
    const voice = 'neural-female';
    await runUnits({'id': 20, 'units': units.slice(0, 2), voice, 'rate': 1});

    // The next run's first unit was the last run's last - skipped
    const skipped = await runUnits({'id': 21, 'units': units.slice(1), voice, 'rate': 1});
    let {posted} = skipped;
    const {rendered} = skipped;
    assert.deepEqual(untraced(posted), [{'type': 'unitStart', 'id': 21, 'unit': 12}]);
    assert.deepEqual(renderedSummary(rendered).filter((type) => type !== 'frames 12'), ['begin 12', 'end 12', 'runEnd']);

    // Not the last run's last unit, another voice, another rate, other spans - spoken
    for (const [unit, unitVoice, rate] of [
        [units[1], voice, 1],
        [units[1], 'neural-male', 1],
        [units[1], 'neural-male', 1.1],
        [{...units[1], 'spans': [{'text': 'Two.', 'style': 'dialogue'}]}, 'neural-male', 1.1]
    ]) {
        ({posted} = await runUnits({'id': 22, 'units': [unit], 'voice': unitVoice, rate}));
        assert.deepEqual(untraced(posted), [{'type': 'unitStart', 'id': 22, 'unit': 11}]);
    }

    // The same unit after a cancel - spoken
    worker.send({'type': 'cancel'});
    ({posted} = await runUnits({'id': 23, 'units': [{...units[1], 'spans': [{'text': 'Two.', 'style': 'dialogue'}]}],
        'voice': 'neural-male', 'rate': 1.1}));
    assert.deepEqual(untraced(posted), [{'type': 'unitStart', 'id': 23, 'unit': 11}]);
});


test('worker, cancel', async () => {
    const units = [{'index': 0, 'text': 'One.'}, {'index': 1, 'text': 'Two.'}];

    // Canceled before its first unit, then a newer run
    worker.send({'type': 'units', 'id': 30, units, 'voice': 'neural-male', 'rate': 1});
    worker.send({'type': 'cancel'});
    const {posted, rendered} = await runUnits({'id': 31, 'units': units.slice(1), 'voice': 'neural-male', 'rate': 1});
    assert.deepEqual(untraced(posted), [{'type': 'unitStart', 'id': 31, 'unit': 1}]);
    assert.ok(messages(rendered).every((message) => message.id === 31));
});


test('worker, cancel during a unit', async () => {
    const {renderWorker} = worker;
    const units = [{'index': 0, 'text': 'One.'}, {'index': 1, 'text': 'Two.'}];

    // Canceled as its first unit begins - the unit is finished, the run isn't
    renderWorker.onPost = (message) => {
        if (message.type === 'begin') {
            renderWorker.onPost = null;
            worker.send({'type': 'cancel'});
        }
    };
    try {
        const {posted, rendered} = await runUnits(
            {'id': 40, units, 'voice': 'neural-male', 'rate': 1},
            () => renderWorker.posted.some(({message}) => message.type === 'end')
        );

        // A later run - the canceled run speaks no more units, and doesn't end
        const {posted: laterPosted, rendered: laterRendered} = await runUnits(
            {'id': 41, 'units': [{'index': 2, 'text': 'Three.'}], 'voice': 'neural-male', 'rate': 1}
        );
        assert.deepEqual(untraced(posted), [{'type': 'unitStart', 'id': 40, 'unit': 0}]);
        assert.deepEqual(renderedSummary(rendered).filter((type) => type !== 'frames 0'), ['begin 0', 'end 0']);
        assert.deepEqual(untraced(laterPosted), [{'type': 'unitStart', 'id': 41, 'unit': 2}]);
        assert.deepEqual(renderedSummary(laterRendered).filter((type) => type !== 'frames 2'), ['begin 2', 'end 2', 'runEnd']);
        assert.ok(messages(laterRendered).every((message) => message.id === 41));
    } finally {
        renderWorker.onPost = null;
    }
});


test('worker, unit error', async () => {
    const {posted, renderWorker} = {'posted': worker.self.posted, 'renderWorker': worker.renderWorker};
    posted.length = 0;
    renderWorker.posted.length = 0;
    worker.send({'type': 'units', 'id': 50, 'units': [{'index': 0, 'text': 'One.'}], 'voice': 'nobody', 'rate': 1});
    await waitFor(() => untraced(posted).some((message) => message.type === 'error'));
    const [unitStart, error] = untraced(posted);
    assert.deepEqual(unitStart, {'type': 'unitStart', 'id': 50, 'unit': 0});
    assert.equal(error.type, 'error');
    assert.equal(error.id, 50);
    assert.match(error.message, /^Unknown voice "nobody" \(Error: /);
    assert.deepEqual(renderWorker.posted, []);

    // The next run's units are spoken
    const {posted: nextPosted} = await runUnits({'id': 51, 'units': [{'index': 0, 'text': 'One.'}], 'voice': 'neural-male', 'rate': 1});
    assert.deepEqual(untraced(nextPosted), [{'type': 'unitStart', 'id': 51, 'unit': 0}]);
});


test('worker, model errors', async () => {
    const failing = await startWorker();
    const {posted} = failing.self;
    posted.length = 0;

    // The G2P network fails to load
    failing.send({'type': 'models', 'g2pModel': {'design': 'other'}, 'voiceModel': {'manifest': null, 'encoding': 'other', 'weights': ''}});
    await waitFor(() => untraced(posted).length === 1);
    const [loadError] = untraced(posted);
    assert.equal(loadError.id, null);
    assert.match(loadError.message, /^Unsupported G2P model design other \(Error: /);

    // A run fails
    posted.length = 0;
    failing.send({'type': 'units', 'id': 60, 'units': [{'index': 0, 'text': 'One.'}], 'voice': 'neural-male', 'rate': 1});
    await waitFor(() => untraced(posted).length === 1);
    const [runError] = untraced(posted);
    assert.equal(runError.id, 60);
    assert.match(runError.message, /^Unsupported G2P model design other/);

    // The voice model fails to load
    posted.length = 0;
    failing.send({'type': 'prepare', 'voice': 'neural-male'});
    await waitFor(() => untraced(posted).length === 1);
    const [prepareError] = untraced(posted);
    assert.equal(prepareError.id, null);
    assert.match(prepareError.message, /^unknown package encoding other \(Error: /);
    assert.deepEqual(failing.renderWorker.posted, []);
});
