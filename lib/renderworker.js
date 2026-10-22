// The render worker - the synthesis worker's (worker.js) second stage: it renders each unit's frames (PicoVox's
// source-filter synthesizer - picovox/lib/synthesis.js createSentenceRenderer) as the synthesis worker's voice network
// makes them, so the network and the renderer run at once on two cores (on an iPhone without a JIT, a sentence
// synthesizes about twice as fast). It's started by the synthesis worker, which relays its messages to the engine.
//
// Messages in (from the synthesis worker, in order):
// - {'type': 'begin', 'id', 'unit', 'eq', 'seed', 'pause', 'rate'} - a unit's start (its pause, then its frames)
// - {'type': 'frames', 'id', 'unit', 'frames' (Float64Array, the chunk's rows end to end), 'count'} - a chunk of frames
// - {'type': 'end', 'id', 'unit'} - the unit's last frames are in; posts its last blocks and {'type': 'unitDone'}
// - {'type': 'runEnd', 'id'} - posts {'type': 'runDone', 'id'} (after the run's units' blocks)
// Messages out: {'type': 'unitBlock', 'id', 'unit', 'samples', 'sampleRate'} (each block as it's final), {'type':
// 'unitDone', 'id', 'unit', 'renderMs'}, {'type': 'runDone', 'id'}, and {'type': 'error', 'message'}.

import {createSentenceRenderer, defaultSampleRate} from '../picovox/lib/synthesis.js';


let renderer = null;
let renderMs = 0;
self.onmessage = ({data}) => {
    try {
        const start = performance.now();
        if (data.type === 'begin') {
            renderMs = 0;
            renderer = createSentenceRenderer({
                'onBlock': (samples) => {
                    self.postMessage({'type': 'unitBlock', 'id': data.id, 'unit': data.unit, samples, 'sampleRate': defaultSampleRate},
                        [samples.buffer]);
                },
                'eq': data.eq, 'rate': data.rate, 'seed': data.seed, 'pause': data.pause
            });
        } else if (data.type === 'frames') {
            // (an empty chunk is skipped - the renderer would take an empty array as one frame)
            if (data.count > 0) {
                const width = data.frames.length / data.count;
                const frames = [];
                for (let index = 0; index < data.count; index++) {
                    frames.push(data.frames.subarray(index * width, (index + 1) * width));
                }
                renderer.push(frames);
            }
        } else if (data.type === 'end') {
            renderer.end();
            renderer = null;
            renderMs += performance.now() - start;
            self.postMessage({'type': 'unitDone', 'id': data.id, 'unit': data.unit, 'renderMs': Math.round(renderMs)});
            return;
        } else if (data.type === 'runEnd') {
            self.postMessage({'type': 'runDone', 'id': data.id});
            return;
        }
        renderMs += performance.now() - start;
    } catch (error) {
        self.postMessage({'type': 'error', 'message': `${error.message} (${error.stack})`});
    }
};
