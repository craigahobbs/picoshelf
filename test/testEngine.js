import {Engine} from '../lib/engine.js';
import {strict as assert} from 'node:assert';
import {defaultSampleRate} from 'picovox/lib/synthesis.js';
import test from 'node:test';


// The browser globals the engine uses - fake workers, audio context, media element, and navigator


// The synthesis workers created, in order - each records its posted messages, and send() posts a message to the engine
const createdWorkers = [];
class FakeWorker {
    constructor(url, options) {
        this.url = url;
        this.options = options;
        this.messages = [];
        this.terminated = false;
        createdWorkers.push(this);
    }

    postMessage(message) {
        this.messages.push(message);
    }

    terminate() {
        this.terminated = true;
    }

    send(data) {
        this.onmessage({data});
    }
}
globalThis.Worker = FakeWorker;


// An audio node - its connections
class FakeNode {
    constructor(name) {
        this.name = name;
        this.connections = [];
    }

    connect(node) {
        this.connections.push(node);
    }
}


// An audio buffer - its channels' samples
class FakeBuffer {
    constructor(channels, length, sampleRate) {
        this.length = length;
        this.sampleRate = sampleRate;
        this.channels = Array.from({'length': channels}, () => null);
    }

    copyToChannel(samples, channel) {
        this.channels[channel] = samples;
    }
}


// A buffer source - its start (when, offset) and whether it's stopped
class FakeSource extends FakeNode {
    constructor() {
        super('source');
        this.buffer = null;
        this.started = null;
        this.stopped = false;
        this.onended = null;
    }

    start(when, offset) {
        this.started = {when, offset};
    }

    stop() {
        this.stopped = true;
    }
}


// The audio context - its clock (currentTime) is set by the tests, and it records its buffer sources and resumes
class FakeAudioContext {
    constructor(options) {
        this.options = options;
        this.currentTime = 0;
        this.state = 'suspended';
        this.sampleRate = 48000;
        this.destination = new FakeNode('destination');
        this.nodes = [];
        this.sources = [];
        this.resumes = 0;
        this.suspends = 0;
        this.onstatechange = null;
    }

    resume() {
        this.resumes += 1;
        this.state = 'running';
        return Promise.resolve();
    }

    suspend() {
        // (a closed context can't suspend)
        if (this.state === 'closed') {
            return Promise.reject(new Error('InvalidStateError'));
        }
        this.suspends += 1;
        this.state = 'suspended';
        return Promise.resolve();
    }

    close() {
        this.state = 'closed';
        return Promise.reject(new Error('InvalidStateError'));
    }

    createGain() {
        const node = new FakeNode('gain');
        this.nodes.push(node);
        return node;
    }

    createMediaStreamDestination() {
        const node = new FakeNode('streamDestination');
        const track = {'readyState': 'live'};
        node.stream = {'name': 'mediaStream', track, 'getAudioTracks': () => [track]};
        this.nodes.push(node);
        return node;
    }

    createBuffer(channels, length, sampleRate) {
        const buffer = new FakeBuffer(channels, length, sampleRate);
        this.nodes.push(buffer);
        return buffer;
    }

    createBufferSource() {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
    }
}
globalThis.AudioContext = FakeAudioContext;


// The media element - its attributes, plays, and pauses (a play is refused when refusePlay is set)
let refusePlay = false;
class FakeMedia {
    constructor(tagName) {
        this.tagName = tagName;
        this.attributes = {};
        this.loop = false;
        this.src = null;
        this.srcObject = null;
        this.ended = false;
        this.plays = 0;
        this.pauses = 0;
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    play() {
        this.plays += 1;
        return refusePlay ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
    }

    pause() {
        this.pauses += 1;
    }
}
globalThis.document = {'createElement': (tagName) => new FakeMedia(tagName)};


// The navigator - replaced by setup
let fakeNavigator = {};
Object.defineProperty(globalThis, 'navigator', {'get': () => fakeNavigator, 'configurable': true});
const desktop = {'userAgent': 'Mozilla/5.0 (Macintosh)', 'platform': 'MacIntel', 'maxTouchPoints': 0, 'hardwareConcurrency': 2};
const iPhone = {'userAgent': 'Mozilla/5.0 (iPhone)', 'platform': 'iPhone', 'maxTouchPoints': 5, 'hardwareConcurrency': 6};
const iPad = {'userAgent': 'Mozilla/5.0 (Macintosh)', 'platform': 'MacIntel', 'maxTouchPoints': 5, 'hardwareConcurrency': 8};


// Set up a test - mock timers, a controllable performance clock (ms), and the navigator - and create an engine (its
// state changes recorded), its models imported
async function setup(testContext, {nav = desktop, options = {}} = {}) {
    testContext.mock.timers.enable({'apis': ['setInterval', 'setTimeout']});
    const clock = {'ms': 0};
    testContext.mock.method(performance, 'now', () => clock.ms);
    fakeNavigator = {...nav};
    refusePlay = false;
    createdWorkers.length = 0;
    const changes = [];
    const engine = new Engine({'onChange': (state) => changes.push(state), ...options});
    await engine.models.catch(() => null);
    await flush();
    return {engine, clock, changes, 'workers': createdWorkers};
}


// Let promise callbacks run
function flush() {
    return new Promise((resolve) => {
        globalThis.setImmediate(resolve);
    });
}


// A worker's posted messages of a type
function posted(worker, type) {
    return worker.messages.filter((message) => message.type === type);
}


// The timeline's events
function events(engine) {
    return engine.timeline.map(({event}) => event);
}


// A unit's synthesized audio as a worker posts it - its start, blocks (each so many seconds, at 1000 Hz), and its end
function sendUnit(worker, id, unit, seconds = [1], done = true) {
    worker.send({'type': 'unitStart', id, unit});
    for (const duration of seconds) {
        worker.send({'type': 'unitBlock', id, unit, 'samples': new Float32Array(Math.round(1000 * duration)), 'sampleRate': 1000});
    }
    if (done) {
        worker.send({'type': 'unitDone', id, unit});
    }
}


// A number rounded to microseconds - for comparing times
function round(value) {
    return Math.round(1e6 * value) / 1e6;
}


// The sources' starts - [when, offset], rounded
function starts(engine) {
    return engine.audioContext.sources.map((source) => [round(source.started.when), round(source.started.offset)]);
}


// Books
const threeSentences = 'One fish. Two fish. Red fish.';
const sixtySentences = Array.from({'length': 60}, (_value, ix) => `Sentence ${ix}.`).join(' ');
const longSentence = `${Array.from({'length': 27}, () => 'word').join(' ')} ends.`;
const longSentences = Array.from({'length': 6}, (_value, ix) => `${'Word '.repeat(200)}number ${ix}.`).join(' ');


test('Engine, workers', async (testContext) => {
    const {engine, changes, workers} = await setup(testContext, {'options': {'slowdown': 2}});

    // One worker on a two-core desktop - a module worker, given the models (and the slowdown)
    const g2p = await import('picovox/lib/models/g2pModel.js');
    const voice = await import('picovox/lib/models/voiceModel.js');
    assert.equal(workers.length, 1);
    assert.equal(engine.workers.length, 1);
    assert.ok(workers[0].url instanceof URL);
    assert.ok(workers[0].url.href.endsWith('/lib/worker.js'));
    assert.deepEqual(workers[0].options, {'type': 'module'});
    assert.deepEqual(workers[0].messages, [{
        'type': 'models',
        'g2pModel': g2p.g2pModel,
        'voiceModel': {'manifest': voice.manifest, 'encoding': voice.encoding, 'weights': voice.weights},
        'slowdown': 2
    }]);

    // The clock ticks every 100 ms - a loaded book's first tick reports its unit
    engine.load(threeSentences);
    const count = changes.length;
    testContext.mock.timers.tick(100);
    assert.equal(changes.length, count + 1);
    testContext.mock.timers.tick(100);
    assert.equal(changes.length, count + 1);

    // The pool size - (cores - 1) / 2, from one to three; one on iPhones and iPads
    const poolSize = (nav) => {
        fakeNavigator = nav;
        createdWorkers.length = 0;
        const other = new Engine();
        assert.equal(other.workers.length, createdWorkers.length);
        return createdWorkers.length;
    };
    assert.equal(poolSize({...desktop, 'hardwareConcurrency': 5}), 2);
    assert.equal(poolSize({...desktop, 'hardwareConcurrency': 8}), 3);
    assert.equal(poolSize({...desktop, 'hardwareConcurrency': 32}), 3);
    assert.equal(poolSize({...desktop, 'hardwareConcurrency': undefined}), 1);
    assert.equal(poolSize(iPhone), 1);
    assert.equal(poolSize(iPad), 1);
});


test('Engine, default options', async (testContext) => {
    testContext.mock.timers.enable({'apis': ['setInterval', 'setTimeout']});
    fakeNavigator = {...desktop};
    createdWorkers.length = 0;
    const engine = new Engine();
    assert.equal(engine.slowdown, 1);
    await engine.models;
    await flush();
    assert.equal(createdWorkers[0].messages[0].slowdown, 1);

    // No listener - state changes are fine
    engine.load(threeSentences);
    assert.notEqual(engine.session, null);
});


test('Engine, model import error', async (testContext) => {
    const {engine, changes, workers} = await setup(testContext, {
        'nav': {...desktop, 'hardwareConcurrency': 5},
        'options': {'voiceModelUrl': 'picovox/lib/models/missingModel.js'}
    });

    // The import is tried twice, then each worker reports the error (no models posted)
    await assert.rejects(engine.models, /missingModel/);
    assert.equal(workers.length, 2);
    assert.deepEqual(workers[0].messages, []);
    assert.deepEqual(workers[1].messages, []);
    assert.match(engine.error, /^The speech synthesizer failed to load its models: .*missingModel/);
    assert.equal(changes.length, 2);
    assert.equal(changes[0].status, 'loading');
    assert.equal(events(engine).filter((event) => event.startsWith('model import error: ')).length, 2);
});


test('Engine, worker error', async (testContext) => {
    const {engine, changes, workers} = await setup(testContext, {'nav': {...desktop, 'hardwareConcurrency': 5}});

    // A worker that fails before it's ready is started again (given the models), with no error
    let prevented = 0;
    const preventDefault = () => {
        prevented += 1;
    };
    workers[0].onerror({preventDefault, 'message': 'boom', 'filename': 'worker.js', 'lineno': 12});
    assert.equal(prevented, 1);
    assert.equal(workers.length, 3);
    assert.equal(workers[0].terminated, true);
    assert.equal(workers[0].onmessage, null);
    assert.equal(workers[0].onerror, null);
    assert.equal(engine.workers[0].worker, workers[2]);
    assert.equal(engine.workers[0].starts, 2);
    assert.equal(engine.error, null);
    assert.deepEqual(changes, []);
    assert.ok(events(engine).includes('worker 0 error: boom worker.js:12'));
    await flush();
    assert.deepEqual(posted(workers[2], 'models').length, 1);

    // A second failure is an error
    workers[2].onerror({preventDefault});
    assert.equal(prevented, 2);
    assert.equal(workers.length, 3);
    assert.equal(workers[2].terminated, false);
    assert.equal(engine.error, 'The speech synthesizer failed to start: serve the app over HTTP');
    assert.equal(changes.length, 1);
    assert.ok(events(engine).includes('worker 0 error: (no message) :'));
});


test('Engine, ready worker error', async (testContext) => {
    const {engine, workers} = await setup(testContext);
    engine.load(threeSentences);
    workers[0].send({'type': 'ready'});
    sendUnit(workers[0], 1, 0, [1]);
    sendUnit(workers[0], 1, 1, [0.5], false);
    assert.equal(engine.session.cache[1].slot, 0);

    // Playing - the next unit waits for the rest of its audio
    engine.play();
    const context = engine.audioContext;
    assert.deepEqual(engine.chain.map((entry) => [entry.unit, entry.startTime]), [[0, 0.06], [1, null]]);

    // The worker fails after it's ready, synthesizing the chained unit - it's restarted (its queued messages ignored),
    // its unfinished unit emptied, the units dealt again, and playback restarted from the position
    context.currentTime = 0.56;
    workers[0].send({'type': 'error', 'message': 'out of memory'});
    assert.equal(engine.error, null);
    assert.equal(workers.length, 2);
    assert.equal(workers[0].terminated, true);
    assert.equal(workers[0].onmessage, null);
    assert.equal(workers[0].onerror, null);
    assert.equal(engine.workers[0].worker, workers[1]);
    assert.equal(engine.workers[0].starts, 1);
    assert.ok(events(engine).includes('worker 0 error message: out of memory'));
    assert.deepEqual(engine.session.cache[1], {'blocks': [], 'length': 0, 'done': false, 'run': null, 'slot': null, 'startedAt': null});
    assert.equal(engine.session.cache[0].done, true);
    assert.deepEqual(workers[1].messages.map((message) => message.type), ['prepare', 'units']);
    assert.deepEqual(posted(workers[1], 'units').map((run) => [run.id, run.units.map((unit) => unit.index)]), [[2, [1, 2]]]);
    assert.equal(engine.playing, true);
    assert.ok(context.sources.every((source, ix) => ix === context.sources.length - 1 || source.stopped));
    assert.deepEqual(starts(engine).at(-1), [0.565, 0.445]);

    // The new worker's audio of the unit plays on
    workers[1].send({'type': 'ready'});
    sendUnit(workers[1], 2, 1, [0.5]);
    assert.deepEqual(engine.chain.map((entry) => entry.unit), [0, 1, 2]);
    assert.equal(engine.chain[1].startTime, 1.12);

    // A restarted worker that fails before it's ready gets a fresh start (not counted)
    sendUnit(workers[1], 2, 2, [0.5], false);
    engine.pause();
    await flush();
    workers[1].send({'type': 'error', 'message': 'render worker: boom'});
    assert.equal(workers.length, 3);
    workers[2].onerror({'preventDefault': () => null, 'message': 'no module'});
    assert.equal(workers.length, 4);
    assert.equal(engine.workers[0].starts, 2);
    assert.equal(engine.error, null);

    // Paused - the unfinished unit is dealt again, and playback stays paused
    assert.equal(engine.playing, false);
    assert.equal(engine.session.cache[2].run, null);
    assert.deepEqual(posted(workers[3], 'units').map((run) => [run.id, run.units.map((unit) => unit.index)]), [[4, [2]]]);

    // A third restart, then the fourth failure is an error
    workers[3].send({'type': 'ready'});
    workers[3].send({'type': 'error', 'message': 'out of memory'});
    assert.equal(workers.length, 5);
    assert.equal(engine.workerRestarts, 3);
    workers[4].send({'type': 'ready'});
    workers[4].send({'type': 'error', 'message': 'out of memory'});
    assert.equal(workers.length, 5);
    assert.equal(workers[4].terminated, false);
    assert.equal(engine.error, 'out of memory');

    // A book's load allows restarts again - a book with nothing to read has nothing to deal
    engine.load('  ');
    assert.equal(engine.workerRestarts, 0);
    workers[4].send({'type': 'error', 'message': 'out of memory'});
    assert.equal(workers.length, 6);
    assert.deepEqual(workers[5].messages.map((message) => message.type), ['prepare']);
});


test('Engine, worker error restarts runs', async (testContext) => {
    const {engine, workers} = await setup(testContext, {'nav': {...desktop, 'hardwareConcurrency': 5}});
    engine.load(threeSentences);
    workers[1].send({'type': 'ready'});
    sendUnit(workers[1], 2, 1, [0.5], false);

    // A worker's error message (it couldn't load its models) before it's ready - the worker is restarted (given the
    // models, and prepared) and the units not started dealt again
    workers[0].send({'type': 'error', 'message': 'no models'});
    assert.equal(workers.length, 3);
    assert.equal(workers[0].terminated, true);
    assert.equal(engine.workers[0].worker, workers[2]);
    assert.equal(engine.error, null);
    assert.deepEqual(engine.session.runs, [{'id': 3, 'order': [0]}, {'id': 4, 'order': [2]}]);
    assert.deepEqual(posted(workers[2], 'prepare'), [{'type': 'prepare'}]);
    assert.equal(posted(workers[1], 'prepare').length, 1);
    await flush();
    assert.equal(posted(workers[2], 'models').length, 1);

    // The other worker's unit, half synthesized, is still its
    workers[1].send({'type': 'unitBlock', 'id': 2, 'unit': 1, 'samples': new Float32Array(250), 'sampleRate': 1000});
    workers[1].send({'type': 'unitDone', 'id': 2, 'unit': 1});
    assert.equal(engine.session.cache[1].done, true);
    assert.equal(engine.session.cache[1].length, 0.75);

    // Playing - the units are dealt already
    engine.play();
    assert.deepEqual(posted(workers[2], 'units').map((run) => [run.id, run.units.map((unit) => unit.index)]), [[3, [0]]]);
    assert.deepEqual(posted(workers[1], 'units').map((run) => [run.id, run.units.map((unit) => unit.index)]), [[2, [1]], [4, [2]]]);
});


test('Engine, ready and trace', async (testContext) => {
    const {engine, changes, workers} = await setup(testContext);

    // Loading until a worker is ready
    assert.equal(engine.session, null);
    assert.deepEqual(engine.state(), {
        'status': 'loading', 'char': 0, 'sentenceChar': 0, 'percent': 0, 'sentence': '', 'remainingSeconds': 0
    });
    workers[0].send({'type': 'trace', 'event': 'g2p loaded', 'ms': 12});
    assert.deepEqual(changes, []);
    workers[0].send({'type': 'ready'});
    assert.equal(engine.workerReady, true);
    assert.equal(engine.workers[0].ready, true);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].status, 'paused');
    assert.deepEqual(events(engine).slice(-2), ['worker 0: g2p loaded (+12 ms)', 'worker 0 ready']);

    // Messages without a book are ignored
    workers[0].send({'type': 'unitStart', 'id': 1, 'unit': 0});
    assert.equal(changes.length, 1);
});


test('Engine, load', async (testContext) => {
    const {engine, changes, workers} = await setup(testContext);

    // The voice is prepared and the first units synthesized
    engine.load(threeSentences);
    assert.notEqual(engine.session, null);
    assert.deepEqual(workers[0].messages.slice(1), [
        {'type': 'cancel'},
        {'type': 'prepare'},
        {
            'type': 'units', 'id': 1, 'voice': 'neural-male', 'rate': 1,
            'units': [
                {'index': 0, 'text': 'One fish.', 'paragraphStart': true, 'spans': null, 'beat': null},
                {'index': 1, 'text': 'Two fish.', 'paragraphStart': false, 'spans': null, 'beat': null},
                {'index': 2, 'text': 'Red fish.', 'paragraphStart': false, 'spans': null, 'beat': null}
            ]
        }
    ]);
    assert.deepEqual(changes, [
        {'status': 'loading', 'char': 0, 'sentenceChar': 0, 'percent': 0, 'sentence': 'One fish.', 'remainingSeconds': 29 / 14}
    ]);
    assert.deepEqual(events(engine), ['synthesis from unit 0: units 0-2 dealt']);

    // Loading at a character offset - its sentence
    engine.load(threeSentences, {'voice': 'neural-female', 'rate': 1.5}, 15);
    assert.deepEqual(engine.state(), {
        'status': 'loading', 'char': 10, 'sentenceChar': 10, 'percent': 100 * 10 / 29, 'sentence': 'Two fish.',
        'remainingSeconds': 19 / 21
    });
    const units = posted(workers[0], 'units');
    assert.equal(units.length, 2);
    assert.equal(units[1].voice, 'neural-female');
    assert.equal(units[1].rate, 1.5);
    assert.deepEqual(units[1].units.map((unit) => unit.index), [1, 2]);

    // Past the end - the last sentence
    engine.load(threeSentences, {}, 1000);
    assert.equal(engine.state().sentenceChar, 20);

    // Nothing to read
    engine.load('  ');
    assert.notEqual(engine.session, null);
    assert.deepEqual(engine.state(), {
        'status': 'loading', 'char': 0, 'sentenceChar': 0, 'percent': 0, 'sentence': '', 'remainingSeconds': 0
    });
    assert.equal(posted(workers[0], 'units').length, 3);
    const count = changes.length;
    engine.play();
    engine.skipSentence(1);
    engine.seekChar(5);
    engine.tick();
    assert.equal(engine.playing, false);
    assert.equal(engine.audioContext, null);
    assert.equal(changes.length, count);
    workers[0].send({'type': 'ready'});
    assert.equal(engine.state().status, 'paused');
});


test('Engine, load expressive', async (testContext) => {
    const {engine, workers} = await setup(testContext, {'nav': {...desktop, 'hardwareConcurrency': 5}});

    // The units are dealt to the two workers in turn - quotations styled, and each with its paragraph's beat
    engine.load('One fish. Two fish.\n\nHe said, "Blue fish!" She left.', {'expressive': true});
    const [units0] = posted(workers[0], 'units');
    const [units1] = posted(workers[1], 'units');
    assert.equal(units0.id, 1);
    assert.equal(units1.id, 2);
    assert.deepEqual(units0.units.map((unit) => unit.index), [0, 2]);
    assert.deepEqual(units1.units.map((unit) => unit.index), [1, 3]);
    assert.equal(units0.units[0].spans, null);
    assert.deepEqual(units0.units[1].spans, [
        {'text': 'He said,', 'style': 'neutral'},
        {'text': '"Blue fish!"', 'style': 'exclaim'}
    ]);
    for (const unit of [...units0.units, ...units1.units]) {
        assert.ok(Array.isArray(unit.beat.transforms));
        assert.equal(typeof unit.beat.rate, 'number');
    }
    assert.deepEqual(posted(workers[1], 'prepare'), [{'type': 'prepare'}]);
});


test('Engine, synthesis window', async (testContext) => {
    const {engine, clock, workers} = await setup(testContext);

    // At most 40 units ahead
    engine.load(sixtySentences);
    let units = posted(workers[0], 'units');
    assert.deepEqual(units[0].units.map((unit) => unit.index), Array.from({'length': 40}, (_value, ix) => ix));
    assert.equal(units[0].units[59 - 20].text, 'Sentence 39.');

    // At most 2,500 characters ahead (at least the next unit)
    engine.load(longSentences);
    units = posted(workers[0], 'units');
    assert.equal(units.length, 2);
    assert.deepEqual(units[1].units.map((unit) => unit.index), [0, 1, 2]);

    // Moving within the window, with the units assigned - nothing new
    engine.seekChar(500);
    assert.equal(posted(workers[0], 'units').length, 2);

    // Moving further - a new run (the old one superseded)
    engine.seekChar(engine.session.units[1].start);
    units = posted(workers[0], 'units');
    assert.equal(units.length, 3);
    assert.equal(units[2].id, 3);
    assert.deepEqual(units[2].units.map((unit) => unit.index), [1, 2, 3]);
    assert.deepEqual(engine.session.runs, [{'id': 3, 'order': [1, 2, 3]}]);
    assert.ok(events(engine).includes('synthesis from unit 1: units 1-3 dealt'));

    // A unit a worker has started stays with it, after its run is done
    sendUnit(workers[0], 3, 1, [1], false);
    workers[0].send({'type': 'runDone', 'id': 3});
    assert.deepEqual(engine.session.runs, []);
    engine.seekChar(engine.session.units[1].start);
    units = posted(workers[0], 'units');
    assert.equal(units.length, 4);
    assert.deepEqual(units[3].units.map((unit) => unit.index), [2, 3]);

    // Every unit complete - nothing to synthesize
    workers[0].send({'type': 'unitDone', 'id': 3, 'unit': 1});
    sendUnit(workers[0], 4, 2);
    sendUnit(workers[0], 4, 3);
    workers[0].send({'type': 'runDone', 'id': 4});
    engine.seekChar(engine.session.units[1].start);
    assert.equal(posted(workers[0], 'units').length, 4);

    // The audio more than 2,500 characters ahead is dropped (the next unit's is kept)
    assert.deepEqual(engine.session.cache.slice(0, 4).map((cell) => cell.done), [false, true, true, true]);
    engine.seekChar(0);
    clock.ms = 2001;
    engine.tick();
    assert.deepEqual(engine.session.cache.slice(0, 4).map((cell) => cell.done), [false, true, true, false]);
});


test('Engine, worker messages', async (testContext) => {
    const {engine, clock, workers} = await setup(testContext);
    engine.load(threeSentences);
    const [worker] = workers;
    const {cache} = engine.session;

    // An earlier session's run's messages are ignored
    worker.send({'type': 'unitStart', 'id': 0, 'unit': 0});
    assert.equal(cache[0].run, null);

    // A unit's start, blocks, and end
    clock.ms = 1000;
    engine.onWorkerMessage({'type': 'unitStart', 'id': 1, 'unit': 0});
    assert.equal(cache[0].run, 1);
    assert.equal(cache[0].slot, 0);
    assert.equal(cache[0].startedAt, 1000);
    sendUnit(worker, 1, 0, [0.5, 0.25], false);
    assert.equal(cache[0].blocks.length, 2);
    assert.deepEqual(
        cache[0].blocks.map(({start, duration, sampleRate}) => [start, duration, sampleRate]),
        [[0, 0.5, 1000], [0.5, 0.25, 1000]]
    );
    assert.equal(cache[0].blocks[1].samples.length, 250);
    assert.equal(cache[0].length, 0.75);
    assert.equal(engine.charsPerSecond(), 14);

    // The end - the speaking rate and synthesis speed are measured
    clock.ms = 2500;
    worker.send({'type': 'unitDone', 'id': 1, 'unit': 0});
    assert.equal(cache[0].done, true);
    assert.equal(engine.measuredChars, 9);
    assert.equal(engine.measuredSeconds, 0.75);
    assert.equal(engine.charsPerSecond(), (9 + 14 * 60) / (0.75 + 60));
    assert.equal(engine.synthesizedSeconds, 0.75);
    assert.equal(engine.synthesisSeconds, 1.5);

    // A complete unit's messages are ignored
    sendUnit(worker, 1, 0, [1]);
    assert.equal(cache[0].length, 0.75);

    // The first run to reach a unit owns it - another run's are ignored
    engine.seekChar(10);
    worker.send({'type': 'runDone', 'id': 1});
    engine.seekChar(10);
    assert.deepEqual(engine.session.runs, [{'id': 2, 'order': [1, 2]}]);
    sendUnit(worker, 1, 1, [0.5], false);
    sendUnit(worker, 2, 1, [1]);
    assert.equal(cache[1].run, 1);
    assert.equal(cache[1].length, 0.5);
    assert.equal(cache[1].done, false);

    // A unit's audio without its start is ignored
    worker.send({'type': 'unitDone', 'id': 1, 'unit': 1});
    worker.send({'type': 'unitBlock', 'id': 2, 'unit': 2, 'samples': new Float32Array(100), 'sampleRate': 1000});
    worker.send({'type': 'unitDone', 'id': 2, 'unit': 2});
    assert.deepEqual(cache[2], {'blocks': [], 'length': 0, 'done': false, 'run': null, 'slot': null, 'startedAt': null});
    assert.equal(engine.measuredChars, 18);
    assert.equal(engine.measuredSeconds, 1.25);
    assert.equal(engine.synthesizedSeconds, 1.25);

    // A run's end
    worker.send({'type': 'runDone', 'id': 2});
    assert.deepEqual(engine.session.runs, []);
});


test('Engine, play to the end', async (testContext) => {
    const {engine, changes, workers} = await setup(testContext);
    engine.load(threeSentences);
    workers[0].send({'type': 'ready'});
    for (const unit of [0, 1, 2]) {
        sendUnit(workers[0], 1, unit, [1]);
    }
    const charsPerSecond = (27 + 14 * 60) / (3 + 60);
    assert.equal(engine.charsPerSecond(), charsPerSecond);

    // Play - each unit scheduled after the one before (it's complete), the first after the lead
    engine.play();
    const context = engine.audioContext;
    assert.equal(engine.playing, true);
    assert.deepEqual(starts(engine), [[0.06, 0], [1.06, 0], [2.06, 0]]);
    for (const source of context.sources) {
        assert.equal(source.buffer.length, 1000);
        assert.equal(source.buffer.sampleRate, 1000);
        assert.equal(source.buffer.channels[0].length, 1000);
        assert.deepEqual(source.connections, [engine.output]);
    }
    assert.equal(engine.sources.size, 3);
    assert.equal(changes.at(-1).status, 'buffering');
    const timeline = events(engine);
    assert.ok(timeline.includes('--- play (times from here) ---'));
    assert.ok(timeline.includes('play (unit 0: 1 blocks ready, complete; worker ready)'));
    assert.ok(timeline.includes('first block scheduled (60 ms ahead; audio running, clock 0.00 s)'));

    // Playing - the position interpolated through its sentence
    context.currentTime = 0.56;
    assert.deepEqual(engine.state(), {
        'status': 'playing', 'char': 4.5, 'sentenceChar': 0, 'percent': 100 * 4.5 / 29, 'sentence': 'One fish.',
        'remainingSeconds': (29 - 4.5) / charsPerSecond
    });
    context.currentTime = 1.56;
    assert.equal(engine.state().char, 14.5);
    assert.equal(engine.state().sentence, 'Two fish.');

    // A played source is forgotten
    context.sources[0].onended();
    assert.equal(engine.sources.size, 2);

    // Finished units leave the chain
    context.currentTime = 2.2;
    engine.tick();
    assert.deepEqual(engine.chain.map((entry) => entry.unit), [1, 2]);
    assert.equal(changes.at(-1).sentence, 'Red fish.');

    // The end - stopped, at the end
    context.currentTime = 3.12;
    engine.tick();
    assert.equal(engine.playing, false);
    assert.equal(engine.ended, true);
    assert.deepEqual(changes.at(-1), {
        'status': 'ended', 'char': 29, 'sentenceChar': 20, 'percent': 100, 'sentence': 'Red fish.', 'remainingSeconds': 0
    });
    assert.equal(context.sources[0].stopped, false);
    assert.equal(context.sources[1].stopped, true);
    assert.equal(context.sources[2].stopped, true);
    assert.equal(context.sources[2].onended, null);
    assert.equal(engine.sources.size, 0);
    assert.equal(engine.mediaElement.pauses, 1);

    // Playing again - from the start
    engine.play();
    assert.equal(engine.ended, false);
    assert.equal(engine.audioContext, context);
    assert.deepEqual(starts(engine).slice(3), [[3.18, 0], [4.18, 0], [5.18, 0]]);
    assert.equal(engine.state().status, 'buffering');
    assert.equal(engine.state().char, 0);
});


test('Engine, play while synthesizing', async (testContext) => {
    const {engine, clock, changes, workers} = await setup(testContext);
    engine.load(threeSentences);
    const [worker] = workers;

    // Play before the worker is ready - buffering at the start
    engine.play();
    const context = engine.audioContext;
    assert.ok(events(engine).includes('play (unit 0: 0 blocks ready; worker starting)'));
    assert.equal(changes.at(-1).status, 'buffering');
    assert.equal(engine.state().char, 0);

    // The first block - not enough to play through at an unknown synthesis speed
    clock.ms = 100;
    sendUnit(worker, 1, 0, [0.2], false);
    assert.ok(events(engine).includes('first audio block from the worker'));
    assert.deepEqual(context.sources, []);
    assert.equal(engine.chain[0].startTime, null);

    // Synthesizing at real time - it starts
    clock.ms = 1100;
    worker.send({'type': 'unitBlock', 'id': 1, 'unit': 0, 'samples': new Float32Array(800), 'sampleRate': 1000});
    assert.deepEqual(starts(engine), [[0.06, 0], [0.26, 0]]);

    // A late block delays the rest of the unit (a stall)
    context.currentTime = 1.5;
    worker.send({'type': 'unitBlock', 'id': 1, 'unit': 0, 'samples': new Float32Array(500), 'sampleRate': 1000});
    assert.deepEqual(starts(engine).slice(2), [[1.53, 0]]);
    assert.ok(events(engine).includes('unit 0 stalled 470 ms (block 2)'));
    assert.equal(round(engine.position().time), 0.97);

    // The unit's end - the next unit can be chained, but has no audio yet
    clock.ms = 1600;
    worker.send({'type': 'unitDone', 'id': 1, 'unit': 0});
    assert.deepEqual(engine.chain.map((entry) => [entry.unit, entry.startTime]), [[0, 0.53], [1, null]]);

    // The next unit plays after it, at the measured synthesis speed (faster than real time)
    sendUnit(worker, 1, 1, [0.5], false);
    assert.deepEqual(starts(engine).slice(3), [[2.03, 0]]);
    assert.equal(engine.state().sentence, 'One fish.');

    // A late start - the next unit starts at once
    context.currentTime = 2.6;
    worker.send({'type': 'unitDone', 'id': 1, 'unit': 1});
    sendUnit(worker, 1, 2, [1], true);
    assert.deepEqual(starts(engine).slice(4), [[2.63, 0]]);
    assert.equal(engine.state().sentence, 'Two fish.');
    context.currentTime = 2.7;
    assert.equal(engine.state().sentence, 'Red fish.');
});


test('Engine, schedule ahead', async (testContext) => {
    const {engine, workers} = await setup(testContext);
    engine.load(threeSentences);
    sendUnit(workers[0], 1, 0, [1, 1, 1, 1, 1, 1, 1, 1]);

    // Blocks are scheduled six seconds ahead
    engine.play();
    assert.deepEqual(starts(engine), [[0.06, 0], [1.06, 0], [2.06, 0], [3.06, 0], [4.06, 0], [5.06, 0]]);
    engine.audioContext.currentTime = 1;
    engine.tick();
    assert.deepEqual(starts(engine).slice(6), [[6.06, 0]]);
});


test('Engine, pause and play', async (testContext) => {
    const {engine, changes, workers} = await setup(testContext);
    engine.load(threeSentences);
    workers[0].send({'type': 'ready'});
    sendUnit(workers[0], 1, 0, [1, 1]);

    // Pause mid-unit - stopped there
    engine.play();
    const context = engine.audioContext;
    assert.deepEqual(starts(engine), [[0.06, 0], [1.06, 0]]);
    context.currentTime = 1.56;
    engine.pause();
    assert.equal(engine.playing, false);
    assert.deepEqual(engine.position(), {'unit': 0, 'time': 1.5});
    assert.ok(context.sources.every((source) => source.stopped));
    assert.equal(engine.mediaElement.pauses, 1);
    assert.equal(changes.at(-1).status, 'paused');
    assert.equal(changes.at(-1).char, 6.75);

    // Pausing again does nothing
    const count = changes.length;
    engine.pause();
    assert.equal(changes.length, count);

    // Play - from the pause (the passed block skipped, the next from its offset)
    engine.play();
    assert.deepEqual(starts(engine).slice(2), [[1.565, 0.445]]);
    assert.equal(context.sources.length, 3);
    assert.deepEqual(engine.state(), {
        'status': 'playing', 'char': 6.75, 'sentenceChar': 0, 'percent': 100 * 6.75 / 29, 'sentence': 'One fish.',
        'remainingSeconds': (29 - 6.75) / engine.charsPerSecond()
    });
    context.currentTime = 2.06;
    assert.equal(round(engine.position().time), 1.94);

    // Past the end of the complete unit (the next not ready) - at its end
    context.currentTime = 3;
    assert.deepEqual(engine.position(), {'unit': 0, 'time': 2});
    assert.equal(engine.state().char, 9);

    // Toggle
    engine.toggle();
    assert.equal(engine.playing, false);
    engine.toggle();
    assert.equal(engine.playing, true);
});


test('Engine, position of an incomplete unit', async (testContext) => {
    const {engine, clock, workers} = await setup(testContext);
    engine.load(threeSentences);
    sendUnit(workers[0], 1, 0, [0.2], false);
    clock.ms = 1000;
    workers[0].send({'type': 'unitBlock', 'id': 1, 'unit': 0, 'samples': new Float32Array(2000), 'sampleRate': 1000});

    // Interpolated at the estimated speaking rate, to at most 95% of the sentence
    engine.play();
    const context = engine.audioContext;
    context.currentTime = 0.36;
    assert.equal(engine.state().char, 0.3 / (9 / 14) * 9);
    context.currentTime = 1.06;
    assert.equal(engine.state().char, 0.95 * 9);
});


test('Engine, skipSentence', async (testContext) => {
    const {engine, workers} = await setup(testContext);

    // Nothing loaded
    engine.skipSentence(1);
    assert.equal(engine.session, null);

    // Paused - a sentence forward and back
    engine.load(threeSentences, {}, 15);
    engine.skipSentence(1);
    assert.equal(engine.state().sentenceChar, 20);
    engine.skipSentence(-1);
    assert.equal(engine.state().sentenceChar, 10);
    engine.skipSentence(-1);
    assert.equal(engine.state().sentenceChar, 0);
    engine.skipSentence(-1);
    assert.equal(engine.state().sentenceChar, 0);

    // Past the last sentence - the end (an incomplete sentence's start)
    engine.load(threeSentences, {}, 25);
    engine.skipSentence(1);
    assert.equal(engine.ended, true);
    assert.deepEqual(engine.state(), {
        'status': 'ended', 'char': 20, 'sentenceChar': 20, 'percent': 100 * 20 / 29, 'sentence': 'Red fish.',
        'remainingSeconds': 9 / 14
    });
    engine.skipSentence(-1);
    assert.equal(engine.ended, false);
    assert.equal(engine.state().sentenceChar, 10);

    // Playing - back more than two seconds into a sentence restarts it, else goes to the previous one
    engine.load(threeSentences);
    workers[0].send({'type': 'ready'});
    const [{id}] = engine.session.runs;
    sendUnit(workers[0], id, 0, [1]);
    sendUnit(workers[0], id, 1, [3]);
    sendUnit(workers[0], id, 2, [1]);
    engine.play();
    const context = engine.audioContext;
    assert.deepEqual(starts(engine), [[0.06, 0], [1.06, 0], [4.06, 0]]);
    context.currentTime = 3.56;
    engine.skipSentence(-1);
    assert.deepEqual(starts(engine).slice(3), [[3.62, 0], [6.62, 0]]);
    assert.ok(context.sources.slice(0, 3).every((source) => source.stopped));
    assert.equal(engine.state().sentenceChar, 10);
    context.currentTime = 4.62;
    engine.skipSentence(-1);
    assert.deepEqual(starts(engine).slice(5), [[4.68, 0], [5.68, 0], [8.68, 0]]);
    assert.equal(engine.state().sentenceChar, 0);
    context.currentTime = 4.7;
    engine.skipSentence(1);
    assert.equal(engine.playing, true);
    assert.deepEqual(starts(engine).slice(8), [[4.76, 0], [7.76, 0]]);
    assert.equal(engine.state().sentenceChar, 10);

    // Past the end while playing - ended at the end
    context.currentTime = 7.8;
    engine.skipSentence(1);
    assert.equal(engine.playing, false);
    assert.equal(engine.state().status, 'ended');
    assert.equal(engine.state().char, 29);
});


test('Engine, seekChar', async (testContext) => {
    const {engine, changes, workers} = await setup(testContext);

    // Nothing loaded
    engine.seekChar(10);
    assert.deepEqual(changes, []);

    // Paused - the sentence at the character
    engine.load(sixtySentences);
    engine.seekChar(engine.session.units[45].start + 3);
    assert.equal(engine.state().sentence, 'Sentence 45.');
    assert.equal(changes.at(-1).sentence, 'Sentence 45.');
    const units = posted(workers[0], 'units');
    assert.equal(units.length, 2);
    assert.deepEqual(units[1].units.map((unit) => unit.index), Array.from({'length': 15}, (_value, ix) => 45 + ix));

    // Playing - from there
    sendUnit(workers[0], units[1].id, 45, [1]);
    sendUnit(workers[0], units[1].id, 46, [1]);
    engine.play();
    assert.deepEqual(starts(engine), [[0.06, 0], [1.06, 0]]);
    engine.seekChar(engine.session.units[46].start);
    assert.equal(engine.playing, true);
    assert.deepEqual(starts(engine).slice(2), [[0.06, 0]]);
    assert.ok(engine.audioContext.sources[0].stopped);
    assert.equal(engine.state().sentence, 'Sentence 46.');

    // At the end - seeking leaves the end
    engine.load(threeSentences, {}, 25);
    engine.skipSentence(1);
    assert.equal(engine.ended, true);
    engine.seekChar(0);
    assert.equal(engine.ended, false);
    assert.equal(engine.state().char, 0);
});


test('Engine, setVoice', async (testContext) => {
    const {engine, workers} = await setup(testContext);

    // Nothing loaded
    engine.setVoice({'voice': 'neural-female', 'rate': 1});
    assert.equal(engine.session, null);
    assert.equal(workers[0].messages.length, 1);

    // The same voice - nothing to do
    engine.load(threeSentences);
    const count = workers[0].messages.length;
    engine.setVoice({'voice': 'neural-male', 'rate': 1});
    assert.equal(workers[0].messages.length, count);

    // Paused - reloaded at the sentence
    engine.seekChar(12);
    engine.setVoice({'voice': 'neural-female', 'rate': 1.25, 'expressive': true});
    assert.equal(engine.playing, false);
    assert.equal(engine.session.voice, 'neural-female');
    assert.equal(engine.session.rate, 1.25);
    assert.equal(engine.session.expressive, true);
    assert.equal(engine.state().sentenceChar, 10);
    assert.deepEqual(workers[0].messages.slice(count).map((message) => message.type), ['cancel', 'prepare', 'units']);
    assert.equal(posted(workers[0], 'units').at(-1).voice, 'neural-female');

    // Playing - playing on in the new voice
    const [{id}] = engine.session.runs;
    sendUnit(workers[0], id, 1, [1]);
    sendUnit(workers[0], id, 2, [1]);
    engine.play();
    engine.audioContext.currentTime = 1.56;
    engine.setVoice({'voice': 'neural-female', 'rate': 1});
    assert.equal(engine.playing, true);
    assert.equal(engine.session.rate, 1);
    assert.equal(engine.state().sentenceChar, 20);
    assert.equal(engine.state().status, 'buffering');
});


test('Engine, audio', async (testContext) => {
    const {engine, workers} = await setup(testContext, {'nav': {...desktop, 'hardwareConcurrency': 5}});
    const revokeObjectURL = testContext.mock.method(URL, 'revokeObjectURL');
    engine.load(threeSentences);
    sendUnit(workers[0], 1, 0, [1]);

    // The audio is created on the first play, at PicoVox's sample rate - Web Audio plays directly, and a silent looping
    // media element keeps the audio session
    engine.play();
    const context = engine.audioContext;
    assert.deepEqual(context.options, {'latencyHint': 'playback', 'sampleRate': defaultSampleRate});
    assert.equal(context.resumes, 1);
    assert.equal(engine.output.name, 'gain');
    assert.deepEqual(engine.output.connections, [context.destination]);
    const media = engine.mediaElement;
    assert.equal(media.tagName, 'audio');
    assert.deepEqual(media.attributes, {'playsinline': ''});
    assert.equal(media.loop, true);
    assert.match(media.src, /^blob:/);
    assert.equal(media.srcObject, null);
    assert.equal(media.plays, 1);
    assert.ok(events(engine).includes('audio created (48000 Hz, suspended)'));
    context.baseLatency = 0.0123;
    context.outputLatency = 0.02;
    await flush();
    assert.ok(events(engine).includes('audio resumed (base latency 12 ms, output 20 ms)'));
    assert.ok(events(engine).includes('media element playing'));

    // The silent audio - a second of silence
    const wav = new Uint8Array(await (await fetch(media.src)).arrayBuffer());
    assert.equal(wav.length, 44 + 2 * 8000);
    assert.ok(wav.slice(44).every((byte) => byte === 0));

    // An interrupted audio context is resumed while playing
    context.state = 'interrupted';
    context.onstatechange();
    assert.equal(context.resumes, 2);
    assert.ok(events(engine).includes('audio interrupted'));
    context.state = 'closed';
    context.onstatechange();
    context.state = 'running';
    context.onstatechange();
    assert.equal(context.resumes, 2);

    // A pause pauses the media element and suspends the audio - not resumed while paused
    engine.pause();
    assert.equal(media.pauses, 1);
    assert.equal(context.suspends, 1);
    assert.equal(context.state, 'suspended');
    context.onstatechange();
    assert.equal(context.resumes, 2);

    // Later plays reuse the audio - a refused media element play is fine
    refusePlay = true;
    engine.play();
    assert.equal(engine.audioContext, context);
    assert.equal(engine.mediaElement, media);
    assert.equal(context.resumes, 3);
    assert.equal(media.plays, 2);
    await flush();
    assert.ok(events(engine).includes('media element refused'));
    assert.ok(events(engine).includes('audio resumed (base latency 12 ms, output 20 ms)'));
    refusePlay = false;

    // A broken output - the audio context closed or interrupted, or the media element ended - is rebuilt on play
    for (const [breakAudio, event] of [
        [() => {
            engine.audioContext.state = 'closed';
        }, 'audio rebuilt (audio closed)'],
        [() => {
            engine.audioContext.state = 'interrupted';
        }, 'audio rebuilt (audio interrupted)'],
        [() => {
            engine.mediaElement.ended = true;
        }, 'audio rebuilt (audio suspended, media ended)']
    ]) {
        engine.pause();
        const brokenContext = engine.audioContext;
        const brokenMedia = engine.mediaElement;
        const {pauses} = brokenMedia;
        breakAudio();
        engine.play();
        assert.notEqual(engine.audioContext, brokenContext);
        assert.notEqual(engine.mediaElement, brokenMedia);
        assert.equal(brokenContext.onstatechange, null);
        assert.equal(brokenMedia.pauses, pauses + 1);
        assert.equal(engine.mediaElement.plays, 1);
        assert.ok(events(engine).includes(event));
        // (the silent loop's blob URL released)
        assert.deepEqual(revokeObjectURL.mock.calls.at(-1).arguments, [brokenMedia.src]);
        await flush();
    }
    assert.equal(revokeObjectURL.mock.calls.length, 3);

    // The browser closed the audio context while playing - a pause can't suspend it (no unhandled rejection)
    const closedContext = engine.audioContext;
    closedContext.state = 'closed';
    engine.pause();
    assert.equal(engine.mediaElement.pauses, 1);
    assert.equal(closedContext.suspends, 0);
    await flush();
});


test('Engine, audio on iOS', async (testContext) => {
    const audioSession = {'type': 'auto'};
    const {engine, workers} = await setup(testContext, {'nav': {...iPhone, audioSession}});
    const revokeObjectURL = testContext.mock.method(URL, 'revokeObjectURL');
    engine.load(threeSentences);
    sendUnit(workers[0], 1, 0, [1]);

    // The speech plays through the media element (in the playback audio session)
    engine.play();
    const context = engine.audioContext;
    const media = engine.mediaElement;
    assert.equal(fakeNavigator.audioSession.type, 'playback');
    assert.equal(engine.output.connections.length, 1);
    assert.equal(engine.output.connections[0].name, 'streamDestination');
    assert.equal(media.srcObject, engine.output.connections[0].stream);
    assert.equal(media.loop, false);
    assert.equal(media.src, null);
    assert.ok(events(engine).includes('audio routed through the media element'));
    await flush();
    assert.ok(events(engine).includes('audio resumed (base latency 0 ms, output 0 ms)'));
    assert.equal(context.resumes, 1);

    // A pause pauses the media element at once (the lock screen shows the book paused) and suspends the audio
    engine.pause();
    assert.equal(media.pauses, 1);
    assert.equal(context.suspends, 1);

    // A play resumes them
    engine.play();
    assert.equal(engine.mediaElement, media);
    assert.equal(media.plays, 2);
    assert.equal(context.resumes, 2);

    // The media element's stream ended during a pause (iOS, a long pause) - the output is rebuilt
    engine.pause();
    media.srcObject.track.readyState = 'ended';
    engine.play();
    assert.notEqual(engine.audioContext, context);
    assert.notEqual(engine.mediaElement, media);
    assert.equal(engine.mediaElement.srcObject, engine.output.connections[0].stream);
    assert.equal(engine.mediaElement.plays, 1);
    assert.ok(events(engine).includes('audio rebuilt (audio suspended, stream ended)'));
    assert.equal(revokeObjectURL.mock.calls.length, 0);

    // Unloading releases it
    const rebuilt = engine.mediaElement;
    engine.unload();
    assert.equal(rebuilt.pauses, 1);
});


test('Engine, unload', async (testContext) => {
    const {engine, changes, workers} = await setup(testContext);

    // Before any audio
    engine.load(threeSentences);
    engine.unload();
    assert.equal(engine.session, null);
    assert.equal(engine.mediaElement, null);
    assert.equal(changes.at(-1).status, 'loading');
    assert.equal(workers[0].messages.at(-1).type, 'cancel');

    // Playing - stopped, released, and the runs cancelled
    engine.load(threeSentences);
    sendUnit(workers[0], 2, 0, [1]);
    engine.play();
    engine.unload();
    assert.equal(engine.session, null);
    assert.equal(engine.playing, false);
    assert.equal(engine.audioContext.sources[0].stopped, true);
    assert.equal(engine.mediaElement.pauses, 1);
    assert.deepEqual(workers[0].messages.at(-1), {'type': 'cancel'});
    assert.equal(engine.state().status, 'loading');
    assert.equal(engine.charsPerSecond(), (9 + 14 * 60) / 61);
});


test('Engine, tick', async (testContext) => {
    const {engine, clock, changes, workers} = await setup(testContext);
    engine.tick();
    assert.deepEqual(changes, []);

    // A tick reports a new unit
    engine.load(sixtySentences);
    for (let unit = 0; unit < 10; unit++) {
        sendUnit(workers[0], 1, unit, [1]);
    }
    let count = changes.length;
    engine.tick();
    assert.equal(changes.length, count + 1);
    engine.tick();
    assert.equal(changes.length, count + 1);

    // Every two seconds, the audio outside the window around the position is dropped
    engine.seekChar(engine.session.units[50].start);
    count = changes.length;
    clock.ms = 2001;
    engine.tick();
    assert.equal(changes.length, count + 1);
    assert.ok(engine.session.cache.slice(0, 42).every((cell) => !cell.done && cell.blocks.length === 0 && cell.run === null));
    engine.seekChar(0);
    assert.deepEqual(posted(workers[0], 'units').at(-1).units.map((unit) => unit.index), Array.from({'length': 40}, (_value, ix) => ix));
});


test('Engine, tick playing', async (testContext) => {
    const {engine, clock, workers} = await setup(testContext);
    engine.load(sixtySentences);
    for (let unit = 0; unit < 3; unit++) {
        sendUnit(workers[0], 1, unit, [1]);
    }

    // Playing, a tick keeps the units ahead synthesizing
    engine.play();
    const context = engine.audioContext;
    context.currentTime = 2.56;
    clock.ms = 2500;
    engine.tick();
    const units = posted(workers[0], 'units');
    assert.equal(units.length, 2);
    assert.deepEqual(units[1].units.map((unit) => unit.index), Array.from({'length': 39}, (_value, ix) => 3 + ix));
    assert.ok(events(engine).includes('synthesis from unit 2: units 3-41 dealt'));

    // Every two seconds, the clock is noted
    assert.ok(events(engine).includes('clock 2.56 s, audio running, 3 sources'));
    context.currentTime = 2.6;
    clock.ms = 4000;
    engine.tick();
    assert.ok(!events(engine).includes('clock 2.60 s, audio running, 3 sources'));
    clock.ms = 4501;
    engine.tick();
    assert.ok(events(engine).includes('clock 2.60 s, audio running, 3 sources'));

    // The playing units' audio is kept, outside the window (the finished unit left the chain)
    assert.deepEqual(engine.chain.map((entry) => entry.unit), [1, 2, 3]);
    engine.evictCache(30);
    assert.deepEqual(engine.session.cache.slice(0, 3).map((cell) => cell.done), [false, true, true]);
    engine.pause();
    engine.evictCache(30);
    assert.deepEqual(engine.session.cache.slice(0, 3).map((cell) => cell.done), [false, false, false]);
});


test('Engine, unitCanStart', async (testContext) => {
    const {engine, clock, workers} = await setup(testContext);
    engine.load(`${longSentence} ${longSentence}`);
    assert.equal(engine.session.units[0].text.length, 140);
    const [worker] = workers;

    // No audio, or no measured speed - it can't
    assert.equal(engine.unitCanStart(0), false);
    sendUnit(worker, 1, 0, [4], false);
    assert.equal(engine.unitCanStart(0), false);

    // Synthesizing slower than real time - when what's synthesized covers playing it through (est. 10 s)
    clock.ms = 10000;
    assert.equal(engine.synthesisSpeed(engine.session.cache[0]), 0.4);
    assert.equal(engine.unitCanStart(0), false);
    worker.send({'type': 'unitBlock', 'id': 1, 'unit': 0, 'samples': new Float32Array(3000), 'sampleRate': 1000});
    assert.equal(round(engine.synthesisSpeed(engine.session.cache[0])), 0.7);
    assert.equal(engine.unitCanStart(0), true);
    assert.equal(engine.unitCanStart(0, 4), true);
    assert.equal(engine.unitCanStart(0, 6), false);

    // Complete
    worker.send({'type': 'unitDone', 'id': 1, 'unit': 0});
    assert.equal(engine.unitCanStart(0), true);

    // A unit just started - the measured speed of the completed units
    sendUnit(worker, 1, 1, [0.5], false);
    assert.equal(engine.synthesisSpeed(engine.session.cache[1]), 0.7);
    assert.equal(engine.unitCanStart(1), false);
});


test('Engine, timeline', async (testContext) => {
    const {engine, clock} = await setup(testContext);

    // Times since the last play, at most 300 events
    clock.ms = 1234.4;
    engine.mark('first');
    assert.deepEqual(engine.timeline.at(-1), {'ms': 1234, 'event': 'first'});
    for (let ix = 0; ix < 300; ix++) {
        engine.mark(`event ${ix}`);
    }
    assert.equal(engine.timeline.length, 300);
    assert.equal(engine.timeline[0].event, 'event 0');
    assert.equal(engine.timeline[299].event, 'event 299');
});


test('Engine, play while playing', async (testContext) => {
    const {engine, workers} = await setup(testContext);
    engine.load(threeSentences);
    sendUnit(workers[0], 1, 0, [1]);
    sendUnit(workers[0], 1, 1, [1]);

    // A play while playing (the lock screen's, the media element paused by the browser - another app's audio, say) plays
    // on from the position, not from where playback began
    engine.play();
    const context = engine.audioContext;
    context.currentTime = 1.56;
    engine.play();
    assert.equal(engine.playing, true);
    assert.deepEqual(engine.position(), {'unit': 1, 'time': 0.5});
    assert.ok(context.sources.slice(0, 2).every((source) => source.stopped));
    assert.deepEqual(starts(engine).slice(2), [[1.565, 0.445]]);
    assert.ok(events(engine).includes('play (unit 1: 1 blocks ready, complete; worker starting)'));

    // The output rebuilt while playing (as a book is opened) - stopped at the position
    context.currentTime = 1.86;
    context.state = 'closed';
    engine.ensureAudio();
    assert.equal(engine.playing, false);
    assert.notEqual(engine.audioContext, context);
    assert.ok(context.sources.every((source) => source.stopped));
    engine.pause();
    assert.deepEqual(engine.position(), {'unit': 1, 'time': 0.74});
});


test('Engine, a unit evicted while it\'s synthesized', async (testContext) => {
    const {engine, clock, workers} = await setup(testContext);
    engine.load(sixtySentences);
    sendUnit(workers[0], 1, 5, [0.5], false);

    // Evicted - its remaining audio is dropped (it's synthesized again when it's needed)
    engine.seekChar(engine.session.units[50].start);
    clock.ms = 2001;
    engine.tick();
    workers[0].send({'type': 'unitBlock', 'id': 1, 'unit': 5, 'samples': new Float32Array(250), 'sampleRate': 1000});
    workers[0].send({'type': 'unitDone', 'id': 1, 'unit': 5});
    assert.deepEqual(engine.session.cache[5], {'blocks': [], 'length': 0, 'done': false, 'run': null, 'slot': null, 'startedAt': null});
    engine.seekChar(engine.session.units[5].start);
    assert.deepEqual(posted(workers[0], 'units').at(-1).units[0].index, 5);
});
