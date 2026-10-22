// Decisions about the catalog's books by a local Ollama decision model - typed questions about a book's catalog entry
// (its title, author, subjects, and description), each answered with its options' probabilities in one forward pass
// (Ollama's /v1/systemone endpoint - called directly, as ollama-chat calls Ollama's API). The narrator casts
// (tools/voicecast.js) and the genres (tools/genres.js) are decisions. OLLAMA_HOST sets Ollama's address.
//
// A decision takes about 0.7 s on an M3 Max, the GPU's whole - decisions at once, from one Ollama server or several, are
// no faster - so they are cached by model, questions, and the book's details, and a rebuild decides only new or changed
// books.

import {dirname, join} from 'node:path';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import process from 'node:process';


export const root = fileURLToPath(new URL('..', import.meta.url));

// The catalog builder's cache directory - the pages and the decisions (PICOSHELF_CACHE sets another - the tests')
export const cacheDir = process.env.PICOSHELF_CACHE ?? join(root, 'cache', 'catalog');

// The default decision model
export const decisionModel = 'kev:9b-nvfp4';


// An Ollama API URL (OLLAMA_HOST, as Ollama's tools)
function ollamaURL(path) {
    const host = process.env.OLLAMA_HOST ?? '127.0.0.1:11434';
    return `${host.includes('://') ? host : `http://${host}`}${path}`;
}


// POST a request to an Ollama API - its JSON response, or an error with Ollama's message
async function ollamaPost(path, body) {
    const response = await fetch(ollamaURL(path), {
        'method': 'POST', 'headers': {'Content-Type': 'application/json'}, 'body': JSON.stringify(body)
    });
    const text = await response.text();
    let result = null;
    try {
        result = JSON.parse(text);
    } catch {
        // Not JSON - the error below
    }
    if (!response.ok || result === null || 'error' in result) {
        throw new Error(`Ollama ${path} (${response.status}): ${result?.error ?? text.slice(0, 200)}`);
    }
    return result;
}


// Check that the model is local and is a decision model
export async function checkModel(model) {
    let show;
    try {
        show = await ollamaPost('/api/show', {model});
    } catch (error) {
        throw new Error(`Unknown model "${model}" - ollama pull ${model} (${error.message})`, {'cause': error});
    }
    if (!(show.capabilities ?? []).includes('decision')) {
        throw new Error(`"${model}" isn't a decision model`);
    }
}


// A book's state for the decision model - its catalog details
export function bookState(book) {
    return {
        'title': book.subtitle ? `${book.title}: ${book.subtitle}` : book.title,
        'author': book.author || 'Anonymous',
        'subjects': (book.subjects ?? []).join(', '),
        'description': book.description ?? ''
    };
}


// Ask a book the questions - the answers, by question name
export async function decide(book, {model = decisionModel, questions}) {
    const {answers} = await ollamaPost('/v1/systemone', {model, 'state': bookState(book), questions, 'keep_alive': '10m'});
    return answers;
}


// Decide books - each book's decision (answer(answers), an object), by "source|id", cached in cacheName's file under
// the cache directory by the questions and the book's state; label names the decisions in the progress lines
export async function decideBooks(books, {model = decisionModel, questions, answer, cacheName, label, log = null}) {
    await checkModel(model);
    const cachePath = join(cacheDir, `${cacheName}.json`);
    const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf-8')) : {};
    const questionsHash = createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 12);
    const decisions = {};
    let decided = 0;
    const start = Date.now();
    for (const book of books) {
        const key = `${book.source}|${book.id}`;
        const hash = createHash('sha256').update(`${questionsHash}|${JSON.stringify(bookState(book))}`).digest('hex').slice(0, 16);
        if (cache[key]?.hash !== hash) {
            cache[key] = {hash, ...answer(await decide(book, {model, questions}))};
            decided++;
            if (decided % 100 === 0) {
                writeCache(cachePath, cache);
                log?.(`${label}: ${decided} books decided (${((Date.now() - start) / decided).toFixed(0)} ms a book)`);
            }
        }
        decisions[key] = cache[key];
    }
    writeCache(cachePath, cache);
    const speed = decided > 0 ? `, ${((Date.now() - start) / decided).toFixed(0)} ms a book` : '';
    log?.(`${label}: ${books.length} books (${decided} decided with ${model}${speed})`);
    return decisions;
}


// Write a decisions cache, so an interrupted write never leaves a partial file
function writeCache(path, cache) {
    mkdirSync(dirname(path), {'recursive': true});
    writeFileSync(`${path}.tmp`, JSON.stringify(cache));
    renameSync(`${path}.tmp`, path);
}


// The catalog's books (PICOSHELF_CATALOG reads another catalog file - the tests')
export function catalogBooks() {
    const catalogPath = process.env.PICOSHELF_CATALOG ?? join(root, 'data', 'catalog.json');
    return JSON.parse(readFileSync(catalogPath, 'utf-8')).books;
}
