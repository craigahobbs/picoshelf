import {JSDOM} from 'jsdom';
import {articleBook} from '../lib/sources/wikipedia.js';
import {strict as assert} from 'node:assert';
import {main} from '../lib/app.js';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers';
import test from 'node:test';


// The page
const indexHtml = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
const appUrl = 'https://example.com/picoshelf/';


// The test catalog - two Standard Ebooks books, two Project Gutenberg books, and 26 volumes by one author (more than a
// page)
const testCatalog = {
    'version': 1,
    'sources': {
        'standardebooks': {'name': 'Standard Ebooks'},
        'gutenberg': {'name': 'Project Gutenberg'}
    },
    'genres': {'fiction': 'General Fiction', 'horror': 'Horror & Ghost Stories', 'romance': 'Romance'},
    'books': [
        {
            'source': 'standardebooks', 'id': '/ebooks/jane-austen/pride-and-prejudice', 'title': 'Pride and Prejudice',
            'author': 'Jane Austen', 'cover': 'https://example.com/pride.jpg', 'rank': 1, 'voice': 'helen',
            'subjects': ['Fiction'], 'genres': ['romance', 'fiction']
        },
        {
            'source': 'standardebooks', 'id': '/ebooks/mary-shelley/frankenstein', 'title': 'Frankenstein',
            'author': 'Mary Shelley', 'cover': null, 'rank': 2, 'voice': 'robert', 'genres': ['horror']
        },
        {
            'source': 'gutenberg', 'id': '84', 'title': 'Frankenstein; Or, The Modern Prometheus',
            'author': 'Mary Wollstonecraft Shelley', 'cover': null, 'rank': 1, 'voice': 'not-a-voice', 'genres': ['horror']
        },
        {
            'source': 'gutenberg', 'id': '11', 'title': 'Alice\'s Adventures in Wonderland', 'author': 'Lewis Carroll',
            'cover': null, 'rank': 2, 'genres': ['fiction']
        },
        ...Array.from({'length': 26}, (_value, ix) => ({
            'source': 'gutenberg', 'id': String(1000 + ix), 'title': `Volume ${ix + 1}`, 'author': 'Prolific Writer',
            'cover': null, 'rank': 10 + ix, 'genres': ['fiction']
        }))
    ]
};


// A book's text - 1000 characters, before its first section (0-99), then three sections
const testText = 'x'.repeat(1000);
const testChapters = [
    {'title': 'Chapter I', 'char': 100, 'level': 1},
    {'title': 'A Part', 'char': 300, 'level': 2},
    {'title': 'Chapter II', 'char': 600}
];


// Saved-state keys
const prideKey = 'standardebooks:/ebooks/jane-austen/pride-and-prejudice';
const frankensteinKey = 'standardebooks:/ebooks/mary-shelley/frankenstein';
const gutenbergKey = 'gutenberg:84';


// Wait for the app's pending promises and tasks
async function settle() {
    for (let ix = 0; ix < 5; ix++) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
}


// A promise and its resolve/reject functions
function deferred() {
    const result = {};
    result.promise = new Promise((resolve, reject) => {
        result.resolve = resolve;
        result.reject = reject;
    });
    return result;
}


// The fake playback engine - the Engine's API, its state set by the tests
class FakeEngine {
    constructor({onChange, slowdown, voiceModelUrl}) {
        this.onChange = onChange;
        this.slowdown = slowdown;
        this.voiceModelUrl = voiceModelUrl;
        this.calls = [];
        this.timeline = [];
        this.error = undefined;
        this.playing = false;
        this.text = null;
        this.status = 'paused';
        this.char = 0;
        this.sentenceChar = 0;
        this.sentence = '';
        this.remainingSeconds = 0;
        this.rate = 10;
    }

    load(text, voice, startChar) {
        this.calls.push(['load', text.length, voice, startChar]);
        this.text = text;
        this.voice = voice;
        this.char = startChar;
        this.sentenceChar = startChar;
        this.sentence = 'It is a truth universally acknowledged.';
        this.onChange(this.state());
    }

    // (the engine tells the app - as the real engine does)
    unload() {
        this.calls.push(['unload']);
        this.text = null;
        this.onChange(this.state());
    }

    setVoice(voice) {
        this.calls.push(['setVoice', voice]);
        this.voice = voice;
        this.onChange(this.state());
    }

    mark(event) {
        this.timeline.push({'ms': this.timeline.length, event});
    }

    play() {
        this.calls.push(['play']);
        if (this.text !== null) {
            this.playing = true;
            this.status = 'playing';
            this.onChange(this.state());
        }
    }

    pause() {
        this.calls.push(['pause']);
        if (this.playing) {
            this.playing = false;
            this.status = 'paused';
            this.onChange(this.state());
        }
    }

    toggle() {
        this.calls.push(['toggle']);
        if (this.playing) {
            this.pause();
        } else {
            this.play();
        }
    }

    skipSentence(direction) {
        this.calls.push(['skipSentence', direction]);
        this.onChange(this.state());
    }

    seekChar(char) {
        this.calls.push(['seekChar', char]);
        this.char = char;
        this.sentenceChar = char;
        this.onChange(this.state());
    }

    state() {
        if (this.text === null) {
            return {'status': 'paused', 'char': 0, 'sentenceChar': 0, 'percent': 0, 'sentence': '', 'remainingSeconds': 0};
        }
        return {
            'status': this.status, 'char': this.char, 'sentenceChar': this.sentenceChar, 'percent': 100 * this.char / this.text.length,
            'sentence': this.sentence, 'remainingSeconds': this.remainingSeconds
        };
    }

    charsPerSecond() {
        return this.rate;
    }

    ensureAudio() {
        this.calls.push(['ensureAudio']);
    }

    textLength() {
        return this.text.length;
    }

    // Set the engine's state and tell the app
    change(values) {
        Object.assign(this, values);
        this.onChange(this.state());
    }
}


// Start the app - a jsdom window of the page (at a URL), with fake services: the engine, the book sources (each book's
// text from load), Wikipedia's shelf, the book cache, and the stored state (saved - the persisted state, or null)
function startApp({
    url = appUrl, saved = null, catalog = testCatalog, catalogResponse = null, cached = {}, load = null,
    todaysArticles = null, searchArticles = null, beforeStart = null
} = {}) {
    const dom = new JSDOM(indexHtml, {url, 'pretendToBeVisual': true});
    const {window} = dom;
    const app = {
        dom, window, 'document': window.document, 'engine': null, 'saved': structuredClone(saved), 'saves': 0,
        'cache': new Map(Object.entries(cached)), 'deleted': [], 'loads': [], 'fetches': [], 'intervals': [], 'timeouts': [],
        'frames': [], 'scrolls': [], 'scrolledIntoView': [], 'todays': 0, 'searches': [], 'nextId': 0
    };

    // The window's fakes - fetch (the catalog), timers, scrolling, and the dialog
    window.fetch = (fetchUrl) => {
        app.fetches.push(String(fetchUrl));
        if (catalogResponse !== null) {
            return catalogResponse;
        }
        return Promise.resolve({'ok': true, 'status': 200, 'json': () => Promise.resolve(structuredClone(catalog))});
    };
    window.setInterval = (callback, ms) => {
        app.intervals.push({callback, ms});
        return app.intervals.length;
    };
    window.setTimeout = (callback, ms) => {
        app.timeouts.push({callback, ms});
        return app.timeouts.length;
    };
    window.clearTimeout = (id) => {
        if (id !== null) {
            app.timeouts[id - 1].cleared = true;
        }
    };
    window.requestAnimationFrame = (callback) => {
        app.frames.push(callback);
    };
    window.scrollTo = (left, top) => {
        app.scrolls.push([left, top]);
    };
    window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) {
        app.scrolledIntoView.push([this, options]);
    };
    window.HTMLDialogElement.prototype.showModal = function showModal() {
        this.open = true;
    };
    window.HTMLDialogElement.prototype.close = function close() {
        this.open = false;
        this.dispatchEvent(new window.Event('close'));
    };
    if (beforeStart !== null) {
        beforeStart(app);
    }

    // The services' fakes
    const sourceLoad = load ?? ((entry, onProgress) => {
        onProgress(500, 1000);
        return Promise.resolve({'text': testText, 'chapters': testChapters, 'title': entry.title, 'author': entry.author});
    });
    main(window, {
        'Engine': class extends FakeEngine {
            constructor(args) {
                super(args);
                app.engine = this;
            }
        },
        'sources': ['standardebooks', 'gutenberg', 'wikipedia'].map((id) => ({
            id,
            'load': (entry, onProgress) => {
                app.loads.push(entry);
                return sourceLoad(entry, onProgress);
            }
        })),
        'todaysArticles': () => {
            app.todays += 1;
            return todaysArticles === null ? Promise.resolve([]) : todaysArticles();
        },
        'searchArticles': (query, offset, count) => {
            app.searches.push([query, offset, count]);
            return searchArticles === null ? Promise.resolve({'books': [], 'next': null}) : searchArticles(query, offset, count);
        },
        'getCachedBook': (key) => Promise.resolve(app.cache.get(key) ?? null),
        'putCachedBook': (record) => {
            app.cache.set(record.key, record);
            return Promise.resolve(null);
        },
        'deleteCachedBook': (key) => {
            app.deleted.push(key);
            app.cache.delete(key);
            return Promise.resolve(null);
        },
        'loadState': () => ({'current': null, 'view': 'library', 'books': {}, 'bookmarks': {}, ...structuredClone(app.saved ?? {})}),
        'saveState': (state) => {
            app.saved = structuredClone(state);
            app.saves += 1;
        },
        'newId': () => {
            app.nextId += 1;
            return `id${app.nextId}`;
        }
    });

    // Helpers
    app.element = (id) => app.document.getElementById(id);
    app.click = (target) => (typeof target === 'string' ? app.element(target) : target).click();
    app.text = (id) => app.element(id).textContent;
    app.rows = () => [...app.element('results').querySelectorAll('.book-row .book-title')].map((title) => title.textContent);
    app.tick = (ms = 250) => {
        for (const interval of app.intervals.filter((item) => item.ms === ms)) {
            interval.callback();
        }
    };
    app.runTimeouts = () => {
        const pending = app.timeouts.filter((timeout) => !timeout.cleared && !timeout.ran);
        for (const timeout of pending) {
            timeout.ran = true;
            timeout.callback();
        }
        return pending.map((timeout) => timeout.ms);
    };
    app.runFrames = () => {
        const frames = app.frames.splice(0);
        for (const frame of frames) {
            frame();
        }
    };
    app.key = (key, target = app.document.body, options = {}) => {
        const event = new window.KeyboardEvent('keydown', {key, 'bubbles': true, 'cancelable': true, ...options});
        target.dispatchEvent(event);
        return event;
    };
    app.tab = (containerId, name) => [...app.element(containerId).children].find((tab) => tab.textContent === name);
    app.sheetButtons = () => [...app.element('sheetBody').querySelectorAll('button')];
    app.sheetLabels = () => [...app.element('sheetBody').querySelectorAll('.sheet-go .label')].map((label) => label.textContent);
    app.search = (query) => {
        const input = app.element('search');
        input.value = query;
        input.dispatchEvent(new window.Event('input'));
    };
    app.close = () => window.close();
    return app;
}


// A saved state with a book open (Pride and Prejudice, at char 350), in a view
function savedWithBook(view = 'player', extra = {}) {
    return {
        'current': prideKey, view, 'books': {
            [prideKey]: {
                'char': 350, 'percent': 35, 'source': 'standardebooks', 'id': '/ebooks/jane-austen/pride-and-prejudice',
                'title': 'Pride and Prejudice', 'author': 'Jane Austen', 'cover': 'https://example.com/pride.jpg',
                'chapter': 'A Part', 'remaining': 1200, 'updated': 2
            }
        },
        'bookmarks': {},
        ...extra
    };
}


// The cached Pride and Prejudice
const cachedPride = {
    [prideKey]: {'key': prideKey, 'text': testText, 'chapters': testChapters, 'title': 'Pride and Prejudice', 'author': 'Jane Austen'}
};


test('main, library at startup', async () => {
    const app = startApp();
    const {document, element} = app;

    // Before the catalog loads
    assert.equal(element('libraryView').hidden, false);
    assert.equal(element('playerView').hidden, true);
    assert.equal(element('miniPlayer').hidden, true);
    assert.equal(app.text('resultsStatus'), 'Loading the catalog...');
    assert.equal(app.text('sourceNote'), '');
    assert.deepEqual(app.fetches, [new URL('../data/catalog.json', new URL('../lib/app.js', import.meta.url)).href]);
    assert.deepEqual(app.saved, {
        'current': null, 'view': 'library', 'books': {}, 'bookmarks': {}, 'scope': 'library', 'libraryView': 'all'
    });
    assert.equal(app.window.location.hash, '');
    assert.deepEqual(app.intervals.map(({ms}) => ms), [250]);
    assert.equal(document.querySelector('.timing-overlay'), null);

    // The catalog loaded
    await settle();
    assert.equal(app.text('sourceNote'), '30 public-domain books from Standard Ebooks and Project Gutenberg.');
    assert.equal(app.text('resultsStatus'), '');
    assert.deepEqual(app.rows().slice(0, 5), [
        'Pride and Prejudice', 'Frankenstein; Or, The Modern Prometheus', 'Frankenstein', 'Alice\'s Adventures in Wonderland',
        'Volume 1'
    ]);
    assert.equal(app.rows().length, 24);
    assert.equal(element('more').hidden, false);
    assert.deepEqual([...element('scopeTabs').children].map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]), [
        ['Library', 'true'], ['Wikipedia', 'false'], ['My Library', 'false']
    ]);
    assert.deepEqual([...element('viewTabs').children].map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]), [
        ['All', 'true'], ['Authors', 'false'], ['Genres', 'false']
    ]);
    assert.equal(element('viewTabs').hidden, false);
    assert.equal(element('search').placeholder, 'Search titles and authors');

    // A row - its cover image, title, and author (no progress - not opened)
    const row = element('results').querySelector('.book-row');
    assert.equal(row.querySelector('img').src, 'https://example.com/pride.jpg');
    assert.equal(row.querySelector('img').referrerPolicy, 'no-referrer');
    assert.equal(row.querySelector('.book-meta').textContent, 'Jane Austen');
    assert.equal(row.querySelector('.mini-progress'), null);
    assert.equal(row.querySelector('.icon-button'), null);

    // A cover image that fails to load - a generated cover
    row.querySelector('img').dispatchEvent(new app.window.Event('error'));
    assert.equal(row.querySelector('img'), null);
    assert.equal(row.querySelector('.generated').textContent, 'Pride and Prejudice');
    assert.equal(row.querySelector('.generated').style.background, 'rgb(120, 58, 54)');

    // More - the next page
    app.click('more');
    assert.equal(app.rows().length, 30);
    assert.equal(element('more').hidden, true);
    app.close();
});


test('main, catalog failure', async () => {
    const app = startApp({'catalogResponse': Promise.resolve({'ok': false, 'status': 404})});
    await settle();
    assert.equal(app.text('resultsStatus'), 'The book catalog couldn\'t be loaded (404).');
    assert.equal(app.element('resultsStatus').classList.contains('error'), true);
    assert.deepEqual(app.rows(), []);

    // My library doesn't need the catalog - no error there
    app.click(app.tab('scopeTabs', 'My Library'));
    assert.equal(app.text('resultsStatus'), '');
    assert.equal(app.element('resultsStatus').classList.contains('error'), false);
    assert.equal(app.text('sourceNote'), 'Books you open appear here.');
    app.close();

    // An empty catalog
    const app2 = startApp({'catalog': {...testCatalog, 'books': []}});
    await settle();
    assert.equal(app2.text('sourceNote'), '0 public-domain books from Standard Ebooks and Project Gutenberg.');
    assert.equal(app2.text('resultsStatus'), 'No books found.');

    // And no Wikipedia articles
    app2.click(app2.tab('scopeTabs', 'Wikipedia'));
    await settle();
    assert.equal(app2.text('resultsStatus'), 'No articles today.');
    app2.search('nothing');
    app2.runTimeouts();
    await settle();
    assert.deepEqual(app2.searches, [['nothing', 0, 24]]);
    assert.equal(app2.text('resultsStatus'), 'No articles match "nothing".');
    app2.close();
});


test('main, library views and search', async () => {
    const app = startApp();
    const {element} = app;
    await settle();
    const groupNames = () => [...element('results').querySelectorAll('details.group')].map((group) => [
        group.querySelector('.group-name').textContent, group.querySelector('.group-count').textContent, group.open
    ]);

    // Search the list - a pause in the typing, then the matches
    app.search('shelley');
    assert.deepEqual(app.runTimeouts(), [150]);
    assert.deepEqual(app.rows(), ['Frankenstein; Or, The Modern Prometheus', 'Frankenstein']);
    assert.equal(app.text('resultsStatus'), '2 books match "shelley".');
    app.search('alice');
    app.search('alic');
    assert.deepEqual(app.runTimeouts(), [150]);
    assert.deepEqual(app.rows(), ['Alice\'s Adventures in Wonderland']);
    assert.equal(app.text('resultsStatus'), '1 book matches "alic".');
    app.search('zzz');
    app.runTimeouts();
    assert.deepEqual(app.rows(), []);
    assert.equal(app.text('resultsStatus'), 'No books match "zzz".');

    // The authors view - a tab change keeps the search
    app.search('');
    app.runTimeouts();
    app.click(app.tab('viewTabs', 'Authors'));
    assert.equal(app.saved.libraryView, 'authors');
    assert.equal(element('more').hidden, true);
    assert.deepEqual(groupNames(), [
        ['Jane Austen', '1', false], ['Lewis Carroll', '1', false], ['Mary Shelley', '1', false],
        ['Mary Wollstonecraft Shelley', '1', false], ['Prolific Writer', '26', false]
    ]);
    assert.equal(element('results').querySelector('.book-list'), null);

    // Open a group - its first page of books, then More
    const [, , , , prolific] = element('results').querySelectorAll('details.group');
    prolific.open = true;
    await settle();
    assert.equal(prolific.querySelectorAll('.book-row').length, 24);
    const groupMore = prolific.querySelector('.group-more');
    assert.equal(groupMore.hidden, false);
    groupMore.click();
    assert.equal(prolific.querySelectorAll('.book-row').length, 26);
    assert.equal(groupMore.hidden, true);

    // Closed and reopened - its books aren't added again
    prolific.open = false;
    await settle();
    prolific.open = true;
    await settle();
    assert.equal(prolific.querySelectorAll('.book-row').length, 26);

    // The open group stays open as the library re-renders (the search form)
    element('searchForm').dispatchEvent(new app.window.Event('submit', {'cancelable': true}));
    await settle();
    assert.deepEqual(groupNames().map(([name, , open]) => [name, open]).slice(3), [
        ['Mary Wollstonecraft Shelley', false], ['Prolific Writer', true]
    ]);

    // A search's few groups open at once
    app.search('shelley');
    app.runTimeouts();
    await settle();
    assert.deepEqual(groupNames(), [['Mary Shelley', '1', true], ['Mary Wollstonecraft Shelley', '1', true]]);
    assert.equal(app.text('resultsStatus'), '2 books match "shelley" (2 authors).');
    app.search('alice');
    app.runTimeouts();
    assert.equal(app.text('resultsStatus'), '1 book matches "alice" (1 author).');

    // The genres view
    app.click(app.tab('viewTabs', 'Genres'));
    assert.equal(app.saved.libraryView, 'genres');
    assert.equal(app.text('resultsStatus'), '1 book matches "alice" (1 genre).');
    app.search('pride');
    app.runTimeouts();
    assert.equal(app.text('resultsStatus'), '1 book matches "pride" (2 genres).');
    app.search('');
    app.runTimeouts();
    assert.deepEqual(groupNames(), [['General Fiction', '28', false], ['Horror & Ghost Stories', '2', false], ['Romance', '1', false]]);

    // The selected tab - nothing
    const {saves} = app;
    app.click(app.tab('viewTabs', 'Genres'));
    assert.equal(app.saves, saves);

    // Back to all
    app.click(app.tab('viewTabs', 'All'));
    assert.equal(app.rows().length, 24);
    app.close();
});


test('main, my library', async () => {
    const saved = {
        'scope': 'mine',
        'books': {
            [prideKey]: {
                'source': 'standardebooks', 'id': '/ebooks/jane-austen/pride-and-prejudice', 'title': 'Pride and Prejudice',
                'author': 'Jane Austen', 'char': 350, 'percent': 35.7, 'updated': 2
            },
            [gutenbergKey]: {
                'source': 'gutenberg', 'id': '84', 'title': 'Frankenstein; Or, The Modern Prometheus',
                'author': 'Mary Wollstonecraft Shelley', 'char': 999, 'percent': 99.6, 'updated': 3
            },
            'wikipedia:Moby-Dick': {
                'source': 'wikipedia', 'id': 'Moby-Dick', 'title': 'Moby-Dick', 'author': 'Wikipedia', 'char': 0, 'percent': 0,
                'updated': 1
            },
            [frankensteinKey]: {
                'source': 'standardebooks', 'id': '/ebooks/mary-shelley/frankenstein', 'title': 'Frankenstein',
                'author': 'Mary Shelley', 'char': 0
            },
            'gutenberg:11': {'source': 'gutenberg', 'id': '11', 'title': 'Alice\'s Adventures in Wonderland', 'author': 'Lewis Carroll'}
        },
        'bookmarks': {[prideKey]: [{'id': 'b1', 'char': 350}]}
    };
    const app = startApp({saved});
    const {element} = app;
    const metas = () => [...element('results').querySelectorAll('.book-meta')].map((meta) => meta.textContent);

    // Before the catalog loads - my library's books, most recent first
    assert.equal(app.tab('scopeTabs', 'My Library').getAttribute('aria-selected'), 'true');
    assert.deepEqual(app.rows(), [
        'Frankenstein; Or, The Modern Prometheus', 'Pride and Prejudice', 'Moby-Dick', 'Frankenstein', 'Alice\'s Adventures in Wonderland'
    ]);
    assert.deepEqual(metas(), [
        'Mary Wollstonecraft Shelley · Finished', 'Jane Austen · 35%', 'Wikipedia · 0%', 'Mary Shelley · 0%', 'Lewis Carroll · 0%'
    ]);
    assert.equal(element('results').querySelector('.mini-progress div').style.width, '99.6%');
    assert.equal(app.text('sourceNote'), 'The books you\'ve opened, most recent first.');
    assert.equal(app.text('resultsStatus'), '');

    // The genres view - with the catalog's genres, and Wikipedia's
    await settle();
    app.click(app.tab('viewTabs', 'Genres'));
    assert.deepEqual([...element('results').querySelectorAll('.group-name')].map((name) => name.textContent), [
        'General Fiction', 'Horror & Ghost Stories', 'Romance', 'Wikipedia'
    ]);

    // The authors view - an author's link to their books in the library (a search); not for Wikipedia's or anonymous books
    app.click(app.tab('viewTabs', 'Authors'));
    const authorGroups = () => [...element('results').querySelectorAll('details.group')];
    for (const group of authorGroups()) {
        group.open = true;
    }
    await settle();
    assert.deepEqual(authorGroups().map((group) => [
        group.querySelector('.group-name').textContent, group.querySelector('.group-link')?.textContent ?? null
    ]), [
        ['Jane Austen', 'More by Jane Austen in the Library'],
        ['Lewis Carroll', 'More by Lewis Carroll in the Library'],
        ['Mary Shelley', 'More by Mary Shelley in the Library'],
        ['Mary Wollstonecraft Shelley', 'More by Mary Wollstonecraft Shelley in the Library'],
        ['Wikipedia', null]
    ]);
    app.click(authorGroups()[0].querySelector('.group-link'));
    assert.equal(app.tab('scopeTabs', 'Library').getAttribute('aria-selected'), 'true');
    assert.equal(app.saved.scope, 'library');
    assert.equal(app.saved.libraryView, 'authors');
    assert.equal(element('search').value, 'Jane Austen');
    assert.deepEqual(app.scrolls.at(-1), [0, 0]);
    assert.deepEqual(authorGroups().map((group) => [group.querySelector('.group-name').textContent, group.open]), [['Jane Austen', true]]);
    assert.equal(element('results').querySelector('.group-link'), null);
    app.click(app.tab('scopeTabs', 'My Library'));
    app.search('');
    app.runTimeouts();
    app.click(app.tab('viewTabs', 'All'));

    // No matches
    app.search('zzz');
    app.runTimeouts();
    assert.equal(app.text('resultsStatus'), 'No books match "zzz".');
    app.search('');
    app.runTimeouts();

    // Remove a book - confirmed in the sheet; canceled
    const removeButton = element('results').querySelectorAll('.book-row')[1].querySelector('.icon-button');
    assert.equal(removeButton.getAttribute('aria-label'), 'Remove Pride and Prejudice from my library');
    removeButton.click();
    assert.equal(element('sheet').open, true);
    assert.equal(app.text('sheetTitle'), 'Remove book');
    assert.equal(element('sheetBody').querySelector('.confirm-message').textContent,
        'Remove "Pride and Prejudice" from my library? Your place and bookmarks in it are removed too.');
    assert.deepEqual(app.sheetButtons().map((button) => button.textContent), ['Cancel', 'Remove']);
    app.click(app.sheetButtons()[0]);
    assert.equal(element('sheet').open, false);
    assert.equal(app.saved.books[prideKey].title, 'Pride and Prejudice');

    // Removed (the sheet already open - asked again)
    removeButton.click();
    removeButton.click();
    app.click(app.sheetButtons()[1]);
    assert.equal(element('sheet').open, false);
    assert.equal(app.saved.books[prideKey], undefined);
    assert.equal(app.saved.bookmarks[prideKey], undefined);
    assert.deepEqual(app.deleted, [prideKey]);
    assert.deepEqual(app.rows(), [
        'Frankenstein; Or, The Modern Prometheus', 'Moby-Dick', 'Frankenstein', 'Alice\'s Adventures in Wonderland'
    ]);

    // A removed book's stale button - nothing
    removeButton.click();
    assert.equal(element('sheet').open, false);

    // Every book removed
    for (const key of Object.keys(app.saved.books)) {
        element('results').querySelector('.book-row .icon-button').click();
        app.click(app.sheetButtons()[1]);
        assert.equal(app.saved.books[key], undefined);
    }
    assert.deepEqual(app.rows(), []);
    assert.equal(app.text('sourceNote'), 'Books you open appear here.');
    assert.equal(app.text('resultsStatus'), '');
    app.close();
});


test('main, Wikipedia shelf', async () => {
    const searches = [];
    const app = startApp({
        'todaysArticles': () => Promise.resolve([
            articleBook({'title': 'Moby-Dick', 'description': 'Novel by Herman Melville', 'cover': 'https://example.com/moby.jpg'}),
            articleBook({'title': 'Herman Melville'})
        ]),
        'searchArticles': () => {
            const search = deferred();
            searches.push(search);
            return search.promise;
        },
        'saved': {'books': {'wikipedia:Herman Melville': {'source': 'wikipedia', 'id': 'Herman Melville', 'char': 0, 'percent': 12}}}
    });
    const {element} = app;
    await settle();

    // Today's articles
    app.click(app.tab('scopeTabs', 'Wikipedia'));
    assert.equal(app.saved.scope, 'wikipedia');
    assert.equal(element('viewTabs').hidden, true);
    assert.equal(element('search').placeholder, 'Search Wikipedia');
    assert.equal(element('search').getAttribute('aria-label'), 'Search Wikipedia');
    assert.equal(app.text('resultsStatus'), 'Loading from Wikipedia...');
    assert.equal(element('more').hidden, true);
    await settle();
    assert.equal(app.todays, 1);
    assert.deepEqual(app.rows(), ['Moby-Dick', 'Herman Melville']);
    assert.deepEqual([...element('results').querySelectorAll('.book-meta')].map((meta) => meta.textContent), [
        'Novel by Herman Melville', 'Wikipedia · 12%'
    ]);
    assert.equal(app.text('resultsStatus'), '');
    assert.equal(app.text('sourceNote'), 'Today on Wikipedia - the featured article and the most read. Search for any article: ' +
        'it\'s read aloud from Wikipedia, the free encyclopedia (CC BY-SA).');
    assert.equal(element('more').hidden, true);

    // Search - after a longer pause in the typing; More for the next page
    app.search('whale');
    assert.deepEqual(app.runTimeouts(), [500]);
    assert.deepEqual(app.searches, [['whale', 0, 24]]);
    assert.deepEqual(app.rows(), []);
    assert.equal(app.text('resultsStatus'), 'Loading from Wikipedia...');
    searches[0].resolve({'books': [articleBook({'title': 'Whale'})], 'next': 24});
    await settle();
    assert.deepEqual(app.rows(), ['Whale']);
    assert.equal(app.text('sourceNote'), 'Articles from Wikipedia, the free encyclopedia (CC BY-SA).');
    assert.equal(element('more').hidden, false);
    app.click('more');
    assert.deepEqual(app.searches[1], ['whale', 24, 24]);
    assert.equal(element('more').hidden, true);
    searches[1].resolve({'books': [articleBook({'title': 'Sperm whale'})], 'next': null});
    await settle();
    assert.deepEqual(app.rows(), ['Whale', 'Sperm whale']);
    assert.equal(element('more').hidden, true);

    // More past the last page (no next offset) - from the start
    app.click('more');
    assert.deepEqual(app.searches[2], ['whale', 0, 24]);
    searches[2].resolve({'books': [], 'next': undefined});
    await settle();
    assert.deepEqual(app.rows(), ['Whale', 'Sperm whale']);
    assert.equal(element('more').hidden, true);

    // A search with no results; a failed search
    element('search').value = 'xyzzy';
    element('searchForm').dispatchEvent(new app.window.Event('submit', {'cancelable': true}));
    searches[3].resolve({'books': [], 'next': null});
    await settle();
    assert.equal(app.text('resultsStatus'), 'No articles match "xyzzy".');
    assert.equal(element('resultsStatus').classList.contains('error'), false);
    element('searchForm').dispatchEvent(new app.window.Event('submit', {'cancelable': true}));
    searches[4].reject(new Error('Couldn\'t reach Wikipedia.'));
    await settle();
    assert.equal(app.text('resultsStatus'), 'Couldn\'t reach Wikipedia.');
    assert.equal(element('resultsStatus').classList.contains('error'), true);
    element('searchForm').dispatchEvent(new app.window.Event('submit', {'cancelable': true}));
    searches[5].reject('offline');
    await settle();
    assert.equal(app.text('resultsStatus'), 'offline');

    // A newer search supersedes one still loading
    app.search('first');
    app.runTimeouts();
    app.search('second');
    app.runTimeouts();
    searches[7].resolve({'books': [articleBook({'title': 'Second'})], 'next': null});
    await settle();
    searches[6].resolve({'books': [articleBook({'title': 'First'})], 'next': null});
    await settle();
    assert.deepEqual(app.rows(), ['Second']);
    app.search('third');
    app.runTimeouts();
    app.search('fourth');
    app.runTimeouts();
    searches[8].reject(new Error('Superseded'));
    searches[9].resolve({'books': [articleBook({'title': 'Fourth'})], 'next': null});
    await settle();
    assert.deepEqual(app.rows(), ['Fourth']);
    assert.equal(app.text('resultsStatus'), '');

    // Today's articles again - fetched once
    app.search('');
    app.runTimeouts();
    await settle();
    assert.deepEqual(app.rows(), ['Moby-Dick', 'Herman Melville']);
    assert.equal(app.todays, 1);

    // Leaving the shelf while a search loads - its results are dropped
    app.search('leaving');
    app.runTimeouts();
    app.click(app.tab('scopeTabs', 'Library'));
    searches[10].resolve({'books': [articleBook({'title': 'Leaving'})], 'next': null});
    await settle();
    assert.equal(app.rows().length, 0);
    assert.equal(app.text('resultsStatus'), 'No books match "leaving".');
    assert.equal(element('viewTabs').hidden, false);
    assert.equal(element('search').placeholder, 'Search titles and authors');
    app.close();
});


test('main, Wikipedia shelf, today\'s articles failure', async () => {
    let todaysCount = 0;
    const app = startApp({
        'saved': {'scope': 'wikipedia'},
        'catalogResponse': new Promise(() => {
            // The catalog is still loading
        }),
        'todaysArticles': () => {
            todaysCount += 1;
            return todaysCount === 1 ? Promise.reject(new Error('Couldn\'t reach Wikipedia.')) : Promise.resolve([]);
        }
    });
    await settle();
    assert.equal(app.text('resultsStatus'), 'Couldn\'t reach Wikipedia.');
    assert.equal(app.element('resultsStatus').classList.contains('error'), true);

    // Tried again
    app.element('searchForm').dispatchEvent(new app.window.Event('submit', {'cancelable': true}));
    await settle();
    assert.equal(app.text('resultsStatus'), 'No articles today.');
    assert.equal(todaysCount, 2);
    app.close();
});


test('main, Wikipedia\'s errors and the catalog\'s', async () => {
    // A Wikipedia error isn't the library's
    const app = startApp({
        'saved': {'scope': 'wikipedia'}, 'todaysArticles': () => Promise.reject(new Error('Couldn\'t reach Wikipedia.'))
    });
    await settle();
    assert.equal(app.text('resultsStatus'), 'Couldn\'t reach Wikipedia.');
    app.click(app.tab('scopeTabs', 'Library'));
    assert.equal(app.text('resultsStatus'), '');
    assert.equal(app.element('resultsStatus').classList.contains('error'), false);
    app.close();

    // The catalog's error stays the library's after a visit to Wikipedia
    const app2 = startApp({'catalogResponse': Promise.resolve({'ok': false, 'status': 404})});
    await settle();
    app2.click(app2.tab('scopeTabs', 'Wikipedia'));
    await settle();
    assert.equal(app2.text('resultsStatus'), 'No articles today.');
    app2.click(app2.tab('scopeTabs', 'Library'));
    assert.equal(app2.text('resultsStatus'), 'The book catalog couldn\'t be loaded (404).');
    assert.equal(app2.element('resultsStatus').classList.contains('error'), true);
    app2.close();
});


test('main, saved state migration', () => {
    const app = startApp({'saved': {
        'settings': {'voice': 'male', 'rate': 1.4},
        'sourceTab': 'gutenberg',
        'scope': 'everything',
        'libraryView': 'shelves',
        'books': {
            'gutenberg:1': {'source': 'gutenberg', 'id': '1', 'char': 10},
            'gutenberg:2': {'source': 'gutenberg', 'id': '2', 'char': 0},
            'gutenberg:3': {'source': 'gutenberg', 'id': '3', 'char': 5, 'voice': 'helen', 'rate': 1}
        }
    }});
    assert.equal(app.saved.settings, undefined);
    assert.equal(app.saved.sourceTab, undefined);
    assert.equal(app.saved.scope, 'library');
    assert.equal(app.saved.libraryView, 'all');
    assert.deepEqual(app.saved.books, {
        'gutenberg:1': {'source': 'gutenberg', 'id': '1', 'char': 10, 'voice': 'neural-male', 'rate': 1.5},
        'gutenberg:2': {'source': 'gutenberg', 'id': '2', 'char': 0},
        'gutenberg:3': {'source': 'gutenberg', 'id': '3', 'char': 5, 'voice': 'helen', 'rate': 1}
    });
    app.close();

    // A designed voice, and no speed
    const app2 = startApp({'saved': {
        'settings': {'voice': 'helen', 'rate': 'fast'}, 'scope': 'mine', 'libraryView': 'genres',
        'books': {'gutenberg:1': {'source': 'gutenberg', 'id': '1', 'char': 10}}
    }});
    assert.deepEqual(app2.saved.books['gutenberg:1'], {'source': 'gutenberg', 'id': '1', 'char': 10, 'voice': 'helen', 'rate': 1});
    assert.equal(app2.saved.scope, 'mine');
    assert.equal(app2.saved.libraryView, 'genres');
    app2.close();

    // A voice no longer offered
    const app3 = startApp({'saved': {
        'settings': {'voice': 'robotic', 'rate': 0.7}, 'books': {'gutenberg:1': {'source': 'gutenberg', 'id': '1', 'char': 10}}
    }});
    assert.deepEqual(app3.saved.books['gutenberg:1'], {'source': 'gutenberg', 'id': '1', 'char': 10, 'voice': 'neural-male', 'rate': 0.8});
    app3.close();
});


test('main, URL parameters', () => {
    const app = startApp({'url': `${appUrl}?slowdown=3&model=ckpt-1`});
    assert.equal(app.engine.slowdown, 3);
    assert.equal(app.engine.voiceModelUrl, new URL('../app-models/ckpt-1.js', new URL('../lib/app.js', import.meta.url)).href);
    app.close();

    const app2 = startApp({'url': `${appUrl}?slowdown=fast&model=Bad.Name`});
    assert.equal(app2.engine.slowdown, 1);
    assert.equal(app2.engine.voiceModelUrl, undefined);
    app2.close();

    const app3 = startApp();
    assert.equal(app3.engine.slowdown, 1);
    assert.equal(app3.engine.voiceModelUrl, undefined);
    app3.close();
});


test('main, timing overlay', () => {
    const beacons = [];
    const app = startApp({
        'url': `${appUrl}?timing&log=https://log.example.com`,
        'beforeStart': ({window}) => {
            window.navigator.sendBeacon = (url, data) => {
                beacons.push([url, JSON.parse(data)]);
                return true;
            };
        }
    });
    const {window, document} = app;
    const overlay = document.querySelector('pre.timing-overlay');
    assert.equal(overlay.parentNode, document.body);
    assert.deepEqual(app.intervals.map(({ms}) => ms), [2000, 250]);

    // Page errors are marked on the timeline
    window.dispatchEvent(new window.ErrorEvent('error', {'message': 'Boom', 'filename': 'app.js', 'lineno': 7}));
    const rejection = new window.Event('unhandledrejection');
    rejection.reason = {'stack': 'Error: Nope\n    at here'};
    window.dispatchEvent(rejection);
    const plainRejection = new window.Event('unhandledrejection');
    plainRejection.reason = 'Plain';
    window.dispatchEvent(plainRejection);
    app.tick(2000);
    const text = '     0 ms  page error: Boom app.js:7\n     1 ms  page rejection: Error: Nope\n    at here\n' +
        '     2 ms  page rejection: Plain';
    assert.equal(overlay.textContent, text);
    assert.deepEqual(beacons, [
        ['https://log.example.com/log', {'userAgent': window.navigator.userAgent, 'href': window.location.href, text}]
    ]);

    // Logged only when changed
    app.tick(2000);
    assert.equal(beacons.length, 1);
    app.engine.mark('play');
    app.tick(2000);
    assert.equal(beacons.length, 2);
    app.close();

    // Without a log
    const app2 = startApp({'url': `${appUrl}?timing`});
    app2.engine.mark('play');
    app2.tick(2000);
    assert.equal(app2.document.querySelector('pre.timing-overlay').textContent, '     0 ms  play');
    app2.close();
});


test('main, resume in the player', async () => {
    const app = startApp({'saved': savedWithBook('player'), 'cached': cachedPride});
    const {element, engine, window} = app;

    // Shown at once, the book loading
    assert.equal(element('playerView').hidden, false);
    assert.equal(element('libraryView').hidden, true);
    assert.equal(element('miniPlayer').hidden, true);
    assert.deepEqual(window.history.state, {'view': 'player'});
    assert.equal(window.history.length, 2);
    assert.equal(window.location.hash, '');
    app.tick();
    assert.equal(window.location.hash, '#book=se.jane-austen.pride-and-prejudice');
    assert.equal(app.text('bookTitle'), 'Pride and Prejudice');
    assert.equal(app.text('bookAuthor'), 'Jane Austen');
    assert.equal(app.document.title, 'Pride and Prejudice - PicoShelf');
    assert.equal(element('playerCover').querySelector('img').src, 'https://example.com/pride.jpg');
    assert.equal(app.text('chapterTitle'), 'A Part');
    assert.equal(app.text('percent'), '35%');
    assert.equal(app.text('remaining'), '20 min left');
    assert.equal(app.text('playerStatus'), 'Downloading the book...');
    assert.equal(element('sectionBack').disabled, true);
    assert.equal(element('sectionForward').disabled, true);
    assert.deepEqual(app.scrolls, [[0, 0]]);

    // Loaded from the cache, at the listener's place - paused
    await settle();
    assert.deepEqual(app.loads, []);
    assert.deepEqual(engine.calls, [['pause'], ['load', 1000, {'voice': 'helen', 'rate': 1, 'expressive': true}, 350]]);
    assert.equal(app.text('playerStatus'), '');
    assert.equal(app.text('sentence'), 'It is a truth universally acknowledged.');
    assert.equal(element('sentence').style.getPropertyValue('--chars'), '39');
    assert.equal(element('progressFill').style.width, '35%');
    assert.equal(element('progressBar').getAttribute('aria-valuenow'), '35');
    assert.equal(element('playPause').getAttribute('aria-label'), 'Play');
    assert.equal(element('playPause').dataset.icon, 'play');
    assert.equal(element('sectionBack').disabled, false);
    assert.equal(element('sectionForward').disabled, false);

    // The address - the listener's section
    app.tick();
    assert.equal(window.location.hash, '#book=se.jane-austen.pride-and-prejudice&section=2');
    assert.equal(window.history.length, 2);
    app.close();
});


test('main, resume in the library', async () => {
    const app = startApp({'saved': savedWithBook('library'), 'cached': cachedPride});
    const {element, engine} = app;
    assert.equal(element('libraryView').hidden, false);
    assert.equal(element('playerView').hidden, true);
    assert.equal(element('miniPlayer').hidden, false);
    const inner = element('miniPlayerInner');
    assert.equal(inner.querySelector('.book-open').getAttribute('aria-label'), 'Open the player for Pride and Prejudice');
    assert.equal(inner.querySelector('.book-title').textContent, 'Pride and Prejudice');
    assert.equal(inner.querySelector('.book-meta').textContent, 'A Part · 35%');
    assert.equal(inner.querySelector('.icon-button').getAttribute('aria-label'), 'Close Pride and Prejudice');
    assert.equal(app.window.location.hash, '');

    // Loaded - the engine's place
    await settle();
    assert.deepEqual(engine.calls.at(-1), ['load', 1000, {'voice': 'helen', 'rate': 1, 'expressive': true}, 350]);
    engine.change({'char': 650, 'sentenceChar': 640});
    assert.equal(inner.querySelector('.book-meta').textContent, 'Chapter II · 65%');
    engine.change({'char': 50, 'sentenceChar': 40});
    assert.equal(inner.querySelector('.book-meta').textContent, '5%');
    assert.equal(app.saved.books[prideKey].chapter, '');

    // Played from the mini player
    app.click(inner.querySelector('.round-play'));
    assert.deepEqual(engine.calls.at(-1), ['play']);
    app.tick();
    assert.equal(inner.querySelector('.round-play').getAttribute('aria-label'), 'Pause');
    assert.equal(inner.querySelector('.round-play').dataset.icon, 'pause');
    engine.change({'status': 'buffering'});
    assert.equal(inner.querySelector('.round-play').dataset.icon, 'busy');
    assert.equal(inner.querySelector('.round-play svg').getAttribute('class'), 'icon spinner');

    // The player
    app.click(inner.querySelector('.book-open'));
    assert.equal(element('playerView').hidden, false);
    assert.equal(element('miniPlayer').hidden, true);
    assert.equal(element('playPause').dataset.icon, 'busy');
    assert.equal(element('playPause').getAttribute('aria-label'), 'Pause');
    app.close();
});


test('main, close the book', async () => {
    const app = startApp({'saved': savedWithBook('library'), 'cached': cachedPride});
    const {element, engine} = app;
    await settle();
    engine.change({'char': 450, 'sentenceChar': 440});
    const close = element('miniPlayerInner').querySelector('.icon-button');
    app.click(close);
    assert.deepEqual(engine.calls.at(-1), ['unload']);
    assert.equal(element('miniPlayer').hidden, true);
    assert.equal(app.saved.current, null);
    assert.equal(app.saved.books[prideKey].char, 440);

    // Closed - the stale button does nothing
    const calls = engine.calls.length;
    app.click(close);
    assert.equal(engine.calls.length, calls);

    // No book open - the player's buttons do nothing
    app.click('skipBack');
    app.click('sectionForward');
    app.click('playPause');
    assert.equal(engine.calls.length, calls);
    app.close();
});


test('main, links at startup', async () => {
    // A section
    let app = startApp({'url': `${appUrl}?debug=1#x&book=pg84&section=2`});
    assert.equal(app.window.location.hash, '');
    await settle();
    assert.equal(app.element('playerView').hidden, false);
    app.tick();
    assert.equal(app.window.location.href, `${appUrl}?debug=1#book=pg84&section=2`);
    assert.deepEqual(app.loads.map(({id}) => id), ['84']);
    assert.deepEqual(app.engine.calls.at(-1), ['load', 1000, {'voice': 'neural-male', 'rate': 1, 'expressive': true}, 300]);
    assert.equal(app.text('bookTitle'), 'Frankenstein; Or, The Modern Prometheus');
    assert.equal(app.text('bookAuthor'), 'Mary Wollstonecraft Shelley');
    assert.equal(app.saved.books[gutenbergKey].title, 'Frankenstein; Or, The Modern Prometheus');
    assert.equal(app.cache.get(gutenbergKey).title, 'Frankenstein; Or, The Modern Prometheus');
    app.close();

    // A place
    app = startApp({'url': `${appUrl}#book=pg84&char=650&section=1`});
    await settle();
    assert.deepEqual(app.engine.calls.at(-1), ['load', 1000, {'voice': 'neural-male', 'rate': 1, 'expressive': true}, 650]);
    app.close();

    // A place past the end of the text; an invalid section
    app = startApp({'url': `${appUrl}#book=pg84&char=5000&section=0`});
    await settle();
    assert.deepEqual(app.engine.calls.at(-1), ['load', 1000, {'voice': 'neural-male', 'rate': 1, 'expressive': true}, 0]);
    app.close();

    // A saved book - its section, if the listener's place isn't in it
    app = startApp({
        'url': `${appUrl}#book=se.jane-austen.pride-and-prejudice&section=1`, 'saved': savedWithBook('library'), 'cached': cachedPride
    });
    await settle();
    assert.deepEqual(app.engine.calls.at(-1), ['load', 1000, {'voice': 'helen', 'rate': 1, 'expressive': true}, 100]);
    app.close();
    app = startApp({
        'url': `${appUrl}#book=se.jane-austen.pride-and-prejudice&section=2`, 'saved': savedWithBook('library'), 'cached': cachedPride
    });
    await settle();
    assert.deepEqual(app.engine.calls.at(-1), ['load', 1000, {'voice': 'helen', 'rate': 1, 'expressive': true}, 350]);
    app.close();
    app = startApp({
        'url': `${appUrl}#book=se.jane-austen.pride-and-prejudice&section=9`, 'saved': savedWithBook('library'), 'cached': cachedPride
    });
    await settle();
    assert.deepEqual(app.engine.calls.at(-1), ['load', 1000, {'voice': 'helen', 'rate': 1, 'expressive': true}, 350]);
    app.close();

    // A Wikipedia article
    app = startApp({'url': `${appUrl}#book=wp.Moby-Dick`});
    await settle();
    assert.deepEqual(app.loads, [articleBook({'title': 'Moby-Dick'})]);
    assert.deepEqual(app.engine.calls.at(-1), ['load', 1000, {'voice': 'michael', 'rate': 1, 'expressive': true}, 0]);
    assert.equal(app.text('bookTitle'), 'Moby-Dick');
    assert.equal(app.text('bookAuthor'), 'From Wikipedia, the free encyclopedia (CC BY-SA)');
    app.tick();
    assert.equal(app.window.location.hash, '#book=wp.Moby-Dick');
    app.close();

    // A book not in the catalog - the library
    app = startApp({'url': `${appUrl}#book=pg999`});
    await settle();
    assert.equal(app.element('libraryView').hidden, false);
    assert.equal(app.element('playerView').hidden, true);
    assert.equal(app.window.location.hash, '');
    assert.deepEqual(app.saved.books, {});
    app.close();

    // The catalog failed - the library
    app = startApp({'url': `${appUrl}#book=pg84`, 'catalogResponse': Promise.reject(new Error('Offline.'))});
    await settle();
    assert.equal(app.element('libraryView').hidden, false);
    assert.equal(app.text('resultsStatus'), 'Offline.');
    app.close();

    // Not a link (a malformed escape; an unknown id)
    for (const hash of ['#book=pg84%E0%A4%A', '#book=se.nothing', '#book', '#=pg84']) {
        app = startApp({'url': `${appUrl}${hash}`, 'saved': savedWithBook('library'), 'cached': cachedPride});
        assert.equal(app.element('libraryView').hidden, false, hash);
        assert.equal(app.element('miniPlayer').hidden, false, hash);
        assert.equal(app.window.location.hash, '');
        app.close();
    }
});


// Start the app with Pride and Prejudice loaded in the player
async function startPlayer(options = {}) {
    const app = startApp({'saved': savedWithBook('player'), 'cached': cachedPride, ...options});
    await settle();
    return app;
}


test('main, open a book from the library', async () => {
    const loads = [];
    const app = startApp({'load': (entry, onProgress) => {
        const loading = deferred();
        loads.push({entry, onProgress, loading});
        return loading.promise;
    }});
    const {element, engine, window} = app;
    await settle();
    Object.defineProperty(window, 'scrollY', {'value': 420, 'configurable': true});

    // Opened - the player, downloading the book
    element('results').querySelector('.book-open').click();
    assert.equal(element('playerView').hidden, false);
    assert.equal(element('libraryView').hidden, true);
    assert.deepEqual(window.history.state, {'view': 'player'});
    assert.deepEqual(app.scrolls, [[0, 0], [0, 0]]);
    await settle();
    assert.equal(loads.length, 1);
    assert.equal(loads[0].entry.title, 'Pride and Prejudice');
    assert.equal(app.text('playerStatus'), 'Downloading the book...');
    assert.equal(app.text('percent'), '0%');
    assert.equal(app.text('remaining'), '');
    assert.equal(app.text('chapterTitle'), '');
    assert.equal(app.saved.current, prideKey);
    assert.deepEqual(app.saved.books[prideKey], {
        'char': 0, 'percent': 0, 'source': 'standardebooks', 'id': '/ebooks/jane-austen/pride-and-prejudice',
        'title': 'Pride and Prejudice', 'author': 'Jane Austen', 'cover': 'https://example.com/pride.jpg',
        'updated': app.saved.books[prideKey].updated
    });

    // The download's progress
    loads[0].onProgress(500, 1000);
    assert.equal(app.text('playerStatus'), 'Downloading the book... 50%');
    loads[0].onProgress(600, null);
    assert.equal(app.text('playerStatus'), 'Downloading the book...');

    // Sheets wait for the book
    app.click('contentsButton');
    assert.equal(element('sheet').open, false);

    // Play while downloading - and changing one's mind, and again
    app.click('playPause');
    assert.equal(element('playPause').dataset.icon, 'busy');
    assert.equal(element('playPause').getAttribute('aria-label'), 'Pause');
    assert.deepEqual(engine.calls.at(-1), ['ensureAudio']);
    app.click('playPause');
    assert.equal(element('playPause').dataset.icon, 'play');
    app.click('playPause');
    app.tick();
    assert.equal(window.location.hash, '#book=se.jane-austen.pride-and-prejudice');

    // Loaded - played
    loads[0].loading.resolve({'text': testText, 'chapters': testChapters, 'title': 'Pride and Prejudice', 'author': 'Jane Austen'});
    await settle();
    assert.deepEqual(engine.calls.slice(-2), [['load', 1000, {'voice': 'helen', 'rate': 1, 'expressive': true}, 0], ['play']]);
    app.tick();
    assert.equal(element('playPause').dataset.icon, 'pause');
    assert.deepEqual(app.cache.get(prideKey), {
        'key': prideKey, 'text': testText, 'chapters': testChapters, 'title': 'Pride and Prejudice', 'author': 'Jane Austen'
    });

    // Back to the library - the history entry, and the library's scroll
    app.click('toLibrary');
    await settle();
    assert.equal(element('libraryView').hidden, false);
    assert.equal(element('playerView').hidden, true);
    assert.equal(element('miniPlayer').hidden, false);
    assert.deepEqual(app.scrolls.at(-1), [0, 420]);
    assert.equal(window.location.hash, '');
    assert.equal(app.saved.view, 'library');

    // A popstate in the library - nothing
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    assert.equal(element('libraryView').hidden, false);

    // The book's row - its progress
    engine.change({'char': 120, 'sentenceChar': 120});
    app.click(app.tab('scopeTabs', 'Library'));
    app.click(app.tab('scopeTabs', 'My Library'));
    assert.equal(element('results').querySelector('.book-meta').textContent, 'Jane Austen · 12%');

    // Opened again (already open) - the player
    element('results').querySelector('.book-open').click();
    assert.equal(element('playerView').hidden, false);
    assert.equal(loads.length, 1);
    app.close();
});


test('main, player status', async () => {
    const app = await startPlayer();
    const {element, engine} = app;
    const status = () => [app.text('playerStatus'), element('playerStatus').classList.contains('error'), element('playPause').dataset.icon];
    engine.change({'status': 'buffering'});
    assert.deepEqual(status(), ['', false, 'busy']);
    engine.change({'status': 'playing'});
    assert.deepEqual(status(), ['', false, 'pause']);
    engine.change({'status': 'loading'});
    assert.deepEqual(status(), ['Loading the voice...', false, 'play']);
    engine.change({'status': 'paused'});
    assert.deepEqual(status(), ['', false, 'play']);
    engine.change({'error': 'The speech synthesizer failed.'});
    assert.deepEqual(status(), ['The speech synthesizer failed.', true, 'play']);
    engine.change({'error': undefined, 'status': 'ended', 'char': 990, 'sentenceChar': 980});
    assert.deepEqual(status(), ['The end. Press play to listen again.', false, 'play']);
    assert.equal(app.saved.books[prideKey].percent, 100);
    assert.equal(app.saved.books[prideKey].remaining, 0);

    // The time left
    const remaining = (seconds) => {
        engine.change({'status': 'paused', 'remainingSeconds': seconds});
        return app.text('remaining');
    };
    assert.equal(remaining(0), '');
    assert.equal(remaining(20), 'Less than a minute left');
    assert.equal(remaining(600), '10 min left');
    assert.equal(remaining(4000), '1 h 7 min left');
    assert.equal(app.saved.books[prideKey].remaining, 4000);

    // No sentence
    engine.change({'sentence': ''});
    assert.equal(element('sentence').style.getPropertyValue('--chars'), '1');
    app.close();
});


test('main, skip sentences and sections', async () => {
    const app = await startPlayer();
    const {element, engine} = app;
    const seeks = () => engine.calls.filter(([name]) => name === 'seekChar' || name === 'skipSentence');

    // Sentences
    app.click('skipBack');
    app.click('skipForward');
    assert.deepEqual(seeks(), [['skipSentence', -1], ['skipSentence', 1]]);

    // Sections - forward, the next; back, the section's start (or from near its start, the previous)
    app.click('sectionForward');
    assert.deepEqual(seeks().at(-1), ['seekChar', 600]);
    assert.equal(app.saved.books[prideKey].char, 600);
    assert.equal(element('sectionForward').disabled, true);
    app.click('sectionBack');
    assert.deepEqual(seeks().at(-1), ['seekChar', 300]);
    engine.change({'char': 450, 'sentenceChar': 450});
    app.click('sectionBack');
    assert.deepEqual(seeks().at(-1), ['seekChar', 300]);
    engine.change({'char': 50, 'sentenceChar': 50});
    assert.equal(element('sectionBack').disabled, true);
    assert.equal(element('sectionForward').disabled, false);
    app.click('sectionForward');
    assert.deepEqual(seeks().at(-1), ['seekChar', 100]);
    app.click('sectionBack');
    assert.equal(element('sectionBack').disabled, true);
    assert.deepEqual(seeks().at(-1), ['seekChar', 100]);
    app.close();
});


test('main, keyboard', async () => {
    const app = await startPlayer();
    const {document, element, engine} = app;
    const callCount = () => engine.calls.length;

    // Space plays or pauses; the arrows skip sentences
    const space = app.key(' ');
    assert.equal(space.defaultPrevented, true);
    assert.deepEqual(engine.calls.slice(-2), [['toggle'], ['play']]);
    app.key('ArrowLeft');
    app.key('ArrowRight');
    assert.deepEqual(engine.calls.slice(-2), [['skipSentence', -1], ['skipSentence', 1]]);

    // Ignored - other keys, modifiers, and keys for inputs, tabs, and buttons
    const count = callCount();
    app.key('a');
    app.key(' ', document.body, {'metaKey': true});
    app.key('ArrowLeft', document.body, {'ctrlKey': true});
    app.key('ArrowRight', document.body, {'altKey': true});
    app.key(' ', element('search'));
    app.key(' ', element('playPause'));
    app.key('ArrowLeft', element('scopeTabs').firstChild);
    assert.equal(callCount(), count);

    // Ignored with a sheet open
    app.click('contentsButton');
    app.key(' ');
    assert.equal(callCount(), count);
    app.click('sheetClose');

    // In the library - space plays, the arrows don't skip
    app.click('toLibrary');
    await settle();
    app.key('ArrowLeft');
    app.key('ArrowRight');
    assert.equal(callCount(), count);
    app.key(' ');
    assert.deepEqual(engine.calls.slice(-2), [['toggle'], ['pause']]);

    // No book open
    app.click(element('miniPlayerInner').querySelector('.icon-button'));
    const closedCount = callCount();
    app.key(' ');
    assert.equal(callCount(), closedCount);
    app.close();
});


test('main, download failure and retry', async () => {
    const results = [() => Promise.reject(new Error('Couldn\'t download the book.')), () => Promise.reject(new Error(''))];
    const app = startApp({'load': (entry) => (results.shift() ?? (() => Promise.resolve({'text': testText, 'title': entry.title})))()});
    const {element, engine} = app;
    await settle();
    element('results').querySelector('.book-open').click();
    await settle();
    assert.equal(app.text('playerStatus'), 'Couldn\'t download the book. Press play to try again.');
    assert.equal(element('playerStatus').classList.contains('error'), true);

    // Sheets wait for the book
    app.click('bookmarksButton');
    assert.equal(element('sheet').open, false);

    // Tried again - in the player
    app.click('playPause');
    assert.equal(element('playerView').hidden, false);
    await settle();
    assert.equal(app.text('playerStatus'), 'Error Press play to try again.');

    // A link to the failed book (from the library) - tried again; loaded (no chapters)
    app.click('toLibrary');
    await settle();
    app.window.location.hash = '#book=se.jane-austen.pride-and-prejudice';
    await settle();
    assert.equal(app.loads.length, 3);
    assert.equal(app.text('playerStatus'), '');
    assert.deepEqual(engine.calls.at(-1), ['load', 1000, {'voice': 'helen', 'rate': 1, 'expressive': true}, 0]);
    app.click('contentsButton');
    assert.equal(app.text('sheetTitle'), 'Contents');
    assert.equal(element('sheetBody').textContent, 'This book has no chapter headings.');
    app.close();
});


test('main, download failure and retry from the mini player', async () => {
    const results = [() => Promise.reject(new Error('Couldn\'t download the book.'))];
    const app = startApp({
        'saved': savedWithBook('library'),
        'load': (entry) => {
            const result = results.shift() ?? (() => Promise.resolve({'text': testText, 'chapters': testChapters, 'title': entry.title}));
            return result();
        }
    });
    const {element, engine} = app;
    await settle();
    assert.equal(element('miniPlayer').hidden, false);
    app.click(element('miniPlayerInner').querySelector('.round-play'));
    assert.equal(element('playerView').hidden, true);
    await settle();
    assert.deepEqual(engine.calls.slice(-2), [['load', 1000, {'voice': 'helen', 'rate': 1, 'expressive': true}, 350], ['play']]);
    app.close();
});


test('main, a book no longer in the catalog', async () => {
    const saved = {
        'current': 'gutenberg:999', 'view': 'player',
        'books': {'gutenberg:999': {'source': 'gutenberg', 'id': '999', 'title': 'Gone', 'author': 'Nobody', 'char': 0, 'percent': 0}}
    };
    const app = startApp({saved});
    await settle();
    assert.equal(app.text('playerStatus'), 'This book is no longer in the catalog. Press play to try again.');
    app.close();

    // A source no longer offered
    const app2 = startApp({'saved': {
        'current': 'oldsource:1', 'view': 'player',
        'books': {'oldsource:1': {'source': 'oldsource', 'id': '1', 'title': 'Old', 'author': 'Someone', 'char': 0, 'percent': 0}}
    }});
    await settle();
    assert.equal(app2.text('playerStatus'), 'This book is no longer in the catalog. Press play to try again.');
    app2.close();
});


test('main, a saved book without a title', async () => {
    const saved = {
        'current': gutenbergKey, 'view': 'player',
        'books': {[gutenbergKey]: {'source': 'gutenberg', 'id': '84', 'title': '', 'author': '', 'char': 0}}
    };
    const app = startApp({
        saved, 'catalogResponse': Promise.resolve({'ok': false, 'status': 500}),
        'cached': {[gutenbergKey]: {'key': gutenbergKey, 'text': testText, 'chapters': [], 'title': 'Cached Title'}}
    });

    // The generated cover of a book without a title
    assert.equal(app.element('playerCover').querySelector('.generated').textContent, '');
    assert.equal(app.element('playerCover').querySelector('.generated').style.background, 'rgb(116, 120, 54)');
    await settle();
    assert.deepEqual(app.saved.books[gutenbergKey], {
        'source': 'gutenberg', 'id': '84', 'title': 'Cached Title', 'author': '', 'char': 0, 'percent': 0, 'cover': null,
        'updated': app.saved.books[gutenbergKey].updated, 'remaining': 0, 'chapter': ''
    });
    assert.deepEqual(app.engine.calls.at(-1), ['load', 1000, {'voice': 'neural-male', 'rate': 1, 'expressive': true}, 0]);
    app.close();

    // Nor in the downloaded copy
    const app2 = startApp({saved, 'cached': {[gutenbergKey]: {'key': gutenbergKey, 'text': testText, 'chapters': []}}});
    await settle();
    assert.equal(app2.saved.books[gutenbergKey].title, '');
    assert.equal(app2.text('bookTitle'), '');
    app2.close();
});


test('main, open another book while one loads', async () => {
    const loads = [];
    const app = startApp({'load': (entry) => {
        const loading = deferred();
        loads.push({entry, loading});
        return loading.promise;
    }});
    const {element, engine, window} = app;
    await settle();

    // A link (followed in the player too - its popstate, before its hashchange, keeps the player)
    const link = async (hash) => {
        window.location.hash = hash;
        await settle();
        assert.equal(element('playerView').hidden, false);
    };

    // Pride and Prejudice, then Frankenstein - Pride and Prejudice's download is dropped
    element('results').querySelectorAll('.book-open')[0].click();
    await settle();
    await link('#book=se.mary-shelley.frankenstein');
    assert.equal(element('playerView').hidden, false);
    assert.equal(app.saved.current, frankensteinKey);
    assert.equal(app.text('bookTitle'), 'Frankenstein');
    assert.equal(element('playerCover').querySelector('.generated').textContent, 'Frankenstein');
    loads[0].loading.resolve({'text': testText, 'chapters': testChapters});
    await settle();
    assert.equal(engine.calls.some(([name]) => name === 'load'), false);
    assert.equal(app.text('playerStatus'), 'Downloading the book...');

    // Frankenstein's link's section while it loads
    await link('#book=se.mary-shelley.frankenstein&section=3');
    loads[1].loading.resolve({'text': testText, 'chapters': testChapters});
    await settle();
    assert.deepEqual(engine.calls.at(-1), ['load', 1000, {'voice': 'robert', 'rate': 1, 'expressive': true}, 600]);

    // Project Gutenberg's Frankenstein, then Pride and Prejudice (downloaded) - Frankenstein's failure is dropped
    await link('#book=pg84');
    await link('#book=se.jane-austen.pride-and-prejudice');
    assert.deepEqual(engine.calls.at(-1), ['load', 1000, {'voice': 'helen', 'rate': 1, 'expressive': true}, 0]);
    loads[2].loading.reject(new Error('Failed'));
    await settle();
    assert.equal(app.text('playerStatus'), '');

    // Its links while open - a section (the listener's place, if in it), a place
    engine.change({'char': 350, 'sentenceChar': 350});
    await link('#book=se.jane-austen.pride-and-prejudice&section=1');
    assert.deepEqual(engine.calls.at(-1), ['seekChar', 100]);
    await link('#book=se.jane-austen.pride-and-prejudice&section=1&char=150');
    assert.deepEqual(engine.calls.at(-1), ['seekChar', 150]);
    const count = engine.calls.length;
    await link('#book=se.jane-austen.pride-and-prejudice&section=1');
    assert.equal(engine.calls.length, count);
    assert.equal(element('playerView').hidden, false);

    // A link to nothing - the library
    window.location.hash = '#nothing';
    await settle();
    assert.equal(element('playerView').hidden, true);
    assert.equal(app.saved.current, prideKey);
    assert.equal(loads.length, 3);
    app.close();
});


test('main, the previous book while another downloads, or after its download failed', async () => {
    const mediaSession = {'handlers': {}, 'setActionHandler': (action, handler) => {
        mediaSession.handlers[action] = handler;
    }};
    const loading = deferred();
    const app = await startPlayer({'load': () => loading.promise, 'beforeStart': ({window}) => {
        Object.defineProperty(window.navigator, 'mediaSession', {'configurable': true, 'value': mediaSession});
    }});
    const {element, engine, window} = app;
    engine.change({});
    const {handlers} = mediaSession;

    // Pride and Prejudice is still in the engine while Frankenstein downloads - the lock screen's controls don't move it
    window.location.hash = '#book=pg84';
    await settle();
    const count = engine.calls.length;
    handlers.play();
    handlers.seekforward();
    handlers.seekto({'seekTime': 10});
    app.key('ArrowRight');
    assert.deepEqual(engine.calls.slice(count), []);

    // Nor after Frankenstein's download failed
    loading.reject(new Error('Couldn\'t download the book.'));
    await settle();
    assert.equal(app.text('playerStatus'), 'Couldn\'t download the book. Press play to try again.');
    handlers.play();
    handlers.seekbackward();
    app.key('ArrowLeft');
    assert.deepEqual(engine.calls.slice(count), []);

    // The mini player - Frankenstein's place, not Pride and Prejudice's
    app.click('toLibrary');
    await settle();
    assert.equal(element('miniPlayerInner').querySelector('.book-title').textContent, 'Frankenstein; Or, The Modern Prometheus');
    assert.equal(element('miniPlayerInner').querySelector('.book-meta').textContent, '0%');
    assert.equal(element('miniPlayerInner').querySelector('.round-play').dataset.icon, 'play');
    app.close();
});


test('main, the player\'s cover image fails to load', async () => {
    const app = await startPlayer();
    const {element, window} = app;
    const image = element('playerCover').querySelector('img');
    assert.equal(image.src, 'https://example.com/pride.jpg');

    // A generated cover
    image.dispatchEvent(new window.Event('error'));
    assert.equal(element('playerCover').querySelector('img'), null);
    assert.equal(element('playerCover').querySelector('.generated').textContent, 'Pride and Prejudice');

    app.close();

    // A cover failing after the book changed - the new book's cover stays
    const app2 = await startPlayer();
    const prideImage = app2.element('playerCover').querySelector('img');
    app2.window.location.hash = '#book=pg84';
    await settle();
    prideImage.dispatchEvent(new app2.window.Event('error'));
    assert.equal(app2.element('playerCover').querySelector('.generated').textContent, 'Frankenstein; Or, The Modern Prometheus');
    app2.close();
});


test('main, back to the library without the player\'s history entry', async () => {
    const app = await startPlayer();
    app.window.history.replaceState(null, '');
    app.click('toLibrary');
    assert.equal(app.element('libraryView').hidden, false);
    assert.equal(app.element('playerView').hidden, true);
    app.close();
});


test('main, the place is saved', async (context) => {
    context.mock.timers.enable({'apis': ['Date'], 'now': 1000000});
    const app = await startPlayer();
    const {document, engine, window} = app;

    // Playing - saved every few seconds
    engine.change({'status': 'playing', 'char': 400, 'sentenceChar': 400});
    assert.equal(app.saved.books[prideKey].char, 350);
    context.mock.timers.tick(3001);
    engine.change({'char': 410, 'sentenceChar': 410});
    assert.equal(app.saved.books[prideKey].char, 410);
    assert.equal(app.saved.books[prideKey].updated, 1003001);
    engine.change({'char': 420, 'sentenceChar': 420});
    app.tick();
    assert.equal(app.saved.books[prideKey].char, 410);
    context.mock.timers.tick(3001);
    app.tick();
    assert.equal(app.saved.books[prideKey].char, 420);

    // Paused - saved at once
    engine.change({'status': 'paused', 'char': 430, 'sentenceChar': 430});
    assert.equal(app.saved.books[prideKey].char, 430);
    engine.char = 440;
    engine.sentenceChar = 440;
    app.tick();
    assert.equal(app.saved.books[prideKey].char, 430);

    // Hidden or closed - saved
    engine.change({'status': 'playing', 'char': 450, 'sentenceChar': 450});
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(app.saved.books[prideKey].char, 450);
    engine.change({'status': 'playing', 'char': 460, 'sentenceChar': 460});
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(app.saved.books[prideKey].char, 450);
    Object.defineProperty(document, 'visibilityState', {'value': 'hidden', 'configurable': true});
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(app.saved.books[prideKey].char, 460);
    app.close();
});


test('main, contents sheet', async () => {
    const app = await startPlayer();
    const {element, engine} = app;
    app.click('contentsButton');
    assert.equal(element('sheet').open, true);
    assert.equal(app.text('sheetTitle'), 'Contents');
    assert.deepEqual(app.sheetLabels(), ['Chapter I', 'A Part', 'Chapter II']);
    const buttons = app.sheetButtons();
    assert.deepEqual(buttons.map((button) => button.style.paddingLeft), ['10px', '26px', '10px']);
    assert.deepEqual(buttons.map((button) => button.getAttribute('aria-current')), [null, 'true', null]);

    // The current chapter is scrolled into view
    app.runFrames();
    assert.deepEqual(app.scrolledIntoView, [[buttons[1], {'block': 'center'}]]);

    // Go to a chapter
    buttons[2].click();
    assert.deepEqual(engine.calls.at(-1), ['seekChar', 600]);
    assert.equal(app.saved.books[prideKey].char, 600);
    assert.equal(element('sheet').open, false);

    // Before the first chapter - none current
    engine.change({'char': 50, 'sentenceChar': 50});
    app.click('contentsButton');
    assert.deepEqual(app.sheetButtons().map((button) => button.getAttribute('aria-current')), [null, null, null]);
    assert.equal(app.frames.length, 0);

    // Closed - the close button, the backdrop (not the sheet's content), and the sheet's own close (Escape)
    app.click('sheetBody');
    assert.equal(element('sheet').open, true);
    app.click('sheet');
    assert.equal(element('sheet').open, false);
    app.click('contentsButton');
    app.click('sheetClose');
    assert.equal(element('sheet').open, false);
    app.click('contentsButton');
    element('sheet').close();
    assert.equal(element('sheet').open, false);
    app.close();
});


test('main, bookmarks sheet', async (context) => {
    context.mock.timers.enable({'apis': ['Date'], 'now': new Date(2026, 9, 22, 12).getTime()});
    const app = await startPlayer();
    const {element, engine, window} = app;
    app.click('bookmarksButton');
    assert.equal(app.text('sheetTitle'), 'Bookmarks');
    assert.equal(element('sheetBody').querySelector('.add-bookmark').textContent, 'Bookmark this spot');
    assert.equal(element('sheetBody').querySelector('.sheet-empty').textContent,
        'No bookmarks yet. Bookmarks keep a spot to come back to - name them to remember why.');

    // Add a bookmark - named for its chapter, then renamed
    app.click(element('sheetBody').querySelector('.add-bookmark'));
    assert.deepEqual(app.saved.bookmarks[prideKey], [{
        'id': 'id1', 'char': 350, 'percent': 35, 'snippet': 'It is a truth universally acknowledged.', 'label': 'A Part',
        'created': new Date(2026, 9, 22, 12).getTime()
    }]);
    let input = element('sheetBody').querySelector('input');
    assert.equal(input.value, 'A Part');
    assert.equal(input.getAttribute('aria-label'), 'Bookmark name');
    app.runFrames();
    assert.equal(app.document.activeElement, input);
    input.value = '  My spot  ';
    app.key('a', input);
    assert.equal(element('sheetBody').querySelector('input'), input);
    const enter = app.key('Enter', input);
    assert.equal(enter.defaultPrevented, true);
    assert.equal(app.saved.bookmarks[prideKey][0].label, 'My spot');
    assert.equal(element('sheetBody').querySelector('input'), null);
    input.dispatchEvent(new window.FocusEvent('blur'));
    assert.deepEqual(app.sheetLabels(), ['My spot']);
    assert.equal(element('sheetBody').querySelector('.detail').textContent, `35% · ${new Date(2026, 9, 22).toLocaleDateString(undefined,
        {'month': 'short', 'day': 'numeric'})} · It is a truth universally acknowledged.`);

    // The same spot again - nothing
    app.click(element('sheetBody').querySelector('.add-bookmark'));
    assert.equal(app.saved.bookmarks[prideKey].length, 1);
    assert.equal(element('sheetBody').querySelector('input'), null);

    // A spot before the first chapter - named for its sentence; Escape keeps the name
    engine.change({'char': 50, 'sentenceChar': 50, 'sentence': 'y'.repeat(150)});
    app.click(element('sheetBody').querySelector('.add-bookmark'));
    input = element('sheetBody').querySelector('input');
    input.value = 'Not saved';
    const escape = app.key('Escape', input);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(element('sheet').open, true);
    assert.deepEqual(app.sheetLabels(), [`${'y'.repeat(97)}...`, 'My spot']);

    // Rename - a blur saves; an empty name is not saved
    const renameButton = () => element('sheetBody').querySelectorAll('.sheet-item')[1].querySelectorAll('.icon-button')[0];
    assert.equal(renameButton().getAttribute('aria-label'), 'Rename the bookmark "My spot"');
    app.click(renameButton());
    input = element('sheetBody').querySelector('input');
    input.value = 'Renamed';
    input.dispatchEvent(new window.FocusEvent('blur'));
    assert.deepEqual(app.sheetLabels(), [`${'y'.repeat(97)}...`, 'Renamed']);
    app.click(renameButton());
    input = element('sheetBody').querySelector('input');
    input.value = ' ';
    app.key('Enter', input);
    assert.deepEqual(app.sheetLabels(), [`${'y'.repeat(97)}...`, 'Renamed']);

    // Go to a bookmark
    app.click(element('sheetBody').querySelectorAll('.sheet-go')[1]);
    assert.deepEqual(engine.calls.at(-1), ['seekChar', 350]);
    assert.equal(element('sheet').open, false);

    // Delete a bookmark - canceled, then confirmed
    app.click('bookmarksButton');
    const deleteButton = () => element('sheetBody').querySelectorAll('.sheet-item')[0].querySelectorAll('.icon-button')[1];
    assert.equal(deleteButton().getAttribute('aria-label'), `Delete the bookmark "${'y'.repeat(97)}..."`);
    app.click(deleteButton());
    assert.equal(app.text('sheetTitle'), 'Bookmarks');
    assert.equal(element('sheetBody').querySelector('.confirm-message').textContent, `Delete the bookmark "${'y'.repeat(97)}..."?`);
    app.click(app.sheetButtons()[0]);
    assert.deepEqual(app.sheetLabels(), [`${'y'.repeat(97)}...`, 'Renamed']);
    app.click(deleteButton());
    app.click(app.sheetButtons()[1]);
    assert.deepEqual(app.sheetLabels(), ['Renamed']);
    assert.deepEqual(app.saved.bookmarks[prideKey].map(({label}) => label), ['Renamed']);

    // Another sheet while one is open
    app.click('contentsButton');
    assert.equal(app.text('sheetTitle'), 'Contents');
    assert.equal(element('sheet').open, true);
    app.close();
});


test('main, the service worker', async () => {
    // Registered (sw.js, beside the page)
    const registered = [];
    const register = (rejects) => (app) => {
        Object.defineProperty(app.window.navigator, 'serviceWorker', {'configurable': true, 'value': {'register': (url) => {
            registered.push(url);
            return rejects ? Promise.reject(new Error('SecurityError')) : Promise.resolve({});
        }}});
    };
    let app = startApp({'beforeStart': register(false)});
    await settle();
    assert.deepEqual(registered, ['sw.js']);
    app.close();

    // A failed registration - the app runs online only
    app = startApp({'beforeStart': register(true)});
    await settle();
    assert.deepEqual(registered, ['sw.js', 'sw.js']);
    assert.equal(app.element('libraryView').hidden, false);
    app.close();
});


test('main, about sheet', async () => {
    const app = startApp();
    const {element} = app;
    await settle();
    app.click('aboutButton');
    assert.equal(element('sheet').open, true);
    assert.equal(app.text('sheetTitle'), 'About PicoShelf');
    // (the narrators' note - no longer in the narrator sheet)
    const paragraphs = [...element('sheetBody').querySelectorAll('p')].map((paragraph) => paragraph.textContent);
    assert.equal(paragraphs.length, 3);
    assert.match(paragraphs[1], /^The narrators are PicoVox voices, synthesized on your device/);
    const links = [...element('sheetBody').querySelectorAll('.about-links a')];
    assert.deepEqual(links.map((link) => [link.textContent, link.href, link.target]), [
        ['Standard Ebooks', 'https://standardebooks.org/', '_blank'],
        ['Project Gutenberg', 'https://www.gutenberg.org/', '_blank'],
        ['Wikipedia', 'https://en.wikipedia.org/', '_blank'],
        ['PicoVox', 'https://github.com/craigahobbs/picovox#readme', '_blank'],
        ['PicoShelf on GitHub', 'https://github.com/craigahobbs/picoshelf#readme', '_blank']
    ]);
    app.click('sheetClose');
    assert.equal(element('sheet').open, false);
    app.close();
});


test('main, settings sheet', async () => {
    const app = await startPlayer();
    const {element, engine} = app;
    app.click('settingsButton');
    assert.equal(app.text('sheetTitle'), 'Narrator');
    const select = () => element('sheetBody').querySelector('select');
    const radios = (index) => [...element('sheetBody').querySelectorAll('[role="radiogroup"]')[index].children].map((button) => [
        button.textContent, button.getAttribute('aria-checked')
    ]);
    const radio = (index, label) => [...element('sheetBody').querySelectorAll('[role="radiogroup"]')[index].children].
        find((button) => button.textContent === label);
    const resetText = () => element('sheetBody').querySelector('.reset-setting p').textContent;

    // The book's default narrator
    assert.deepEqual([...select().querySelectorAll('optgroup')].map((group) => group.label), ['Female voices', 'Male voices']);
    assert.deepEqual([...select().options].map((option) => option.textContent), [
        'Mary', 'Sarah', 'Helen (default)', 'Amy', 'Kate', 'Grace', 'John', 'James', 'Robert', 'Michael', 'David', 'Thomas'
    ]);
    assert.equal(select().value, 'helen');
    assert.equal(select().getAttribute('aria-label'), 'Voice');
    assert.deepEqual(radios(0), [['0.8×', 'false'], ['1×', 'true'], ['1.1×', 'false'], ['1.2×', 'false'], ['1.5×', 'false']]);
    assert.deepEqual(radios(1), [['Off', 'false'], ['On', 'true']]);
    assert.equal(resetText(), 'Helen at 1× - the narrator chosen for this book.');
    assert.equal(element('sheetBody').querySelector('.reset-setting button'), null);

    // Another voice and speed
    select().value = 'neural-male';
    select().dispatchEvent(new app.window.Event('change'));
    assert.equal(app.saved.books[prideKey].voice, 'neural-male');
    assert.deepEqual(engine.calls.at(-1), ['setVoice', {'voice': 'neural-male', 'rate': 1, 'expressive': true}]);
    assert.equal(select().value, 'neural-male');
    assert.equal(resetText(), 'This book\'s default narrator is Helen at 1×.');
    app.click(radio(0, '1.5×'));
    assert.equal(app.saved.books[prideKey].rate, 1.5);
    assert.deepEqual(engine.calls.at(-1), ['setVoice', {'voice': 'neural-male', 'rate': 1.5, 'expressive': true}]);
    assert.deepEqual(radios(0).at(-1), ['1.5×', 'true']);

    // Reset
    app.click(element('sheetBody').querySelector('.reset-setting button'));
    assert.equal(app.saved.books[prideKey].voice, undefined);
    assert.equal(app.saved.books[prideKey].rate, undefined);
    assert.deepEqual(engine.calls.at(-1), ['setVoice', {'voice': 'helen', 'rate': 1, 'expressive': true}]);
    assert.equal(resetText(), 'Helen at 1× - the narrator chosen for this book.');

    // Only a speed chosen
    app.click(radio(0, '0.8×'));
    assert.equal(resetText(), 'This book\'s default narrator is Helen at 1×.');

    // Expressive dialogue - off, on
    app.click(radio(1, 'Off'));
    assert.equal(app.saved.expressive, false);
    assert.deepEqual(engine.calls.at(-1), ['setVoice', {'voice': 'helen', 'rate': 0.8, 'expressive': false}]);
    assert.deepEqual(radios(1), [['Off', 'true'], ['On', 'false']]);
    app.click(radio(1, 'On'));
    assert.equal(app.saved.expressive, true);
    assert.deepEqual(engine.calls.at(-1), ['setVoice', {'voice': 'helen', 'rate': 0.8, 'expressive': true}]);
    app.close();

    // A voice and speed no longer offered
    const saved = savedWithBook('player');
    Object.assign(saved.books[prideKey], {'voice': 'robotic', 'rate': 1.4});
    const app2 = await startPlayer({saved});
    assert.deepEqual(app2.engine.calls.at(-1), ['load', 1000, {'voice': 'helen', 'rate': 1.5, 'expressive': true}, 350]);
    app2.click('settingsButton');
    assert.equal(app2.element('sheetBody').querySelector('select').value, 'helen');
    app2.close();
});


test('main, share sheet', async () => {
    const shares = [];
    let shareResult = Promise.resolve();
    const app = await startPlayer({'beforeStart': ({window}) => {
        window.navigator.share = (data) => {
            shares.push(data);
            return shareResult;
        };
    }});
    const {element, engine, window} = app;
    const bookUrl = `${appUrl}#book=se.jane-austen.pride-and-prejudice`;

    // The book, the section, and the place - the system's share sheet
    app.click('shareButton');
    assert.equal(app.text('sheetTitle'), 'Share');
    assert.deepEqual([...element('sheetBody').querySelectorAll('.sheet-go')].map((button) => [
        button.querySelector('.label').textContent, button.querySelector('.detail').textContent
    ]), [['Pride and Prejudice', 'This book'], ['A Part', 'This section'], ['It is a truth universally acknowledged.', 'This place']]);
    app.click(app.sheetButtons()[2]);
    await settle();
    assert.deepEqual(shares, [{'title': 'Pride and Prejudice', 'url': `${bookUrl}&section=2&char=350`}]);
    assert.equal(element('sheet').open, false);

    // Canceled
    shareResult = Promise.reject(new Error('AbortError'));
    app.click('shareButton');
    app.click(app.sheetButtons()[1]);
    await settle();
    assert.deepEqual(shares.at(-1), {'title': 'Pride and Prejudice', 'url': `${bookUrl}&section=2`});
    assert.equal(element('sheet').open, true);
    app.click('sheetClose');

    // No share sheet - copied
    delete window.navigator.share;
    const copied = [];
    let copyResult = Promise.resolve();
    Object.defineProperty(window.navigator, 'clipboard', {'configurable': true, 'value': {'writeText': (text) => {
        copied.push(text);
        return copyResult;
    }}});
    app.click('shareButton');
    app.click(app.sheetButtons()[0]);
    await settle();
    assert.deepEqual(copied, [bookUrl]);
    assert.equal(element('sheetBody').querySelector('.share-note').textContent, 'Link copied.');

    // Not copied - the link shown
    copyResult = Promise.reject(new Error('Denied'));
    app.click(app.sheetButtons()[0]);
    await settle();
    assert.equal(element('sheetBody').querySelector('.share-note').textContent, bookUrl);
    app.click('sheetClose');

    // Before the first section, a long sentence; no sentence
    engine.change({'char': 50, 'sentenceChar': 50, 'sentence': 'z'.repeat(101)});
    app.click('shareButton');
    assert.deepEqual(app.sheetLabels(), ['Pride and Prejudice', `${'z'.repeat(97)}...`]);
    app.click(app.sheetButtons()[1]);
    await settle();
    assert.equal(copied.at(-1), `${bookUrl}&char=50`);
    app.click('sheetClose');
    engine.change({'sentence': ''});
    app.click('shareButton');
    assert.deepEqual(app.sheetLabels(), ['Pride and Prejudice']);
    app.close();
});


test('main, remove the open book', async () => {
    const app = startApp({'saved': savedWithBook('library', {'scope': 'mine'}), 'cached': cachedPride});
    const {element, engine} = app;
    await settle();

    // Removed from my library - closed
    element('results').querySelector('.book-row .icon-button').click();
    app.click(app.sheetButtons()[1]);
    assert.deepEqual(engine.calls.at(-1), ['unload']);
    assert.equal(app.saved.current, null);
    assert.deepEqual(app.saved.books, {});
    assert.equal(element('miniPlayer').hidden, true);
    app.close();

    // Removed with the player shown (a link opened it behind the sheet) - the library
    const app2 = startApp({'saved': savedWithBook('library', {'scope': 'mine'}), 'cached': cachedPride});
    await settle();
    app2.element('results').querySelector('.book-row .icon-button').click();
    app2.window.location.hash = '#book=se.jane-austen.pride-and-prejudice';
    await settle();
    assert.equal(app2.element('playerView').hidden, false);
    app2.click(app2.sheetButtons()[1]);
    assert.equal(app2.element('playerView').hidden, true);
    assert.equal(app2.element('libraryView').hidden, false);
    assert.deepEqual(app2.saved.books, {});
    app2.close();
});


test('main, media session', async () => {
    let now = 0;
    let positionError = false;
    const mediaSession = {
        'handlers': {}, 'positions': [], 'metadata': undefined, 'playbackState': undefined,
        'setActionHandler': (action, handler) => {
            mediaSession.handlers[action] = handler;
        },
        'setPositionState': (position) => {
            if (positionError) {
                throw new Error('Invalid');
            }
            mediaSession.positions.push(position);
        }
    };
    const app = await startPlayer({'load': () => new Promise(() => {
        // Still downloading
    }), 'beforeStart': ({window}) => {
        Object.defineProperty(window.navigator, 'mediaSession', {'configurable': true, 'value': mediaSession});
        Object.defineProperty(window, 'performance', {'configurable': true, 'value': {'now': () => now}});
        window.MediaMetadata = class {
            constructor(init) {
                Object.assign(this, init);
            }
        };
    }});
    const {element, engine} = app;

    // The metadata, the state, and the position
    engine.change({});
    assert.deepEqual({...mediaSession.metadata}, {
        'title': 'A Part', 'artist': 'Jane Austen', 'album': 'Pride and Prejudice',
        'artwork': [{'src': 'https://example.com/pride.jpg', 'sizes': '512x768', 'type': 'image/jpeg'}]
    });
    assert.equal(mediaSession.playbackState, 'paused');
    assert.deepEqual(mediaSession.positions, [{'duration': 100, 'playbackRate': 1, 'position': 35}]);
    assert.deepEqual(Object.keys(mediaSession.handlers), [
        'play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack', 'seekto'
    ]);

    // The position - set when playing starts or stops, when it jumps, and every 10 seconds
    const {metadata} = mediaSession;
    now = 1000;
    engine.change({'char': 360, 'sentenceChar': 360});
    assert.equal(mediaSession.positions.length, 1);
    assert.equal(mediaSession.metadata, metadata);
    engine.change({'status': 'playing', 'playing': true});
    assert.equal(mediaSession.playbackState, 'playing');
    assert.deepEqual(mediaSession.positions.at(-1), {'duration': 100, 'playbackRate': 1, 'position': 36});
    now = 2000;
    engine.change({'char': 370, 'sentenceChar': 370});
    assert.equal(mediaSession.positions.length, 2);
    engine.change({'char': 700, 'sentenceChar': 700});
    assert.equal(mediaSession.positions.length, 3);
    assert.equal(mediaSession.metadata.title, 'Chapter II');
    now = 12001;
    engine.change({'char': 800, 'sentenceChar': 800});
    assert.equal(mediaSession.positions.length, 4);
    positionError = true;
    now = 30000;
    engine.change({});
    assert.equal(mediaSession.positions.length, 4);

    // The lock screen's controls
    const {handlers} = mediaSession;
    // (pause pauses - a paused book stays paused)
    handlers.pause();
    assert.deepEqual(engine.calls.at(-1), ['pause']);
    handlers.pause();
    assert.deepEqual(engine.calls.slice(-2), [['pause'], ['pause']]);
    assert.equal(engine.playing, false);
    handlers.play();
    assert.deepEqual(engine.calls.at(-1), ['play']);
    handlers.seekbackward();
    handlers.seekforward();
    handlers.previoustrack();
    handlers.nexttrack();
    assert.deepEqual(engine.calls.slice(-4), [['skipSentence', -1], ['skipSentence', 1], ['skipSentence', -1], ['skipSentence', 1]]);
    handlers.seekto({'seekTime': 60});
    assert.deepEqual(engine.calls.at(-1), ['seekChar', 600]);
    assert.equal(app.saved.books[prideKey].char, 600);
    const count = engine.calls.length;
    handlers.seekto({'seekTime': Number.NaN});
    assert.equal(engine.calls.length, count);

    // Closed - cleared, and the controls do nothing
    app.click('toLibrary');
    await settle();
    app.click(element('miniPlayerInner').querySelector('.icon-button'));
    assert.equal(mediaSession.metadata, null);
    assert.equal(mediaSession.playbackState, 'none');
    handlers.seekto({'seekTime': 10});
    handlers.seekforward();
    assert.equal(engine.calls.at(-1)[0], 'unload');

    // Another book (no cover), downloading - its title
    app.window.location.hash = '#book=pg84';
    await settle();
    engine.change({});
    assert.deepEqual({...mediaSession.metadata}, {
        'title': 'Frankenstein; Or, The Modern Prometheus', 'artist': 'Mary Wollstonecraft Shelley',
        'album': 'Frankenstein; Or, The Modern Prometheus', 'artwork': []
    });
    app.close();
});


test('main, media session without metadata or position', async () => {
    const mediaSession = {'setActionHandler': () => {
        throw new Error('Unsupported');
    }};
    const app = await startPlayer({'beforeStart': ({window}) => {
        Object.defineProperty(window.navigator, 'mediaSession', {'configurable': true, 'value': mediaSession});
    }});
    app.engine.change({'status': 'buffering'});
    assert.equal(mediaSession.metadata, undefined);
    assert.equal(mediaSession.playbackState, 'playing');
    app.close();
});
