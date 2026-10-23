// Build the book catalog, data/catalog.json - every Standard Ebooks book, and Project Gutenberg's books: the most popular
// first, whatever their genres, then balanced by genre - each genre's share of the catalog by the square root of its
// popularity (its candidates' downloads), at least genreFloor books, filled with its most-downloaded books. Each
// Gutenberg book's plain text is in the GITenberg mirror on GitHub and passes the quality rules (tools/quality.js). The
// app fetches texts from their sources with CORS at play time, so the catalog holds only metadata and each book's text
// URL.
//
// node tools/catalog.js [--books <count>] [--popular <count>] [--gutenberg <count>] [--standardebooks <count>]
//                       [--max-age <days>] [--page-max-age <days>] [--cache-only] [--voice-model <model>] [-o <file>]
//
//   --books <count>           the catalog's size - its Standard Ebooks books and the Gutenberg books (default 5000)
//   --popular <count>         the top Gutenberg candidates (by downloads) chosen first, whatever their genres (default
//                             1000)
//   --gutenberg <count>       the number of top Gutenberg books (by downloads) whose genres are decided - the candidates
//                             (default 8000)
//   --standardebooks <count>  only the most popular Standard Ebooks books (default all)
//   --max-age <days>          refetch Gutenberg's catalog and the Standard Ebooks listing pages older than this
//                             (default 30)
//   --page-max-age <days>     refetch Standard Ebooks book pages older than this (default 365 - they rarely change)
//   --cache-only              no network requests - build from the cache alone (uncached pages and texts are left out)
//   --voice-model <model>     the Ollama decision model that casts each book's narrator and chooses its genres (default
//                             tools/decide.js's)
//   -o <file>                 the output file (default data/catalog.json)
//
// Each book's narrator - its voice - and its genres are chosen by a local Ollama decision model (tools/voicecast.js,
// tools/genres.js; Ollama must be running, with the model pulled). Gutenberg's books come from its catalog
// (rdf-files.tar.bz2 - tools/gutenbergrdf.js), and their GITenberg repositories from the gitberg project's published
// list. Everything fetched is cached under cache/catalog/, so a rerun is fast and an interrupted build resumes;
// requests are throttled per site (Standard Ebooks about 2 a second) and retried with backoff.

import {bookGenres, genreNames} from './genres.js';
import {cacheDir, decisionModel, readJSONCache, root, writeFileAtomic} from './decide.js';
import {createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync} from 'node:fs';
import {decodeText, prepareText} from '../lib/gutenberg.js';
import {dirname, join} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';
import {qualityVersion, textQuality} from './quality.js';
import {JSDOM} from 'jsdom';
import {Readable} from 'node:stream';
import {castBooks} from './voicecast.js';
import {fileURLToPath} from 'node:url';
import {normalizeText} from '../lib/catalog.js';
import {pipeline} from 'node:stream/promises';
import process from 'node:process';
import {readArchive} from './gutenbergrdf.js';


const userAgent = 'picoshelf-catalog/1.0 (+https://github.com/craigahobbs/picoshelf)';

const seURL = 'https://standardebooks.org';
const gutenbergCatalogURL = 'https://www.gutenberg.org/cache/epub/feeds/rdf-files.tar.bz2';
const gitenbergListURL = 'https://raw.githubusercontent.com/gitenberg-dev/gitberg/master/gitenberg/data/GITenberg_repo_list.tsv';
const gitenbergRawURL = 'https://raw.githubusercontent.com/GITenberg/';

// The minimum milliseconds between requests to a host
const hostIntervals = {
    'standardebooks.org': 500,
    'www.gutenberg.org': 1000,
    'raw.githubusercontent.com': 100
};

// The smallest genre's books, and the texts checked at once (GITenberg's raw files, throttled as above)
const genreFloor = 40;
const textConcurrency = 8;

// The catalog's sources
const sources = {
    'standardebooks': {
        'name': 'Standard Ebooks',
        'url': seURL,
        'description': 'Carefully edited, beautifully typeset public-domain classics, freely available.'
    },
    'gutenberg': {
        'name': 'Project Gutenberg',
        'url': 'https://www.gutenberg.org',
        'description': 'The oldest digital library - tens of thousands of free public-domain books, read from its GITenberg mirror.'
    }
};

// Description and subject limits
const descriptionLength = 600;
const subjectCount = 8;


// Parse the command line
export function parseArgs(args) {
    const options = {
        'books': 5000, 'popular': 1000, 'gutenberg': 8000, 'standardebooks': Infinity, 'maxAge': 30, 'pageMaxAge': 365,
        'cacheOnly': false,
        'output': join(root, 'data', 'catalog.json'), 'voiceModel': decisionModel
    };
    for (let ix = 0; ix < args.length; ix++) {
        const arg = args[ix];
        if (arg === '--books') {
            options.books = Number(args[++ix]);
        } else if (arg === '--popular') {
            options.popular = Number(args[++ix]);
        } else if (arg === '--gutenberg') {
            options.gutenberg = Number(args[++ix]);
        } else if (arg === '--standardebooks') {
            options.standardebooks = Number(args[++ix]);
        } else if (arg === '--max-age') {
            options.maxAge = Number(args[++ix]);
        } else if (arg === '--page-max-age') {
            options.pageMaxAge = Number(args[++ix]);
        } else if (arg === '--cache-only') {
            options.cacheOnly = true;
        } else if (arg === '--voice-model') {
            options.voiceModel = args[++ix];
        } else if (arg === '-o') {
            options.output = args[++ix];
        } else {
            throw new Error(`Unknown argument "${arg}"`);
        }
    }
    for (const name of ['books', 'popular', 'gutenberg', 'standardebooks', 'maxAge', 'pageMaxAge']) {
        if (Number.isNaN(options[name]) || options[name] < 0) {
            throw new Error(`Invalid ${name} "${options[name]}"`);
        }
    }
    return options;
}


//
// Logging
//


const startTime = Date.now();

// The builder's output and waits - the tests replace them (mock.method)
export const services = {
    // Write output text
    write(text) {
        process.stdout.write(text);
    },

    // Sleep for milliseconds
    sleep(milliseconds) {
        return new Promise((resolve) => {
            setTimeout(resolve, milliseconds);
        });
    }
};


// Write a progress line with the elapsed time
export function log(message) {
    const seconds = Math.round((Date.now() - startTime) / 1000);
    services.write(`[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}] ${message}\n`);
}


//
// Fetching - throttled per host, retried with backoff
//


const hostNextTimes = new Map();

// Wait for a host's turn
async function throttle(url) {
    const {host} = new URL(url);
    const now = Date.now();
    const nextTime = Math.max(now, hostNextTimes.get(host) ?? 0);
    hostNextTimes.set(host, nextTime + (hostIntervals[host] ?? 500));
    if (nextTime > now) {
        await services.sleep(nextTime - now);
    }
}


// Fetch a URL - network errors, timeouts, 429s, and 5xx responses are retried with exponential backoff (or the
// response's Retry-After)
export async function fetchRetry(url, {method = 'GET', headers = {}, timeout = 60000, attempts = 6} = {}) {
    // (Not "for (let attempt = 1; ; attempt++)" - V8's coverage counts that loop's unreachable end as an uncovered branch)
    let attempt = 1;
    for (;; attempt++) {
        await throttle(url);
        let retryAfter = 2 ** attempt;
        try {
            const response = await fetch(url, {
                method,
                'headers': {'User-Agent': userAgent, ...headers},
                'signal': AbortSignal.timeout(timeout)
            });
            if (response.status !== 429 && response.status < 500) {
                return response;
            }
            await response.body?.cancel();
            retryAfter = Math.max(retryAfter, Number(response.headers.get('Retry-After')) || 0);
            if (attempt >= attempts) {
                throw new Error(`${url}: error ${response.status}`);
            }
            log(`  ${url}: error ${response.status} - retrying in ${retryAfter} s`);
        } catch (error) {
            if (attempt >= attempts || error.message.startsWith(url)) {
                throw error;
            }
            log(`  ${url}: ${error.cause?.code ?? error.name} - retrying in ${retryAfter} s`);
        }
        await services.sleep(retryAfter * 1000);
    }
}


// Fetch a URL's text, cached in a file under cache/catalog/ - null for a 404 (cached as well). Cached files older than
// options.maxAge days are refetched (Infinity keeps them forever). With options.cacheOnly (--cache-only), any cached
// file is used and an uncached URL is null.
export async function fetchCached(url, cacheName, {maxAge, cacheOnly}, timeout = 60000) {
    const cachePath = join(cacheDir, cacheName);
    const missingPath = `${cachePath}.404`;
    for (const path of [cachePath, missingPath]) {
        if (existsSync(path) && (cacheOnly || (Date.now() - statSync(path).mtimeMs) < maxAge * 86400000)) {
            return path === cachePath ? readFileSync(path, 'utf-8') : null;
        }
    }
    if (cacheOnly) {
        return null;
    }
    const response = await fetchRetry(url, {timeout});
    if (response.status === 404) {
        await response.body?.cancel();
        writeFileAtomic(missingPath, '');
        return null;
    }
    if (!response.ok) {
        throw new Error(`${url}: error ${response.status}`);
    }
    const text = await response.text();
    writeFileAtomic(cachePath, text);
    return text;
}


// Fetch a URL to a file under the cache directory - its path, refetched as fetchCached's files are (null if it isn't
// cached with options.cacheOnly)
export async function fetchFile(url, cacheName, {maxAge, cacheOnly}, timeout) {
    const cachePath = join(cacheDir, cacheName);
    if (existsSync(cachePath) && (cacheOnly || (Date.now() - statSync(cachePath).mtimeMs) < maxAge * 86400000)) {
        return cachePath;
    }
    if (cacheOnly) {
        return null;
    }
    const response = await fetchRetry(url, {timeout});
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${url}: error ${response.status}`);
    }
    mkdirSync(dirname(cachePath), {'recursive': true});
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${cachePath}.tmp`));
    renameSync(`${cachePath}.tmp`, cachePath);
    return cachePath;
}


// Parse HTML into a document - with one window's DOMParser (a JSDOM window per page holds gigabytes over a crawl)
const domParser = new (new JSDOM('').window.DOMParser)();
export function parseHTML(html) {
    return domParser.parseFromString(html, 'text/html');
}


//
// Text helpers
//


// Collapse whitespace
export function collapseSpace(text) {
    return text.replace(/\s+/g, ' ').trim();
}


// A description trimmed to at most descriptionLength characters, at a sentence end if there is one past a third of
// the limit, else at a word break with an ellipsis
export function trimDescription(text) {
    const description = collapseSpace(text);
    if (description.length <= descriptionLength) {
        return description;
    }
    const head = description.slice(0, descriptionLength + 1);
    const sentenceEnd = Math.max(...[...head.matchAll(/[.!?][”"’)]?(?=\s)/g)].map((match) => match.index + match[0].length));
    if (sentenceEnd > descriptionLength / 3) {
        return head.slice(0, sentenceEnd);
    }
    return `${head.slice(0, head.lastIndexOf(' ')).replace(/[\s,;:—–-]+$/, '')}…`;
}


// A subject list - cleaned, deduplicated (normalized), at most subjectCount
export function uniqueSubjects(subjects) {
    const seen = new Set();
    const result = [];
    for (const subject of subjects.map(collapseSpace)) {
        const key = normalizeText(subject);
        if (key !== '' && !seen.has(key) && result.length < subjectCount) {
            seen.add(key);
            result.push(subject);
        }
    }
    return result;
}


// A key for matching the same work across sources - the normalized title without a leading article or word breaks
// ("The Case-Book of Sherlock Holmes" matches "The Casebook of Sherlock Holmes")
export function titleKey(title) {
    return normalizeText(title).replace(/^(?:the|a|an) /, '').replace(/ /g, '');
}


// Is a Gutenberg book's title (with its subtitle) a Standard Ebooks title's work - the same title key, or its words beginning
// with the Standard Ebooks title's ("The Adventures of Tom Sawyer, Complete", "The Odyssey of Homer", "Walden, and On
// the Duty of Civil Disobedience"; not "Dracula's Guest" - a word, not a prefix)
export function isSameWork(workTitle, seTitle) {
    const words = (title) => normalizeText(title).replace(/^(?:the|a|an) /, '');
    const workWords = words(workTitle);
    const seWords = words(seTitle);
    return titleKey(workTitle) === titleKey(seTitle) || workWords.startsWith(`${seWords} `);
}


// The surname keys of a display author list ('Mary Shelley, Percy Bysshe Shelley') - each name's last word, first
// four letters, so spelling variants of transliterated names match (Dostoevsky, Dostoyevsky); anonymous is ''
export function surnameKeys(author) {
    const keys = author.split(/\s*,\s*/).map((name) => normalizeText(name).split(' ').pop().slice(0, 4)).filter((key) => key !== '');
    return keys.length > 0 ? keys : [''];
}


//
// Standard Ebooks
//


// A Standard Ebooks book id - the book's path on the site
const seIdPattern = /^\/ebooks(\/[a-z0-9][a-z0-9_-]*){2,4}$/;


// Every Standard Ebooks book, by popularity - from the catalog listing pages and each book's page
export async function standardEbooks(options) {
    // The listing pages, in popularity order
    const listed = [];
    const listedIds = new Set();
    for (let page = 1; listed.length < options.standardebooks; page++) {
        const url = `${seURL}/ebooks?sort=popularity&per-page=48&page=${page}`;
        const html = await fetchCached(url, `standardebooks/list-${page}.html`, options);
        if (html === null) {
            break;
        }
        const doc = parseHTML(html);

        // A page past the end shows the last page
        const nav = doc.querySelector('nav.pagination');
        const currentPage = nav?.querySelector('a[aria-current="page"]')?.textContent.trim() ?? '1';
        if (currentPage !== String(page)) {
            break;
        }
        for (const item of doc.querySelectorAll('li[typeof="schema:Book"]')) {
            const id = item.getAttribute('about') ?? '';
            if (!seIdPattern.test(id) || listedIds.has(id) || listed.length >= options.standardebooks) {
                continue;
            }
            listedIds.add(id);
            const coverSrc = item.querySelector('img')?.getAttribute('src');
            listed.push({
                id,
                'title': collapseSpace(item.querySelector('p:not(.author) [property="schema:name"]')?.textContent ?? ''),
                'authors': [...item.querySelectorAll('p.author [property="schema:name"]')].map((span) => collapseSpace(span.textContent)),
                'cover': coverSrc ? new URL(coverSrc, seURL).href : null
            });
        }
        log(`Standard Ebooks: listing page ${page} - ${listed.length} books`);
        if (!nav?.querySelector('a[rel="next"][href]')) {
            break;
        }
    }

    // Each book's page
    const books = [];
    let missing = 0;
    for (const [index, item] of listed.entries()) {
        const cacheName = `standardebooks/book${item.id.slice('/ebooks'.length).replace(/\//g, '_')}.html`;
        const html = await fetchCached(`${seURL}${item.id}`, cacheName, {...options, 'maxAge': options.pageMaxAge});
        const book = html === null ? null : standardEbook(item, parseHTML(html));
        if (book === null) {
            log(`  Standard Ebooks: ${item.id} - no book page or EPUB download`);
            missing++;
        } else {
            book.rank = books.length + 1;
            books.push(book);
        }
        if ((index + 1) % 100 === 0) {
            log(`Standard Ebooks: ${index + 1} of ${listed.length} book pages`);
        }
    }
    log(`Standard Ebooks: ${books.length} books (${missing} without a book page or EPUB)`);
    return books;
}


// A Standard Ebooks catalog book from its listing item and book page, or null if it has no EPUB download
export function standardEbook(item, doc) {
    const article = doc.querySelector('article[typeof="schema:Book"]') ?? doc;
    const meta = (property) => article.querySelector(`meta[property="schema:${property}"]`)?.getAttribute('content') ?? null;

    // The EPUB download - the compatible EPUB, not the Kobo or advanced ones
    const links = [...doc.querySelectorAll('a[href*="/downloads/"]')].map((link) => link.getAttribute('href'));
    const epubHref = links.find((link) => /\.epub$/.test(link) && !/(\.kepub|_advanced)\.epub$/.test(link)) ??
        links.find((link) => /\.epub$/.test(link) && !/\.kepub\.epub$/.test(link));
    if (!epubHref) {
        return null;
    }

    // Title, subtitle, and authors - the book page's, falling back to the listing's
    const hgroup = article.querySelector('hgroup');
    const title = collapseSpace(hgroup?.querySelector('h1')?.textContent ?? '') || item.title;
    const subtitle = collapseSpace(hgroup?.querySelector('[property="schema:alternativeHeadline"]')?.textContent ?? '');
    const pageAuthors = [...(hgroup?.querySelectorAll('[property="schema:author"] [property="schema:name"]') ?? [])]
        .map((span) => collapseSpace(span.textContent));
    const authors = (pageAuthors.length > 0 ? pageAuthors : item.authors).filter((name) => name !== '');

    // The short blurb, else the long description's first paragraph
    const description = meta('abstract') ?? article.querySelector('[property="schema:description"] p')?.textContent ?? '';
    const words = Number(meta('wordCount'));
    return {
        'source': 'standardebooks',
        'id': item.id,
        title,
        ...(subtitle === '' ? {} : {subtitle}),
        'author': authors.join(', '),
        'description': trimDescription(description),
        'subjects': uniqueSubjects([...article.querySelectorAll('ul.tags a')].map((link) => link.textContent)),
        'language': (meta('inLanguage') ?? 'en').split('-')[0],
        'cover': item.cover,
        'rank': 0,
        'words': words > 0 ? words : null,
        'text': {'url': `${new URL(epubHref, seURL).href}?source=download`, 'format': 'epub'}
    };
}


//
// Project Gutenberg
//


// Project Gutenberg's English texts that aren't under copyright, most downloaded first - from its catalog
// (rdf-files.tar.bz2, read by tools/gutenbergrdf.js as Gutendex-style results), refetched after options.maxAge days
export async function gutenbergRecords(options) {
    const archivePath = await fetchFile(gutenbergCatalogURL, 'gutenberg/rdf-files.tar.bz2', options, 600000);
    if (archivePath === null) {
        log('Gutenberg: no cached catalog');
        return [];
    }
    const records = (await readArchive(archivePath)).filter((record) => record.media_type === 'Text' && record.languages.includes('en') &&
        record.copyright !== true && Object.keys(record.formats).some((type) => type.startsWith('text/plain')));
    records.sort((first, second) => (second.download_count - first.download_count) || (first.id - second.id));
    log(`Gutenberg: ${records.length} English texts in its catalog`);
    return records;
}


// A Gutendex title as a title and subtitle - one line, split at the first colon, semicolon, or dash outside
// parentheses, without a generic subtitle ("A Novel", "Complete"), and a long subtitle shortened
const subtitleLength = 100;
export function gutenbergTitle(rawTitle) {
    const oneLine = rawTitle.replace(/\s*[\r\n]+\s*/g, (match, offset) => (/[;:,]$/.test(rawTitle.slice(0, offset)) ? ' ' : ': ')).trim();
    const separator = [...oneLine.matchAll(/\s*(?:[:;]|\s[—–]\s|\s-{1,2}\s|—|--)\s*/g)].find((match) => {
        const prefix = oneLine.slice(0, match.index);
        return match.index >= 3 && prefix.split('(').length === prefix.split(')').length;
    });
    if (!separator) {
        return {'title': titleCase(oneLine), 'subtitle': ''};
    }
    const title = oneLine.slice(0, separator.index).replace(/[,.]$/, '');
    let subtitle = oneLine.slice(separator.index + separator[0].length).trim();
    if (/^(?:(?:a|an)\s+(?:novel|romance|tale|story|play|poem)|complete)\.?$/i.test(subtitle)) {
        subtitle = '';
    } else if (subtitle.length > subtitleLength) {
        subtitle = `${subtitle.slice(0, subtitle.lastIndexOf(' ', subtitleLength)).replace(/[\s,;:—–-]+$/, '')}…`;
    }
    return {'title': titleCase(title), 'subtitle': titleCase(subtitle)};
}


// Title-case a title in sentence case or lowercase ("The three musketeers" is "The Three Musketeers", "or, the modern
// prometheus" is "Or, the Modern Prometheus") - a title with mostly capitalized words is left as it is
const smallWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'de', 'du', 'for', 'from', 'in', 'into', 'la', 'le', 'nor', 'of', 'on', 'or',
    'the', 'to', 'van', 'von', 'with'
]);
export function titleCase(text) {
    const capitalize = (word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    const words = text.split(' ');
    const isSmall = (word) => smallWords.has(word.replace(/\W/g, '')) || /^d['’]/.test(word);
    const majorWords = words.slice(1).filter((word) => /^[a-zA-Z]/.test(word) && !isSmall(word));
    const lowerCount = majorWords.filter((word) => /^[a-z]/.test(word)).length;
    if (lowerCount === 0 || lowerCount < majorWords.length - lowerCount) {
        return capitalize(text);
    }
    return words.map((word, index) => (index > 0 && isSmall(word) ? word : capitalize(word))).join(' ');
}


// A Gutendex author name ('Last, First (Full Names), suffix') in display order ('First Last')
const epithetRegex = /^(?:Emperor|Empress|King|Queen|Saint|St\.|Pope|Prince|Princess|Duke|Earl|Lord|Lady|Baron|Count|Countess)\b/;
export function gutenbergAuthor(name) {
    const parts = name.replace(/\s*\([^)]*\)/g, '').split(/\s*,\s*/).filter((part) => part !== '');
    if (parts.length < 2) {
        return parts.join('');
    }
    // An epithet ('Marcus Aurelius, Emperor of Rome') isn't a first name
    if (epithetRegex.test(parts[1])) {
        return parts[0];
    }
    // A lowercase particle ('Augustine, of Hippo, Saint') follows the name
    if (/^[a-z]/.test(parts[1])) {
        return `${parts[0]} ${parts[1]}`;
    }
    const suffix = parts.slice(2).find((part) => /^(?:Jr\.?|Sr\.?|[IVX]+)$/.test(part));
    return `${parts[1]} ${parts[0]}${suffix ? ` ${suffix}` : ''}`;
}


// A Gutendex summary as a description - without the "(This is an automatically generated summary.)" note, and
// without the leading '"Title" by Author is' phrase (the title and author are shown with it)
export function gutenbergDescription(summary) {
    let description = collapseSpace(summary).replace(/\s*\(This is an automatically generated summary\.?\)\s*$/i, '');
    const match = description.match(/^["“][^"”]{1,300}["”],?\s+(?:\([^)]{0,100}\)\s+)?(?:by\s+.{1,200}?\s+)?(?:is|are)\s+(an?|the)\s+(\S)/);
    if (match) {
        description = `${match[1].charAt(0).toUpperCase()}${match[1].slice(1)} ${match[2]}${description.slice(match[0].length)}`;
    }
    return trimDescription(description);
}


// Gutenberg subjects - the bookshelf categories, then the Library of Congress subjects (their topic, without
// subdivisions; characters as "First Last"), with "Fiction" for fiction
export function gutenbergSubjects(result) {
    const shelves = result.bookshelves
        .filter((shelf) => /^(?:Category|Browsing):\s/.test(shelf))
        .map((shelf) => shelf.replace(/^[^:]+:\s*/, ''));
    const topics = result.subjects.map((subject) => {
        const [topic] = subject.split(' -- ');
        const plain = topic.replace(/\s*\([^)]*\)/g, '');
        const name = plain.replace(/,\s*(?:[a-z.]+\s*)?\d[^,]*$/, '');
        if ((name !== plain || topic !== plain) && name.includes(',')) {
            return gutenbergAuthor(name);
        }
        return plain;
    });
    const fiction = result.subjects.some((subject) => /\bfiction\b/i.test(subject)) ? ['Fiction'] : [];
    return uniqueSubjects([...fiction, ...shelves, ...topics]);
}


// The GITenberg repository names by Gutenberg id - from the gitberg project's published list
export async function gitenbergRepositories(options) {
    const tsv = await fetchCached(gitenbergListURL, 'gitenberg/GITenberg_repo_list.tsv', options, 300000);
    const repositories = new Map();
    for (const line of (tsv ?? '').split('\n')) {
        const [id, name] = line.trim().split('\t');
        if (/^\d+$/.test(id) && name && name.endsWith(`_${id}`) && !repositories.has(id)) {
            repositories.set(id, name);
        }
    }
    return repositories;
}


// Is a Gutenberg record a reference work (a dictionary, encyclopedia, index, or the like) - not for reading aloud?
const referenceTitleWords = [
    'dictionary', 'dictionaries', 'encyclop(?:a)?edia', 'cyclop(?:a)?edia', 'thesaurus', 'glossary', 'concordance', 'gazetteer', 'index of'
];
const referenceSubjects = [
    'dictionaries', 'encyclopedias and dictionaries', 'indexes', 'catalogs', 'glossaries, vocabularies', 'concordances', 'gazetteers'
];
const referenceTitleRegex = new RegExp(`\\b(?:${referenceTitleWords.join('|')})\\b`, 'i');
const referenceSubjectRegex = new RegExp(`^(?:${referenceSubjects.join('|')})\\b`, 'i');
export function isReferenceWork(result) {
    return referenceTitleRegex.test(result.title) ||
        result.subjects.some((subject) => subject.split(' -- ').some((part) => referenceSubjectRegex.test(part.trim())));
}


// The Gutenberg candidates - the most-downloaded options.gutenberg books in GITenberg (repositories - the newest
// Gutenberg books aren't, and their first month's downloads are high), without reference works, Standard Ebooks
// duplicates, or less popular editions of a book - each a catalog book (without its rank, words, and text) with its
// downloads
export function gutenbergCandidates(records, seBooks, repositories, options) {
    // Standard Ebooks' titles, by author surname
    const seTitles = new Map();
    for (const book of seBooks) {
        for (const surname of surnameKeys(book.author)) {
            seTitles.set(surname, [...(seTitles.get(surname) ?? []), book.title]);
        }
    }
    const candidates = [];
    const fullTitles = new Set();
    let notInGitenberg = 0;
    let seDuplicates = 0;
    let gutenbergDuplicates = 0;
    let referenceWorks = 0;
    for (const record of records) {
        if (candidates.length >= options.gutenberg) {
            break;
        }
        if (!repositories.has(String(record.id))) {
            notInGitenberg++;
            continue;
        }
        if (isReferenceWork(record)) {
            referenceWorks++;
            continue;
        }
        const {title, subtitle} = gutenbergTitle(record.title);
        const author = record.authors.map((person) => gutenbergAuthor(person.name)).filter((name) => name !== '').join(', ');
        const workTitle = subtitle === '' ? title : `${title} ${subtitle}`;
        if (surnameKeys(author).some((surname) => (seTitles.get(surname) ?? []).some((seTitle) => isSameWork(workTitle, seTitle)))) {
            seDuplicates++;
            continue;
        }
        const fullTitle = `${normalizeText(`${title} ${subtitle}`)}|${normalizeText(author)}`;
        if (fullTitles.has(fullTitle)) {
            gutenbergDuplicates++;
            continue;
        }
        fullTitles.add(fullTitle);
        candidates.push({
            'source': 'gutenberg',
            'id': String(record.id),
            title,
            ...(subtitle === '' ? {} : {subtitle}),
            author,
            'description': gutenbergDescription(record.summaries[0] ?? ''),
            'subjects': gutenbergSubjects(record),
            'language': 'en',
            'cover': record.formats['image/jpeg'] ?? null,
            'downloads': record.download_count
        });
    }
    log(`Gutenberg: ${candidates.length} candidates (${notInGitenberg} not in GITenberg, ${seDuplicates} Standard Ebooks ` +
        `duplicates, ${gutenbergDuplicates} duplicate editions, ${referenceWorks} reference works)`);
    return candidates;
}


// Is a decoded text UTF-8?
function isUTF8(bytes) {
    try {
        new TextDecoder('utf-8', {'fatal': true}).decode(bytes);
        return true;
    } catch {
        return false;
    }
}


// A Gutenberg book's GITenberg text - {version, file, encoding, words, reason (why it isn't used - a quality rule,
// tools/quality.js - or null)}, or null if it isn't cached with options.cacheOnly. The file is the UTF-8 file
// (<id>-0.txt), the plain file (<id>.txt - UTF-8 if it decodes as such, else Windows-1252), or the Latin-1 file
// (<id>-8.txt). GITenberg's texts don't change, so each is cached - its measure in textCache (by id), and the text itself,
// so changed quality rules measure it again without downloading it.
export async function gutenbergText(book, repository, textCache, options) {
    const cached = textCache[book.id];
    if (cached?.version === qualityVersion) {
        return cached;
    }
    const textPath = join(cacheDir, 'gitenberg', 'texts', `${book.id}.txt.gz`);
    let file = cached?.file ?? null;
    let bytes = file !== null && existsSync(textPath) ? gunzipSync(readFileSync(textPath)) : null;
    if (bytes === null) {
        if (options.cacheOnly) {
            return null;
        }
        file = null;
        for (const name of [`${book.id}-0.txt`, `${book.id}.txt`, `${book.id}-8.txt`]) {
            const url = `${gitenbergRawURL}${repository}/master/${name}`;
            const response = await fetchRetry(url);
            if (response.status === 404) {
                await response.body?.cancel();
                continue;
            }
            if (!response.ok) {
                throw new Error(`${url}: error ${response.status}`);
            }
            bytes = new Uint8Array(await response.arrayBuffer());
            file = name;
            break;
        }
        if (file === null) {
            textCache[book.id] = {'version': qualityVersion, file, 'encoding': null, 'words': 0, 'reason': 'no text file'};
            return textCache[book.id];
        }
        writeFileAtomic(textPath, gzipSync(bytes));
    }
    const encoding = file.endsWith('-8.txt') || (file === `${book.id}.txt` && !isUTF8(bytes)) ? 'windows-1252' : 'utf-8';
    const quality = textQuality(prepareText(decodeText(bytes, encoding), book).text);
    textCache[book.id] = {'version': qualityVersion, file, encoding, 'words': quality.words, 'reason': quality.reasons.join(', ') || null};
    return textCache[book.id];
}


// Each open genre's share of the remaining books - by the square root of its weight, at least floor
function genreShares(weights, open, remaining, floor) {
    const sum = open.reduce((current, key) => current + Math.sqrt(weights[key]), 0);
    return Object.fromEntries(open.map((key) => [key, Math.max(floor, sum > 0 ? remaining * Math.sqrt(weights[key]) / sum : 0)]));
}


// The genres' sizes in a catalog of total books - each genre's share by the square root of its popularity (its
// weight - its Gutenberg candidates' downloads), at least floor books and at least its fixed books (its Standard Ebooks
// books, all kept). A genre whose fixed books exceed its share keeps them, and the others share the rest.
export function genreQuotas(weights, fixed, total, floor) {
    const quotas = {};
    let open = Object.keys(weights);
    let remaining = total;
    for (;;) {
        const shares = genreShares(weights, open, remaining, floor);
        const over = open.filter((key) => (fixed[key] ?? 0) >= shares[key]);
        if (over.length === 0) {
            for (const key of open) {
                quotas[key] = Math.round(shares[key]);
            }
            return quotas;
        }
        for (const key of over) {
            quotas[key] = fixed[key] ?? 0;
            remaining -= quotas[key];
        }
        open = open.filter((key) => !over.includes(key));
    }
}


// Run tasks (async functions) at most limit at once - a function that queues a task, returning its promise
function taskLimiter(limit) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active < limit && queue.length > 0) {
            active++;
            const {task, resolve, reject} = queue.shift();
            task().then(resolve, reject).finally(() => {
                active--;
                next();
            });
        }
    };
    return (task) => new Promise((resolve, reject) => {
        queue.push({task, resolve, reject});
        next();
    });
}


// Choose the Gutenberg books for a catalog of options.books books - each genre's quota (genreQuotas, less its Standard
// Ebooks books) from its candidates in download order, then any room left from the other candidates in download order -
// each with a GITenberg text that passes the quality rules. Each genre's coverage is logged.
export async function chooseGutenberg(seBooks, candidates, genres, repositories, options) {
    const primary = (book) => genres[`${book.source}|${book.id}`][0];
    const seCounts = {};
    for (const book of seBooks) {
        seCounts[primary(book)] = (seCounts[primary(book)] ?? 0) + 1;
    }
    const weights = Object.fromEntries(Object.keys(genreNames()).map((key) => [key, 0]));
    for (const book of candidates) {
        weights[primary(book)] += book.downloads;
    }

    // The texts' checks - at most textConcurrency at once (each book's once - the popular candidates, its genre's other
    // candidates, then those not yet checked)
    const textCacheName = 'gitenberg/quality.json';
    const textCache = readJSONCache(textCacheName);
    const limit = taskLimiter(textConcurrency);
    const checks = new Set();
    let checked = 0;
    const check = (book) => {
        checks.add(book.id);
        return limit(async () => {
            const repository = repositories.get(book.id);
            const text = await gutenbergText(book, repository, textCache, options);
            checked++;
            if (checked % 200 === 0) {
                writeFileAtomic(join(cacheDir, textCacheName), JSON.stringify(textCache));
                log(`Gutenberg: ${checked} texts checked`);
            }
            return text === null ? {'reason': 'not downloaded'} : {...text, repository};
        });
    };

    // Accept the passing books of a list in order, up to count - checked count at a time
    const chosen = new Map();
    const stats = Object.fromEntries(Object.keys(weights).map((genre) => [genre, {'chosen': 0, 'tried': 0, 'reasons': {}}]));
    const accept = async (books, count) => {
        let accepted = 0;
        for (let next = 0; accepted < count && next < books.length;) {
            const batch = books.slice(next, next + count - accepted);
            next += batch.length;
            for (const [ix, text] of (await Promise.all(batch.map(check))).entries()) {
                const genreStats = stats[primary(batch[ix])];
                genreStats.tried++;
                if (text.reason === null) {
                    chosen.set(batch[ix], text);
                    genreStats.chosen++;
                    accepted++;
                } else {
                    genreStats.reasons[text.reason] = (genreStats.reasons[text.reason] ?? 0) + 1;
                }
            }
        }
    };
    // The most popular first - the top options.popular candidates whose texts pass (no more than the catalog has room
    // for), whatever their genres - then the genres' quotas, each genre's Standard Ebooks and popular books fixed (a genre
    // they fill keeps them, and the others share the rest), each filled from its other candidates
    const popular = Math.min(options.popular, candidates.length, Math.max(0, options.books - seBooks.length));
    await accept(candidates.slice(0, popular), popular);
    log(`Gutenberg: ${chosen.size} popular books (of the top ${popular} candidates)`);
    const fixed = Object.fromEntries(Object.entries(stats).map(([genre, {chosen: popularCount}]) => [
        genre, (seCounts[genre] ?? 0) + popularCount
    ]));
    const quotas = genreQuotas(weights, fixed, options.books, genreFloor);
    await Promise.all(Object.keys(quotas).map((genre) => accept(
        candidates.filter((book) => primary(book) === genre && !checks.has(book.id)), quotas[genre] - fixed[genre]
    )));
    await accept(candidates.filter((book) => !checks.has(book.id)), options.books - seBooks.length - chosen.size);
    writeFileAtomic(join(cacheDir, textCacheName), JSON.stringify(textCache));

    // Each genre's coverage
    for (const [genre, genreStats] of Object.entries(stats)) {
        const reasons = Object.entries(genreStats.reasons).sort((first, second) => second[1] - first[1]).
            map(([reason, count]) => `${count} ${reason}`).join(', ');
        log(`  ${genre}: ${(seCounts[genre] ?? 0) + genreStats.chosen} books of ${quotas[genre]} - ${seCounts[genre] ?? 0} ` +
            `Standard Ebooks, ${genreStats.chosen} Gutenberg of ${genreStats.tried} tried${reasons === '' ? '' : ` (${reasons})`}`);
    }

    // The books, most downloaded first
    return candidates.filter((book) => chosen.has(book)).map((candidate, index) => {
        const book = {...candidate};
        delete book.downloads;
        const text = chosen.get(candidate);
        return {
            ...book,
            'rank': index + 1,
            'words': text.words,
            'text': {
                'url': `${gitenbergRawURL}${text.repository}/master/${text.file}`, 'format': 'gutenberg-text', 'encoding': text.encoding
            }
        };
    });
}


//
// The catalog
//


// The catalog JSON - one book per line, so changes diff well
export function catalogJSON(catalog) {
    const {books, ...header} = catalog;
    const headerJSON = JSON.stringify(header, null, 4).replace(/\n\}$/, '');
    return `${headerJSON},\n    "books": [\n${books.map((book) => `        ${JSON.stringify(book)}`).join(',\n')}\n    ]\n}\n`;
}


// Build the catalog with options (parseArgs's)
export async function buildCatalog(options) {
    // Standard Ebooks' books, Gutenberg's catalog, and the GITenberg repositories at once (different sites), then
    // Gutenberg's candidates
    const [seBooks, records, repositories] = await Promise.all([
        standardEbooks(options), options.gutenberg > 0 ? gutenbergRecords(options) : [], gitenbergRepositories(options)
    ]);
    const candidates = gutenbergCandidates(records, seBooks, repositories, options);

    // Every book's genres (the Gutenberg candidates' too - the genres choose them), the Gutenberg books, and the books'
    // narrators
    const genres = await bookGenres([...seBooks, ...candidates], {'model': options.voiceModel, log});
    const gutenberg = await chooseGutenberg(seBooks, candidates, genres, repositories, options);
    const books = [...seBooks, ...gutenberg];
    const voices = await castBooks(books, {'model': options.voiceModel, log});
    const catalog = {
        'version': 1,
        'generated': new Date().toISOString(),
        sources,
        'genres': genreNames(),
        'books': books.map((book) => {
            const key = `${book.source}|${book.id}`;
            return {...book, 'voice': voices[key], 'genres': genres[key]};
        })
    };
    const json = catalogJSON(catalog);
    JSON.parse(json);
    writeFileAtomic(options.output, json);
    log(`${options.output}: ${seBooks.length} Standard Ebooks and ${gutenberg.length} Gutenberg books, ${json.length} bytes`);
}


// The command line
async function main() {
    await buildCatalog(parseArgs(process.argv.slice(2)));
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`error: ${error.message}\n`);
        process.exitCode = 1;
    });
}
