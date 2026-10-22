// The Wikipedia source - English Wikipedia's articles for reading aloud, and the Wikipedia shelf's listings: today's
// featured and most-read articles, and search. Wikipedia's APIs send CORS headers (origin=* - no proxy), so the shelf is
// live, not in the catalog: an article's plain text (the TextExtracts API), its sections the chapters, without the
// references and links sections. Wikipedia's text is CC BY-SA - each article is credited to Wikipedia.

// The APIs, and the app's identification (Wikimedia's API etiquette - a browser can't set User-Agent)
const apiUrl = 'https://en.wikipedia.org/w/api.php';
const feedUrl = 'https://en.wikipedia.org/api/rest_v1/feed/featured';
const requestHeaders = {'Api-User-Agent': 'PicoShelf (https://craigahobbs.github.io/picoshelf/)'};

// An article's narrator by default - Michael, the listener's choice of PicoVox's best voices on encyclopedia prose,
// measured: of the twelve voices on twelve Wikipedia articles' openings he scores the second-highest UTMOS (4.29; Helen
// 4.35, the median voice 4.20), and on the listener panel's texts (4.27; Helen 4.30) - his word error rate the median's
// (2026-10-21, two noise seeds)
export const articleVoice = 'michael';

// The sections not read - an article's apparatus
const skippedSections = new Set([
    'bibliography', 'citations', 'explanatory notes', 'external links', 'footnotes', 'further reading', 'general references',
    'notes', 'notes and references', 'references', 'references and notes', 'see also', 'sources', 'works cited'
]);

// Error messages
const errorOffline = 'Couldn\'t reach Wikipedia - check your connection and try again.';
const errorMissing = 'This article isn\'t on Wikipedia.';


// The source
export const source = {
    'id': 'wikipedia',
    'name': 'Wikipedia',
    load
};


// An article's book - {source, id (its title), title, author, description, cover, voice}
export function articleBook({title, description = '', cover = null}) {
    return {'source': 'wikipedia', 'id': title, title, 'author': 'Wikipedia', description, cover, 'voice': articleVoice};
}


// Fetch a Wikipedia API's JSON
async function fetchJson(url) {
    let response;
    try {
        response = await fetch(url, {'headers': requestHeaders});
    } catch {
        throw new Error(errorOffline);
    }
    if (!response.ok) {
        throw new Error(`Wikipedia couldn't be reached (error ${response.status}) - try again later.`);
    }
    return response.json();
}


// An action API URL - the parameters, JSON (format version 2), and origin=* for CORS
function actionUrl(params) {
    const query = new URLSearchParams({...params, 'format': 'json', 'formatversion': '2', 'origin': '*'});
    return `${apiUrl}?${query}`;
}


// Today's articles - the featured article, then the day's most read (the feed of the reader's date; yesterday's if
// today's isn't published yet), as books
export async function todaysArticles(date = new Date()) {
    let feed = null;
    for (const day of [date, new Date(date.getTime() - 86400000)]) {
        const path = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('/');
        try {
            feed = await fetchJson(`${feedUrl}/${path}`);
            break;
        } catch (error) {
            if (day !== date) {
                throw error;
            }
        }
    }
    const articles = [];
    const seen = new Set();
    const add = (page) => {
        if (page?.titles?.canonical && page.namespace?.id === 0 && !seen.has(page.titles.normalized)) {
            seen.add(page.titles.normalized);
            articles.push(articleBook({
                'title': page.titles.normalized, 'description': page.description ?? '', 'cover': page.thumbnail?.source ?? null
            }));
        }
    };
    add(feed.tfa);
    for (const page of feed.mostread?.articles ?? []) {
        add(page);
    }
    return articles;
}


// Search Wikipedia - {books, next (the offset of the next page, or null)}; count results from offset
export async function searchArticles(query, offset = 0, count = 24) {
    const data = await fetchJson(actionUrl({
        'action': 'query', 'generator': 'search', 'gsrsearch': query, 'gsrnamespace': '0', 'gsrlimit': String(count),
        'gsroffset': String(offset), 'prop': 'description|pageimages', 'piprop': 'thumbnail', 'pithumbsize': '200'
    }));
    const pages = [...data.query?.pages ?? []].sort((first, second) => first.index - second.index);
    return {
        'books': pages.map((page) => articleBook({
            'title': page.title, 'description': page.description ?? '', 'cover': page.thumbnail?.source ?? null
        })),
        'next': data.continue?.gsroffset ?? null
    };
}


// A heading's title and level - "== Plot ==" is level 1 (a section), "=== Point of view ===" level 2, ...; null for a
// line that isn't a heading
function heading(line) {
    const match = /^(={2,6})\s*(.*?)\s*\1$/.exec(line.trim());
    return match === null ? null : {'title': match[2], 'level': match[1].length - 1};
}


// An article's plain text (TextExtracts, sections as "== Title ==") for reading aloud - {text, chapters, title, author}:
// the title, the lead, and the sections, each a chapter (its heading spoken), without the apparatus sections and
// without empty headings
export function prepareArticle(title, extract) {
    // The paragraphs and headings, the skipped sections (and their subsections) left out
    const items = [];
    let skipLevel = null;
    for (const line of extract.split('\n')) {
        const found = heading(line);
        if (found !== null) {
            if (skipLevel !== null && found.level > skipLevel) {
                continue;
            }
            skipLevel = skippedSections.has(found.title.toLowerCase()) ? found.level : null;
            if (skipLevel === null) {
                items.push({'heading': found});
            }
        } else if (skipLevel === null && line.trim() !== '') {
            items.push({'paragraph': line.replace(/\s+/g, ' ').trim()});
        }
    }

    // A heading with no text before the next heading of its level or above is left out
    const kept = items.filter((item, index) => {
        if (item.heading === undefined) {
            return true;
        }
        for (const next of items.slice(index + 1)) {
            if (next.paragraph !== undefined) {
                return true;
            }
            if (next.heading.level <= item.heading.level) {
                return false;
            }
        }
        return false;
    });

    // The text - the title, then each paragraph (a heading spoken as its own sentence) - and the chapters
    const spoken = (text) => (/[.!?:]$/.test(text) ? text : `${text}.`);
    const titleText = spoken(title);
    const paragraphs = [titleText];
    const chapters = [{title, 'char': 0, 'level': 1}];
    let {length} = titleText;
    for (const item of kept) {
        const text = item.heading === undefined ? item.paragraph : spoken(item.heading.title);
        if (item.heading !== undefined) {
            chapters.push({'title': item.heading.title, 'char': length + 2, 'level': item.heading.level});
        }
        paragraphs.push(text);
        length += 2 + text.length;
    }
    return {'text': paragraphs.join('\n\n'), chapters, title, 'author': 'Wikipedia'};
}


// The default progress callback
function noProgress() {
    // no progress reporting
}


// An article's text for reading aloud and display - {text, chapters, title, author}; onProgress(loadedBytes, null)
async function load(book, onProgress = noProgress) {
    const data = await fetchJson(actionUrl({
        'action': 'query', 'prop': 'extracts', 'explaintext': '1', 'exsectionformat': 'wiki', 'redirects': '1', 'titles': book.id
    }));
    const page = data.query?.pages?.[0];
    if (page === undefined || page.missing || !page.extract) {
        throw new Error(errorMissing);
    }
    onProgress(page.extract.length, null);
    return prepareArticle(page.title, page.extract);
}
