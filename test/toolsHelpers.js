// The catalog tools' test helpers (test/testTools*.js) - a temporary cache directory, a fake Ollama decision model (in
// process and as a server for the command lines), a fake site and clock for the catalog builder, and running a tool's
// command line. Importing this module sets PICOSHELF_CACHE (tools/decide.js reads it at import), so a test imports it
// first, then the tools (with await import).

import {after, mock} from 'node:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {strict as assert} from 'node:assert';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import process from 'node:process';
import {tmpdir} from 'node:os';


// The repository's root
export const root = fileURLToPath(new URL('..', import.meta.url));


// The tests' temporary directory and the tools' cache directory in it - with Ollama's default address
export const tempDir = mkdtempSync(join(tmpdir(), 'picoshelf-tools-'));
export const cacheDir = join(tempDir, 'cache');
process.env.PICOSHELF_CACHE = cacheDir;
delete process.env.OLLAMA_HOST;
after(() => {
    rmSync(tempDir, {'recursive': true, 'force': true});
});


// Empty the cache directory
export function resetCache() {
    rmSync(cacheDir, {'recursive': true, 'force': true});
    mkdirSync(cacheDir, {'recursive': true});
}


// Write a cache file
export function writeCache(name, text) {
    mkdirSync(join(cacheDir, name, '..'), {'recursive': true});
    writeFileSync(join(cacheDir, name), text);
}


// A JSON response
export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {status, 'headers': {'Content-Type': 'application/json'}});
}


// A fake Ollama - a function of a request's path and body to its response. Model "missing" isn't pulled, and model
// "chat" isn't a decision model. given(name, body) is a question's given probabilities, its first option the choice
// (the question's other options share what's left) - else the question's first option is the choice, at 0.6.
export function fakeOllama(given = () => undefined) {
    return (path, body) => {
        if (path === '/api/show') {
            if (body.model === 'missing') {
                return jsonResponse({'error': `model '${body.model}' not found`}, 404);
            }
            return jsonResponse({'capabilities': body.model === 'chat' ? ['completion'] : ['completion', 'decision']});
        }
        const answers = {};
        for (const [name, question] of Object.entries(body.questions)) {
            const keys = Object.keys(question.criteria);
            const probabilities = given(name, body) ?? {[keys[0]]: 0.6};
            const givenTotal = Object.values(probabilities).reduce((total, probability) => total + probability, 0);
            const rest = (1 - givenTotal) / keys.filter((key) => !(key in probabilities)).length;
            answers[name] = {
                'choice': Object.keys(probabilities)[0],
                'probabilities': Object.fromEntries(keys.map((key) => [key, probabilities[key] ?? rest]))
            };
        }
        return jsonResponse({answers});
    };
}


// Run a test function with a fake Ollama fetch - respond(path, body) is the response (fakeOllama's) - returns the fetch
// calls, [url, body] (each a JSON POST)
export async function withOllama(respond, fn) {
    const fetchMock = mock.method(
        globalThis, 'fetch', (url, options) => Promise.resolve().then(() => respond(new URL(url).pathname, JSON.parse(options.body)))
    );
    try {
        await fn();
    } finally {
        fetchMock.mock.restore();
    }
    return fetchMock.mock.calls.map(({'arguments': [url, options]}) => {
        assert.equal(options.method, 'POST');
        assert.deepEqual(options.headers, {'Content-Type': 'application/json'});
        return [url, JSON.parse(options.body)];
    });
}


// Start a fake Ollama server, for the command lines' child processes - respond as withOllama's - {host, requests
// ([method, path, body]), close}
export async function ollamaServer(respond) {
    const requests = [];
    const server = createServer((request, response) => {
        let text = '';
        request.on('data', (chunk) => {
            text += chunk;
        });
        request.on('end', async () => {
            const body = JSON.parse(text);
            requests.push([request.method, request.url, body]);
            const reply = respond(request.url, body);
            response.writeHead(reply.status, {'Content-Type': 'application/json'});
            response.end(await reply.text());
        });
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        'host': `127.0.0.1:${server.address().port}`,
        requests,
        'close': () => new Promise((resolve) => {
            server.close(resolve);
        })
    };
}


// Run a tool's command line (tools/<name>.js) with more environment variables - {code, stdout, stderr}
export function runTool(name, args, env = {}) {
    return new Promise((resolve) => {
        const script = join(root, 'tools', `${name}.js`);
        execFile(process.execPath, [script, ...args], {'env': {...process.env, ...env}}, (error, stdout, stderr) => {
            resolve({'code': error?.code ?? 0, stdout, stderr});
        });
    });
}


// The fake clock - it moves only forward, so the catalog builder's per-host throttle times stay in order across tests
let clock = Date.now();


// Run a test function with a fake site, a fake clock that a fake sleep advances, and the catalog builder's output
// captured - site is a function of a request's URL and options to its response, or an object of those functions by URL
// (other URLs 404). Returns the fetch calls ([url, options]), the sleeps (milliseconds), and the output lines. The clock
// starts an hour past the last test's, on a second, so no host's throttle carries over.
export async function withSite(site, fn) {
    const {services} = await import('../tools/catalog.js');
    const siteFetch = typeof site === 'function' ? site
        : (url, options) => (url in site ? site[url](options) : new Response('Not Found', {'status': 404}));
    clock = Math.ceil(clock / 1000) * 1000 + 3600000;
    const fetchMock = mock.method(globalThis, 'fetch', (url, options) => Promise.resolve().then(() => siteFetch(url, options)));
    const nowMock = mock.method(Date, 'now', () => clock);
    const sleepMock = mock.method(services, 'sleep', (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
    });
    const output = [];
    const writeMock = mock.method(services, 'write', (text) => {
        output.push(text.replace(/^\[\d+:\d\d\] /, '').replace(/\n$/, ''));
    });
    try {
        await fn();
    } finally {
        fetchMock.mock.restore();
        nowMock.mock.restore();
        sleepMock.mock.restore();
        writeMock.mock.restore();
    }
    return {
        'calls': fetchMock.mock.calls.map((call) => call.arguments),
        'sleeps': sleepMock.mock.calls.map((call) => call.arguments[0]),
        output
    };
}
