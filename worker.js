// The synthesis Web Worker - loads the G2P network (letters to phonemes, for every word - no dictionary), then speaks
// the player's units (sentences) with the neural voices, posting small blocks of samples as they are synthesized so
// playback starts almost immediately. It runs the voice network and has its own render worker (renderworker.js) render
// the frames as they come - the two at once, on two cores - relaying the render worker's blocks to the engine. The
// synthesis functions are exported so they also run under Node.
//
// Messages in:
// - {'type': 'units', 'id', 'units': [{'index', 'text', 'paragraphStart'}], 'voice', 'rate'} speaks the units in order,
//   posting {'type': 'unitStart', 'id', 'unit'}, {'type': 'unitBlock', 'id', 'unit', 'samples', 'sampleRate'}, and
//   {'type': 'unitDone', 'id', 'unit'} for each, then {'type': 'runDone', 'id'}. A newer run or a cancel supersedes a run between units.
// - {'type': 'models', 'g2pModel', 'voiceModel': {'manifest', 'encoding', 'weights'}} - the generated model modules
//   (picovox/lib/models/), imported once by the engine for all of its workers (a worker's own import would download them
//   again).
//   The worker waits for it before loading either network. Its slowdown (default 1) stretches each unit's synthesis that
//   many times, by waiting - to reproduce a device slower than real time.
// - {'type': 'prepare', 'voice'} loads the voice's model ahead of playback.
// - {'type': 'cancel'} stops the current run.
// Messages out also include {'type': 'ready'} (the G2P network is loaded) and {'type': 'error', 'id', 'message'}.
//
// A voice is a voice of PicoVox's multi-speaker neural model (picovox/lib/models/voiceModel.js), unpacked on first use,
// and a unit is spoken by PicoVox's synthesis pipeline (picovox/lib/synthesis.js) - picovox/ is a copy of the npm
// package picovox's lib/ (make picovox).

import {paragraphPause, sentenceBlocks, sentenceFrames, sentencePause, voiceSpeaker} from './picovox/lib/synthesis.js';
import {setPronouncer, textToPhrases} from './picovox/lib/lexicon.js';
import {loadG2p} from './picovox/lib/g2p.js';
import {loadPackagedModel} from './picovox/lib/package.js';


// The app's voices - each a PicoVox voice (by key)
export const neuralVoices = {'neural-male': 'male', 'neural-female': 'female'};


// Load the multi-speaker neural model - imported and unpacked once, shared by every neural voice. importModule is the
// generated module's import (replaceable for tests).
let neuralModel = null;
export function loadNeuralModel(importModule = () => import('./picovox/lib/models/voiceModel.js'), trace = () => null) {
    if (neuralModel === null) {
        neuralModel = importModule().then((module) => {
            trace('voice model imported');
            return loadPackagedModel(module);
        }).then((model) => {
            trace('voice model unpacked');
            return model;
        });
        neuralModel.catch(() => {
            neuralModel = null;
        });
    }
    return neuralModel;
}


// An app voice's speaker id in the model's speaker table
export function neuralSpeaker(model, voice) {
    return voiceSpeaker(model, neuralVoices[voice]);
}


// A unit's (sentence's) audio - a pause, then the unit's audio, at PicoVox's sample rate (defaultSampleRate) - as an
// iterator of blocks (Float32Array) made as they're taken. options: speaker (neuralSpeaker), rate (the speaking speed - 1
// is normal), seed (the renderer's noise seed), and paragraphStart (a longer pause).
export function unitBlocks(model, text, {speaker, rate = 1, seed = 1, paragraphStart = false}) {
    return sentenceBlocks(model, text, {speaker, rate, seed, 'pause': paragraphStart ? paragraphPause : sentencePause});
}


// The worker message loop (only when running as a worker)
if (typeof globalThis.WorkerGlobalScope !== 'undefined' && self instanceof globalThis.WorkerGlobalScope) {
    // Trace the worker's milestones (ms since it started) - the engine's startup timeline
    const workerStart = performance.now();
    const trace = (event) => {
        self.postMessage({'type': 'trace', event, 'ms': Math.round(performance.now() - workerStart)});
    };
    // The engine's models message
    let receiveModels;
    const models = new Promise((resolve) => {
        receiveModels = resolve;
    });
    const loadModel = () => loadNeuralModel(() => models.then(({voiceModel}) => voiceModel), trace);
    let slowdown = 1;
    trace('started');

    // A JavaScript speed check - a fixed arithmetic workload (a few milliseconds with a JIT; far slower without one, as
    // in iOS Lockdown Mode)
    const speedStart = performance.now();
    const values = new Float64Array(4096);
    let sum = 0;
    for (let pass = 0; pass < 500; pass++) {
        for (let ix = 0; ix < values.length; ix++) {
            values[ix] = values[ix] * 0.999 + ix;
            sum += values[ix];
        }
    }
    trace(`speed check: ${Math.round(performance.now() - speedStart)} ms (checksum ${Math.round(sum) % 1000})`);

    // Load the G2P network on startup - every word's pronunciation
    const ready = models.then(({g2pModel}) => {
        trace('models received');
        return loadG2p(g2pModel);
    }).then((pronounce) => {
        setPronouncer(pronounce);
        trace('G2P model unpacked');
        self.postMessage({'type': 'ready'});
    });
    ready.catch((error) => {
        self.postMessage({'type': 'error', 'id': null, 'message': `${error.message} (${error.stack})`});
    });

    // The render worker - its blocks, unit ends, and run ends relayed to the engine (its errors as the worker's)
    const renderWorker = new Worker(new URL('renderworker.js', import.meta.url), {'type': 'module'});
    renderWorker.onmessage = ({data}) => {
        if (data.type === 'unitDone') {
            trace(`unit ${data.unit}: render ${data.renderMs} ms`);
        }
        self.postMessage(data, data.type === 'unitBlock' ? [data.samples.buffer] : []);
    };
    renderWorker.onerror = (event) => {
        event.preventDefault();
        self.postMessage({'type': 'error', 'id': null, 'message': `render worker: ${event.message || '(no message)'}`});
    };

    // Yield to the event loop at once (a message to ourselves - setTimeout can wait milliseconds), so the render worker's
    // blocks are relayed while the network works
    const yieldChannel = new MessageChannel();
    const yieldWaiters = [];
    yieldChannel.port1.onmessage = () => yieldWaiters.shift()();
    const yieldNow = () => new Promise((resolve) => {
        yieldWaiters.push(resolve);
        yieldChannel.port2.postMessage(null);
    });

    // Unit runs - the latest run supersedes earlier ones between units. The unit a superseded run was finishing may also
    // start the new run (the engine dealt it before the unit's start reached it) - it's skipped, already done. Each unit's
    // frames go to the render worker a chunk at a time; it posts the unit's blocks, its end, and the run's end.
    let currentRun = 0;
    let finished = null;
    // (one unit at a time - a run's unit yields between its chunks, so a newer run waits for it: the render worker takes
    // one unit's frames at a time)
    let unitLock = Promise.resolve();
    const runUnits = async ({id, units, voice, rate}) => {
        const run = ++currentRun;
        const factor = slowdown;
        await ready;
        const model = await loadModel();
        const speaker = neuralSpeaker(model, voice);
        for (const [index, unit] of units.entries()) {
            const previous = unitLock;
            let release;
            unitLock = new Promise((resolve) => {
                release = resolve;
            });
            await previous;
            if (run !== currentRun) {
                release();
                return;
            }
            if (index === 0 && finished !== null && finished.run === run - 1 && finished.unit === unit.index &&
                finished.voice === voice && finished.rate === rate) {
                release();
                continue;
            }
            try {
                const unitStart = performance.now();
                // Claim the unit at once, so the engine doesn't deal it to another run while it's pronounced
                self.postMessage({'type': 'unitStart', id, 'unit': unit.index});
                // Pronounce the unit's words first (cached), to time the G2P apart from the voice network
                const words = textToPhrases(unit.text).reduce((count, phrase) => count + phrase.words.length, 0);
                trace(`unit ${unit.index}: G2P ${words} words in ${Math.round(performance.now() - unitStart)} ms`);
                const pause = unit.paragraphStart ? paragraphPause : sentencePause;
                const {chunks, eq} = sentenceFrames(model, unit.text, {speaker, rate});
                renderWorker.postMessage({'type': 'begin', id, 'unit': unit.index, eq, 'seed': 1000 + unit.index, pause, rate});
                let networkMs = 0;
                let networkStart = performance.now();
                for (const chunk of chunks) {
                    const count = chunk.length;
                    const width = count === 0 ? 0 : chunk[0].length;
                    const frames = new Float64Array(count * width);
                    for (const [row, frame] of chunk.entries()) {
                        frames.set(frame, row * width);
                    }
                    // The slowdown - wait until the unit's network has taken slowdown times its time so far
                    const work = performance.now() - networkStart;
                    while (performance.now() < networkStart + factor * work) {
                        // Busy - as a slow device would be
                    }
                    networkMs += performance.now() - networkStart;
                    renderWorker.postMessage({'type': 'frames', id, 'unit': unit.index, frames, count}, [frames.buffer]);
                    await yieldNow();
                    networkStart = performance.now();
                }
                networkMs += performance.now() - networkStart;
                renderWorker.postMessage({'type': 'end', id, 'unit': unit.index});
                trace(`unit ${unit.index}: network ${Math.round(networkMs)} ms`);
                finished = {run, 'unit': unit.index, voice, rate};
            } finally {
                release();
            }
            // Yield, so a newer run or a cancel can arrive
            await yieldNow();
        }
        if (run === currentRun) {
            renderWorker.postMessage({'type': 'runEnd', id});
        }
    };

    self.onmessage = (event) => {
        if (event.data.type === 'models') {
            slowdown = event.data.slowdown ?? 1;
            receiveModels(event.data);
        } else if (event.data.type === 'units') {
            runUnits(event.data).catch((error) => {
                self.postMessage({'type': 'error', 'id': event.data.id, 'message': `${error.message} (${error.stack})`});
            });
        } else if (event.data.type === 'prepare') {
            // Load the voice's model ahead of playback
            loadModel().catch((error) => {
                self.postMessage({'type': 'error', 'id': null, 'message': `${error.message} (${error.stack})`});
            });
        } else if (event.data.type === 'cancel') {
            currentRun++;
        }
    };
}
