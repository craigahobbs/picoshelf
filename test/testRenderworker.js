import {createSentenceRenderer, defaultSampleRate, modelLoader, sentenceFrames, sentencePause} from 'picovox/lib/synthesis.js';
import {strict as assert} from 'node:assert';
import test from 'node:test';


// The worker globals - self, its posted messages (and their transfer lists), and its onmessage (set by renderworker.js)
const posted = [];
globalThis.self = {
    'postMessage': (message, transfer) => {
        posted.push({message, transfer});
    }
};
await import('../lib/renderworker.js');
const send = (data) => globalThis.self.onmessage({data});


// The voice model
const model = await modelLoader(() => import('picovox/lib/models/g2pModel.js'), () => import('picovox/lib/models/voiceModel.js'))();


// A chunk of frames as the synthesis worker sends it - the rows end to end
function packFrames(chunk) {
    const width = chunk[0].length;
    const frames = new Float64Array(chunk.length * width);
    for (const [row, frame] of chunk.entries()) {
        frames.set(frame, row * width);
    }
    return frames;
}


// Blocks concatenated
function concat(blocks) {
    const samples = new Float32Array(blocks.reduce((sum, block) => sum + block.length, 0));
    let offset = 0;
    for (const block of blocks) {
        samples.set(block, offset);
        offset += block.length;
    }
    return samples;
}


test('renderworker, unit', () => {
    posted.length = 0;
    const {chunks, eq} = sentenceFrames(model, 'Call me Ishmael.', {'voice': 'male'});
    const frameChunks = [...chunks];
    assert.ok(frameChunks.length > 1);

    // The unit, its frames a chunk at a time (an empty chunk too - it adds nothing)
    send({'type': 'begin', 'id': 7, 'unit': 3, eq, 'seed': 1003, 'pause': sentencePause, 'rate': 1.25});
    for (const chunk of frameChunks) {
        send({'type': 'frames', 'id': 7, 'unit': 3, 'frames': packFrames(chunk), 'count': chunk.length});
    }
    send({'type': 'frames', 'id': 7, 'unit': 3, 'frames': new Float64Array(0), 'count': 0});
    send({'type': 'end', 'id': 7, 'unit': 3});
    send({'type': 'runEnd', 'id': 7});

    // The blocks - the pause, then the unit's audio as the renderer makes it
    const expected = [];
    const renderer = createSentenceRenderer({
        'onBlock': (block) => expected.push(block), eq, 'rate': 1.25, 'seed': 1003, 'pause': sentencePause
    });
    for (const chunk of frameChunks) {
        renderer.push(chunk);
    }
    renderer.end();
    const blocks = posted.slice(0, -2);
    assert.equal(blocks.length, expected.length);
    for (const {message, transfer} of blocks) {
        assert.deepEqual(Object.keys(message), ['type', 'id', 'unit', 'samples', 'sampleRate']);
        assert.equal(message.type, 'unitBlock');
        assert.equal(message.id, 7);
        assert.equal(message.unit, 3);
        assert.equal(message.sampleRate, defaultSampleRate);
        assert.deepEqual(transfer, [message.samples.buffer]);
    }
    assert.deepEqual(blocks[0].message.samples, new Float32Array(Math.round(defaultSampleRate * sentencePause / 1.25)));
    assert.deepEqual(concat(blocks.map(({message}) => message.samples)), concat(expected));

    // The unit's end and the run's end
    const [unitDone, runDone] = posted.slice(-2);
    assert.equal(unitDone.message.type, 'unitDone');
    assert.equal(unitDone.message.id, 7);
    assert.equal(unitDone.message.unit, 3);
    assert.ok(Number.isInteger(unitDone.message.renderMs) && unitDone.message.renderMs >= 0);
    assert.deepEqual(runDone, {'message': {'type': 'runDone', 'id': 7}, 'transfer': undefined});
});


test('renderworker, unit without a pause', () => {
    posted.length = 0;
    send({'type': 'begin', 'id': 1, 'unit': 0, 'eq': null, 'seed': 1, 'pause': 0, 'rate': 1});
    assert.equal(posted.length, 0);
    send({'type': 'end', 'id': 1, 'unit': 0});
    assert.ok(posted.slice(0, -1).every(({message}) => message.type === 'unitBlock'));
    assert.deepEqual(posted.at(-1).message, {'type': 'unitDone', 'id': 1, 'unit': 0, 'renderMs': posted.at(-1).message.renderMs});
});


test('renderworker, unknown message', () => {
    posted.length = 0;
    send({'type': 'other'});
    assert.deepEqual(posted, []);
});


test('renderworker, error', () => {
    // Frames before a unit's begin
    posted.length = 0;
    send({'type': 'frames', 'id': 1, 'unit': 0, 'frames': new Float64Array(32), 'count': 1});
    assert.equal(posted.length, 1);
    assert.equal(posted[0].message.type, 'error');
    assert.match(posted[0].message.message, /^Cannot read properties of null \(reading 'push'\) \(TypeError: /);

    // An end before a unit's begin
    posted.length = 0;
    send({'type': 'end', 'id': 1, 'unit': 0});
    assert.equal(posted.length, 1);
    assert.equal(posted[0].message.type, 'error');
    assert.match(posted[0].message.message, /reading 'end'/);
});
