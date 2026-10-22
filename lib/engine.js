// The audiobook playback engine - the timeline is the book's text: it is split into units (PicoVox's sentences, long ones
// at semicolons and colons, and paragraphs at blank lines - picovox/lib/sentences.js), which a Web Worker synthesizes on
// demand a few minutes ahead of the position. Playback schedules each unit's streamed blocks with Web Audio, and only the
// audio near the position is kept, so a whole book costs no more than a chapter.

import {autoStyles, paragraphBeats} from 'picovox/lib/style.js';
import {speechText, splitSentences} from 'picovox/lib/sentences.js';
import {encodeWav} from 'picovox/lib/wav.js';


// Timing (s) - the playback lead, and how far ahead to schedule blocks
const leadSeconds = 0.06;
const scheduleAheadSeconds = 6;
// A streaming unit starts when what's synthesized covers playing it through at the measured synthesis speed, with this
// margin (s); a late block delays the rest of its unit (a stall) - audio is never dropped
const playThroughMarginSeconds = 0.5;
const stallLeadSeconds = 0.03;


// The synthesis window - synthesize at most this many units (and characters) ahead of the position, and keep this many
// units of audio behind it
const windowUnits = 40;
const windowChars = 2500;
const keepBehindUnits = 8;


// The initial speaking rate estimate (characters per second at rate 1), refined by measurement
const defaultCharsPerSecond = 14;


// Is this an iPhone or iPad (including iPadOS, which reports itself as a Mac with a touch screen)?
function isAppleMobile() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}


// Import the generated model modules (picovox/lib/models/) once for every worker - each worker's own import would
// download them again - as the workers' models message. A failed import (a dropped request, say) is tried once more.
function importModels(voiceModelUrl = 'picovox/lib/models/voiceModel.js', retry = true) {
    return Promise.all([import('picovox/lib/models/g2pModel.js'), import(voiceModelUrl)]).then(([g2p, voice]) => ({
        'type': 'models',
        'g2pModel': g2p.g2pModel,
        'voiceModel': {'manifest': voice.manifest, 'encoding': voice.encoding, 'weights': voice.weights}
    }), (error) => {
        if (retry) {
            return importModels(voiceModelUrl, false);
        }
        throw error;
    });
}


// A unit's cached audio, empty - its blocks, their length (s), whether it's complete, the run that owns it (the first to
// start it - its audio is that run's), and when that run started it
function emptyCell() {
    return {'blocks': [], 'length': 0, 'done': false, 'run': null, 'startedAt': null};
}


// The engine - load a book, then play, pause, skip, and seek. onChange(state) is called when the state changes (playing,
// paused, buffering, ended, or a new unit), and the caller may poll state() for the position.
export class Engine {
    constructor({onChange = () => {
        // No listener
    }, slowdown = 1, voiceModelUrl = undefined} = {}) {
        this.onChange = onChange;
        this.slowdown = slowdown;
        this.audioContext = null;
        this.output = null;
        this.mediaElement = null;
        // The synthesis workers - [{worker, ready, starts}] - several on multi-core devices, each speaking different
        // upcoming units (each with its own render worker - worker.js)
        this.workers = [];
        this.workerReady = false;
        // The error that stops playback (a message for the listener), if any
        this.error = null;
        // The startup timeline - [{ms (since the last play), event}] - for diagnosing slow starts (the app shows it with
        // ?timing)
        this.timeline = [];
        this.playStart = performance.now();
        this.awaitingFirstBlock = false;
        this.awaitingFirstSchedule = false;
        this.nextRunId = 1;
        this.session = null;
        this.playing = false;
        this.unit = 0;
        this.time = 0;
        this.chain = [];
        this.sources = new Set();
        this.ended = false;
        this.lastUnit = -1;
        this.lastMaintenance = 0;
        this.lastClockMark = 0;
        this.measuredChars = 0;
        this.measuredSeconds = 0;
        this.synthesizedSeconds = 0;
        this.synthesisSeconds = 0;
        // (each a pipeline of two workers - the voice network and its render worker, at once; one on iPhones and iPads,
        // which run two at nearly twice one's speed - without a JIT, about 2.7 times real time - and more compete)
        this.models = importModels(voiceModelUrl);
        const poolSize = isAppleMobile() ? 1 : Math.max(1, Math.min(3, Math.floor(((navigator.hardwareConcurrency || 2) - 1) / 2)));
        for (let slot = 0; slot < poolSize; slot++) {
            this.startWorker(slot);
        }
        setInterval(() => this.tick(), 100);
    }

    // Start a synthesis worker in a slot - one that fails before it's ready (a dropped module request, say) gets one fresh
    // start
    startWorker(slot) {
        const starts = (this.workers[slot]?.starts ?? 0) + 1;
        const worker = new Worker(new URL('worker.js', import.meta.url), {'type': 'module'});
        this.workers[slot] = {worker, 'ready': false, starts};
        worker.onmessage = (event) => this.onWorkerMessage(event.data, slot);
        this.models.then((message) => {
            worker.postMessage({...message, 'slowdown': this.slowdown});
        }, (error) => {
            this.mark(`model import error: ${error.message}`);
            this.error = `The speech synthesizer failed to load its models: ${error.message}`;
            this.notify();
        });
        worker.onerror = (event) => {
            event.preventDefault();
            this.mark(`worker ${slot} error: ${event.message || '(no message)'} ${event.filename || ''}:${event.lineno || ''}`);
            this.workerFailed(slot, `The speech synthesizer failed to start: ${event.message || 'serve the app over HTTP'}`);
        };
    }

    // A worker failed - restart it once if it failed before it was ready, else report the error. A restarted worker's runs
    // are forgotten (their units are dealt again) - it hadn't started a unit (it wasn't ready), so the cached audio is the
    // other workers'.
    workerFailed(slot, message) {
        const {ready, starts, worker} = this.workers[slot];
        if (!ready && starts < 2) {
            worker.terminate();
            this.startWorker(slot);
            if (this.session !== null) {
                this.session.runs = [];
                this.workers[slot].worker.postMessage({'type': 'prepare'});
            }
            return;
        }
        this.error = message;
        this.notify();
    }

    // Post a message to every worker
    postAll(message) {
        for (const {worker} of this.workers) {
            worker.postMessage(message);
        }
    }

    // Load a book's text, paused at a character offset (snapped to its sentence) - with the voice, rate, and expressive
    // dialogue (the quotations styled)
    load(text, {voice = 'neural-male', rate = 1, expressive = false} = {}, startChar = 0) {
        this.stop();
        this.cancelRun();
        this.ended = false;
        // The speaking rate is measured afresh for each book, voice, and rate
        this.measuredChars = 0;
        this.measuredSeconds = 0;
        const units = splitSentences(text);
        this.session = {
            text, units, voice, rate, expressive, 'styles': expressive ? autoStyles(units) : null,
            'beats': expressive ? paragraphBeats(units) : null,
            // The workers' current runs, not yet done - [{id, order (its units)}] - and the session's first run id (an
            // earlier run's messages are another session's)
            'runs': [], 'firstRunId': this.nextRunId,
            'cache': units.map(emptyCell)
        };
        this.unit = units.length === 0 ? 0 : this.unitAtChar(startChar);
        this.time = 0;
        // Have the worker load the voice and synthesize the first sentences now, so the first play starts at once
        this.postAll({'type': 'prepare'});
        if (units.length !== 0) {
            this.ensureSynthesis(this.unit);
        }
        this.notify();
    }

    // Unload the book - playback and synthesis stopped, nothing loaded
    unload() {
        this.stop();
        this.cancelRun();
        this.releaseMedia();
        this.ended = false;
        this.session = null;
        this.notify();
    }

    // Change the voice, rate, or expressive dialogue - continuing from the current sentence
    setVoice({voice, rate, expressive = false}) {
        const {session} = this;
        if (session === null || (voice === session.voice && rate === session.rate && expressive === session.expressive)) {
            return;
        }
        const wasPlaying = this.playing;
        const {unit} = this.position();
        this.load(this.session.text, {voice, rate, expressive}, this.session.units[unit].start);
        if (wasPlaying) {
            this.play();
        }
    }

    // Note a startup event on the timeline
    mark(event) {
        this.timeline.push({'ms': Math.round(performance.now() - this.playStart), event});
        if (this.timeline.length > 300) {
            this.timeline.shift();
        }
    }

    // Play from the position (from the start at the end) - call from a user gesture (it unlocks audio)
    play() {
        if (this.session === null || this.session.units.length === 0) {
            return;
        }
        // Playing already (the lock screen's play, the browser having paused the media element) - from the position
        this.stop();
        this.playStart = performance.now();
        this.mark('--- play (times from here) ---');
        const cell = this.session.cache[this.unit];
        const worker = this.workerReady ? 'ready' : 'starting';
        this.mark(`play (unit ${this.unit}: ${cell.blocks.length} blocks ready${cell.done ? ', complete' : ''}; worker ${worker})`);
        this.awaitingFirstBlock = cell.blocks.length === 0;
        this.awaitingFirstSchedule = true;
        this.ensureAudio();
        if (this.ended) {
            this.ended = false;
            this.unit = 0;
            this.time = 0;
        }
        this.startPlayback(this.unit, this.time);
    }

    // Pause, keeping the position
    pause() {
        if (this.playing) {
            this.stop();
            this.releaseMedia();
            this.notify();
        }
    }

    // Stop playing (if playing), keeping the position
    stop() {
        if (this.playing) {
            ({'unit': this.unit, 'time': this.time} = this.position());
            this.playing = false;
        }
        this.stopSources();
    }

    // Pause the media element and suspend the audio - the lock screen shows the book paused (on iOS, its play button
    // reflects the media element), and a paused book uses no audio power
    releaseMedia() {
        if (this.mediaElement === null) {
            return;
        }
        this.mediaElement.pause();
        this.audioContext.suspend();
    }

    // Toggle play and pause
    toggle() {
        if (this.playing) {
            this.pause();
        } else {
            this.play();
        }
    }

    // Skip to the next sentence, or back - to this sentence's start if more than two seconds into it, else to the
    // previous sentence's
    skipSentence(direction) {
        if (this.session === null || this.session.units.length === 0) {
            return;
        }
        const current = this.position();
        const unit = direction > 0 ? current.unit + 1 : (current.time > 2 ? current.unit : current.unit - 1);
        if (unit >= this.session.units.length) {
            this.finish();
            return;
        }
        this.ended = false;
        this.moveTo(Math.max(0, unit));
    }

    // Seek to a character offset's sentence
    seekChar(char) {
        if (this.session !== null && this.session.units.length !== 0) {
            this.ended = false;
            this.moveTo(this.unitAtChar(char));
        }
    }

    // The state - {status ('loading', 'paused', 'buffering', 'playing', 'ended'), char (the position, interpolated
    // through its sentence), sentenceChar (its sentence's start), percent, sentence (its text), remainingSeconds}
    state() {
        if (this.session === null || this.session.units.length === 0) {
            return {
                'status': this.workerReady ? 'paused' : 'loading', 'char': 0, 'sentenceChar': 0, 'percent': 0, 'sentence': '',
                'remainingSeconds': 0
            };
        }
        const current = this.position();
        const char = this.positionChar(current);
        let status = 'paused';
        if (this.ended) {
            status = 'ended';
        } else if (this.playing) {
            const now = this.audioContext.currentTime;
            const started = this.chain.some((entry) => entry.startTime !== null && entry.startTime <= now);
            status = started ? 'playing' : 'buffering';
        } else if (!this.workerReady) {
            status = 'loading';
        }
        return {
            status, char, 'sentenceChar': this.session.units[current.unit].start, 'percent': 100 * char / this.textLength(),
            'sentence': this.session.units[current.unit].text,
            'remainingSeconds': (this.textLength() - char) / this.charsPerSecond()
        };
    }

    // The speaking rate (characters per second) - measured from synthesized units, at the session's rate
    charsPerSecond() {
        // The measurement is blended with the default, weighted as a minute of audio, so the estimate settles smoothly
        const rate = this.session === null ? 1 : this.session.rate;
        const priorSeconds = 60;
        return (this.measuredChars + defaultCharsPerSecond * rate * priorSeconds) / (this.measuredSeconds + priorSeconds);
    }

    // Notify the caller of a state change
    notify() {
        this.onChange(this.state());
    }

    // Create the audio context and output (on a user gesture). A silent looping media element keeps the page's audio
    // session in playback mode (on iOS, Web Audio alone follows the ringer switch) and enables the lock-screen controls.
    ensureAudio() {
        // A broken output is rebuilt - iOS can close or interrupt the audio context, or end the media element (or the
        // stream it plays), during a long pause
        if (this.audioContext !== null) {
            const track = this.mediaElement.srcObject?.getAudioTracks()[0];
            const {state} = this.audioContext;
            if (state === 'closed' || state === 'interrupted' || this.mediaElement.ended || track?.readyState === 'ended') {
                this.mark(`audio rebuilt (audio ${state}${this.mediaElement.ended ? ', media ended' : ''}` +
                    `${track?.readyState === 'ended' ? ', stream ended' : ''})`);
                // (playing stops at the position - its sources and clock are the old audio context's)
                this.stop();
                this.audioContext.onstatechange = null;
                this.audioContext.close().catch(() => null);
                this.mediaElement.pause();
                this.mediaElement = null;
                this.audioContext = null;
            }
        }
        if (this.audioContext === null) {
            if (navigator.audioSession) {
                navigator.audioSession.type = 'playback';
            }
            this.audioContext = new AudioContext({'latencyHint': 'playback'});
            // iOS interrupts Web Audio (say, when the media element takes the audio session) - resume it while playing
            this.audioContext.onstatechange = () => {
                this.mark(`audio ${this.audioContext.state}`);
                if (this.playing && this.audioContext.state !== 'running' && this.audioContext.state !== 'closed') {
                    this.audioContext.resume();
                }
            };
            this.mark(`audio created (${this.audioContext.sampleRate} Hz, ${this.audioContext.state})`);
            this.output = this.audioContext.createGain();
            this.mediaElement = document.createElement('audio');
            this.mediaElement.setAttribute('playsinline', '');
            if (isAppleMobile()) {
                // iOS mutes a separate Web Audio output while a media element holds the audio session - so the speech
                // plays through the media element itself (one output, treated as media playback)
                const stream = this.audioContext.createMediaStreamDestination();
                this.output.connect(stream);
                this.mediaElement.srcObject = stream.stream;
                this.mark('audio routed through the media element');
            } else {
                // Elsewhere, Web Audio plays directly, and a silent looping media element keeps playback alive (lock
                // screen, background)
                this.output.connect(this.audioContext.destination);
                this.mediaElement.loop = true;
                this.mediaElement.src = URL.createObjectURL(new Blob([encodeWav(new Float32Array(8000), 8000)], {'type': 'audio/wav'}));
            }
        }
        this.audioContext.resume().then(() => {
            const {baseLatency = 0, outputLatency = 0} = this.audioContext;
            this.mark(`audio resumed (base latency ${Math.round(1000 * baseLatency)} ms, output ${Math.round(1000 * outputLatency)} ms)`);
        });
        this.mediaElement.play().then(() => this.mark('media element playing')).catch(() => {
            // Autoplay restrictions - Web Audio still plays after the gesture
            this.mark('media element refused');
        });
    }

    // Handle a worker message - the worker's readiness, and unit audio (the first run to reach a unit owns it)
    onWorkerMessage(message, slot = 0) {
        if (message.type === 'trace') {
            this.mark(`worker ${slot}: ${message.event} (+${message.ms} ms)`);
            return;
        }
        if (message.type === 'ready') {
            this.mark(`worker ${slot} ready`);
            this.workers[slot].ready = true;
            this.workerReady = true;
            this.notify();
            return;
        }
        if (message.type === 'error') {
            this.mark(`worker ${slot} error message: ${message.message}`);
            // A worker that couldn't load its models gets one fresh start, as a worker that failed to load
            this.workerFailed(slot, message.message);
            return;
        }
        const {session} = this;
        if (session === null || message.id < session.firstRunId) {
            return;
        }
        if (message.type === 'runDone') {
            session.runs = session.runs.filter((run) => run.id !== message.id);
            return;
        }
        // The first run to start a unit owns it - other runs' audio of it (and a run's audio of a unit since evicted)
        // is ignored
        const cell = session.cache[message.unit];
        if (message.type === 'unitStart') {
            if (cell.run === null) {
                cell.run = message.id;
                cell.startedAt = performance.now();
            }
            return;
        }
        if (cell.done || cell.run !== message.id) {
            return;
        }
        if (message.type === 'unitBlock') {
            // Blocks keep their samples - audio buffers are made when they're scheduled (the audio context may not
            // exist yet, before the first play)
            if (this.awaitingFirstBlock && this.playing && message.unit === this.chain[0]?.unit) {
                this.awaitingFirstBlock = false;
                this.mark('first audio block from the worker');
            }
            const duration = message.samples.length / message.sampleRate;
            cell.blocks.push({'samples': message.samples, 'sampleRate': message.sampleRate, 'start': cell.length, duration});
            cell.length += duration;
        } else if (message.type === 'unitDone') {
            cell.done = true;
            this.measuredChars += session.units[message.unit].text.length;
            this.measuredSeconds += cell.length;
            this.synthesizedSeconds += cell.length;
            this.synthesisSeconds += (performance.now() - cell.startedAt) / 1000;
        }
        this.pump();
    }

    // Unit queries - is a unit complete, and its length (s)
    unitComplete(unit) {
        return this.session.cache[unit].done;
    }

    unitLength(unit) {
        return this.session.cache[unit].length;
    }

    // Can a unit start playing (from a time) - complete, or with enough synthesized to play through without stalling at
    // the synthesis speed: of a unit of length L, synthesized at s seconds of audio per second, the first L (1 - s)
    unitCanStart(unit, from = 0) {
        const cell = this.session.cache[unit];
        if (cell.done) {
            return true;
        }
        if (cell.blocks.length === 0) {
            return false;
        }
        const speed = this.synthesisSpeed(cell);
        if (speed >= 1) {
            return true;
        }
        const length = Math.max(cell.length, this.session.units[unit].text.length / this.charsPerSecond());
        return cell.length - from >= (length - from) * (1 - speed) + playThroughMarginSeconds;
    }

    // The synthesis speed (seconds of audio per second) - a started unit's own so far (after half a second), else the
    // measured speed of the completed units, else 0 (unknown - wait for the unit, or a measurement)
    synthesisSpeed(cell) {
        const elapsed = (performance.now() - cell.startedAt) / 1000;
        if (elapsed >= 0.5) {
            return cell.length / elapsed;
        }
        return this.synthesisSeconds > 0 ? this.synthesizedSeconds / this.synthesisSeconds : 0;
    }

    // The text's length for positions (to the end of its last unit)
    textLength() {
        return this.session.units[this.session.units.length - 1].end;
    }

    // The unit at a character offset - the first unit ending after it (a binary search)
    unitAtChar(char) {
        const {units} = this.session;
        let low = 0;
        let high = units.length - 1;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (units[middle].end > char) {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
        return low;
    }

    // The position - {unit, time}
    position() {
        if (!this.playing) {
            return {'unit': this.unit, 'time': this.time};
        }
        const now = this.audioContext.currentTime;
        for (let ix = this.chain.length - 1; ix >= 0; ix--) {
            const entry = this.chain[ix];
            if (entry.startTime !== null && entry.startTime <= now) {
                let time = now - entry.startTime;
                if (ix === 0) {
                    time = Math.max(time, entry.from);
                }
                if (this.unitComplete(entry.unit)) {
                    time = Math.min(time, this.unitLength(entry.unit));
                }
                return {'unit': entry.unit, time};
            }
        }
        return {'unit': this.chain[0].unit, 'time': this.chain[0].from};
    }

    // A position's character offset - interpolated through its unit by time
    positionChar({unit, time}) {
        const target = this.session.units[unit];
        const complete = this.unitComplete(unit);
        const length = complete ? this.unitLength(unit) : Math.max(0.001, target.text.length / this.charsPerSecond());
        const fraction = Math.max(0, Math.min(complete ? 1 : 0.95, time / length));
        return target.start + fraction * (target.end - target.start);
    }

    // Make sure the units in the window from a unit on are being synthesized - keeping the current run if it reaches the
    // first missing unit next
    ensureSynthesis(from) {
        const {session} = this;
        const remaining = [];
        const charLimit = session.units[from].start + windowChars;
        for (let unit = from; unit < session.units.length && unit < from + windowUnits; unit++) {
            if (unit > from + 1 && session.units[unit].start > charLimit) {
                break;
            }
            if (!this.unitComplete(unit)) {
                remaining.push(unit);
            }
        }
        if (remaining.length === 0) {
            return;
        }
        // Every remaining unit already in a run, or started by a worker - nothing to do
        const assigned = new Set(session.runs.flatMap((run) => run.order));
        for (const unit of remaining) {
            if (session.cache[unit].run !== null) {
                assigned.add(unit);
            }
        }
        if (remaining.every((unit) => assigned.has(unit))) {
            return;
        }

        // Deal the remaining units to the workers in turn - each worker's new run supersedes its old one, and a unit a
        // worker has already started stays with it (a worker finishes its current unit before taking a new run)
        session.runs = [];
        const unstarted = remaining.filter((unit) => session.cache[unit].run === null);
        this.mark(`synthesis from unit ${from}: units ${unstarted[0]}-${unstarted[unstarted.length - 1]} dealt`);
        this.workers.forEach(({worker}, slot) => {
            const order = unstarted.filter((unit, index) => index % this.workers.length === slot);
            if (order.length !== 0) {
                const id = this.nextRunId++;
                session.runs.push({id, order});
                worker.postMessage({
                    'type': 'units', id, 'voice': session.voice, 'rate': session.rate,
                    'units': order.map((unit) => {
                        const {index, text, paragraphStart} = session.units[unit];
                        const spans = session.styles?.spans(index)?.map((span) => ({'text': speechText(span.text), 'style': span.style}));
                        const beat = session.beats?.[index] ?? null;
                        return {index, 'text': speechText(text), paragraphStart, 'spans': spans ?? null, beat};
                    })
                });
            }
        });
    }

    // Cancel the workers' unit runs
    cancelRun() {
        this.postAll({'type': 'cancel'});
        if (this.session !== null) {
            this.session.runs = [];
        }
    }

    // Drop the cached audio of units outside the window around a unit (and not playing)
    evictCache(center) {
        const {session} = this;
        const playing = new Set(this.playing ? this.chain.map((entry) => entry.unit) : []);
        const charLimit = session.units[center].start + windowChars;
        for (let unit = 0; unit < session.cache.length; unit++) {
            if (session.cache[unit].run === null) {
                continue;
            }
            const inWindow = unit >= center - keepBehindUnits && unit < center + windowUnits &&
                (unit <= center + 1 || session.units[unit].start <= charLimit);
            if (!inWindow && !playing.has(unit)) {
                session.cache[unit] = emptyCell();
            }
        }
    }

    // Schedule a block of a chain entry's unit - skipping what has already passed
    scheduleBlock(entry, block) {
        let when = entry.startTime + block.start;
        let offset = 0;
        const earliest = this.audioContext.currentTime + 0.005;
        if (when + block.duration <= earliest) {
            return;
        }
        if (when < earliest) {
            offset = earliest - when;
            when = earliest;
        }
        const buffer = this.audioContext.createBuffer(1, block.samples.length, block.sampleRate);
        buffer.copyToChannel(block.samples, 0);
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.output);
        source.start(when, offset);
        if (this.awaitingFirstSchedule) {
            this.awaitingFirstSchedule = false;
            const ahead = Math.round(1000 * (when - this.audioContext.currentTime));
            const clock = this.audioContext.currentTime.toFixed(2);
            this.mark(`first block scheduled (${ahead} ms ahead; audio ${this.audioContext.state}, clock ${clock} s)`);
        }
        source.onended = () => this.sources.delete(source);
        this.sources.add(source);
    }

    // Stop the scheduled sources
    stopSources() {
        for (const source of this.sources) {
            source.onended = null;
            source.stop();
        }
        this.sources.clear();
    }

    // Play from a position
    startPlayback(unit, time) {
        this.stopSources();
        this.playing = true;
        this.chain = [{unit, 'from': time, 'startTime': null, 'cursor': 0}];
        this.ensureSynthesis(unit);
        this.pump();
        this.notify();
    }

    // Move to a unit's start - playing from there if playing, else preparing its audio
    moveTo(unit) {
        if (this.playing) {
            this.startPlayback(unit, 0);
        } else {
            this.unit = unit;
            this.time = 0;
            this.ensureSynthesis(unit);
            this.notify();
        }
    }

    // Stop at the end of the book
    finish() {
        this.stop();
        this.ended = true;
        this.unit = this.session.units.length - 1;
        this.time = this.unitComplete(this.unit) ? this.unitLength(this.unit) : 0;
        this.releaseMedia();
        this.notify();
    }

    // Advance playback - start chain units when they can start, schedule their blocks ahead, extend the chain with the
    // next unit, and finish at the end of the book
    pump() {
        if (!this.playing) {
            return;
        }
        const now = this.audioContext.currentTime;
        for (let ix = 0; ix < this.chain.length; ix++) {
            const entry = this.chain[ix];
            if (entry.startTime === null) {
                const previous = this.chain[ix - 1];
                if (ix === 0 && this.unitCanStart(entry.unit, entry.from)) {
                    entry.startTime = now + leadSeconds - entry.from;
                } else if (ix !== 0 && previous.startTime !== null && this.unitComplete(previous.unit) && this.unitCanStart(entry.unit)) {
                    entry.startTime = Math.max(previous.startTime + this.unitLength(previous.unit), now + 0.03);
                } else {
                    break;
                }
            }
            const cell = this.session.cache[entry.unit];
            const horizon = now + scheduleAheadSeconds;
            while (entry.cursor < cell.blocks.length && entry.startTime + cell.blocks[entry.cursor].start < horizon) {
                // A block that arrived too late to play on time delays the rest of its unit (a stall) - a block before
                // a seek's start is skipped
                const block = cell.blocks[entry.cursor];
                const late = now + stallLeadSeconds - (entry.startTime + block.start);
                if (late > 0 && block.start >= entry.from) {
                    entry.startTime += late;
                    this.mark(`unit ${entry.unit} stalled ${Math.round(1000 * late)} ms (block ${entry.cursor})`);
                }
                this.scheduleBlock(entry, block);
                entry.cursor++;
            }
            if (ix === this.chain.length - 1 && this.unitComplete(entry.unit) && entry.unit + 1 < this.session.units.length) {
                this.chain.push({'unit': entry.unit + 1, 'from': 0, 'startTime': null, 'cursor': 0});
            }
        }

        // Drop finished units from the front of the chain
        while (this.chain.length > 1 && this.chain[1].startTime !== null && this.chain[1].startTime < now - 1) {
            this.chain.shift();
        }

        // The end of the book
        const last = this.chain[this.chain.length - 1];
        if (last.unit === this.session.units.length - 1 && last.startTime !== null && this.unitComplete(last.unit) &&
            now >= last.startTime + this.unitLength(last.unit) + 0.05) {
            this.finish();
        }
    }

    // The clock - advance playback, keep synthesis and the cache around the position, and report unit changes
    tick() {
        if (this.session === null || this.session.units.length === 0) {
            return;
        }
        this.pump();
        if (this.playing && performance.now() - this.lastClockMark > 2000) {
            this.lastClockMark = performance.now();
            const clock = this.audioContext.currentTime.toFixed(2);
            this.mark(`clock ${clock} s, audio ${this.audioContext.state}, ${this.sources.size} sources`);
        }
        const {unit} = this.position();
        if (this.playing) {
            this.ensureSynthesis(unit);
        }
        const now = performance.now();
        if (now - this.lastMaintenance > 2000) {
            this.lastMaintenance = now;
            this.evictCache(unit);
        }
        if (unit !== this.lastUnit) {
            this.lastUnit = unit;
            this.notify();
        }
    }
}
