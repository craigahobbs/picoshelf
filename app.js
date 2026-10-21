// The audiobook player - a library (continue listening, your books, and finding books in the catalog of public-domain
// books - data/catalog.json, built offline by tools/catalog.js; each book's text is fetched from its source) and a
// player (play/pause, back and forward, with contents, bookmarks, and the narrator's voice and speed). The listener's
// place in every book is kept in browser storage, so reloading or leaving and coming back resumes where they were.

import {deleteCachedBook, getCachedBook, putCachedBook} from './bookcache.js';
import {findBook, groupByAuthor, groupByGenre, listBooks, matchBooks} from './lib/catalog.js';
import {loadState, newId, saveState} from './store.js';
import {Engine} from './engine.js';
import {source as gutenberg} from './sources/gutenberg.js';
import {source as standardEbooks} from './sources/standardebooks.js';
import {articleBook, articleVoice, searchArticles, todaysArticles, source as wikipedia} from './sources/wikipedia.js';
import {voiceTable} from './picovox/lib/synthesis.js';


// The book sources' loaders, and the catalog (loaded at startup)
const loaders = Object.fromEntries([standardEbooks, gutenberg, wikipedia].map((source) => [source.id, source]));
let catalog = null;
const catalogPromise = fetch(new URL('./data/catalog.json', import.meta.url)).then((response) => {
    if (!response.ok) {
        throw new Error(`The book catalog couldn't be loaded (${response.status}).`);
    }
    return response.json();
});


// The skip distance (s), the narrator speeds, and the narrator voices
const skipSeconds = 30;
const speeds = [0.8, 1, 1.1, 1.2, 1.5];
// (the app's keys for PicoVox's male and female voices are neural-male and neural-female - listeners' saved settings -
// and the app names them John and Mary; the designed voices are PicoVox's keys)
const plainVoices = {'male': 'John', 'female': 'Mary'};
const voiceChoices = voiceTable.map(({key, label, sex, description}) => (key in plainVoices ?
    {'value': `neural-${key}`, 'label': plainVoices[key], sex, description} : {'value': key, label, sex, description}));
// A book's narrator by default - the catalog's voice for it (cast by tools/voicecast.js), at normal speed
const fallbackVoice = 'neural-male';
const defaultRate = 1;


// Elements
const element = (id) => document.getElementById(id);
const libraryView = element('libraryView');
const playerView = element('playerView');
const miniPlayer = element('miniPlayer');
const miniPlayerInner = element('miniPlayerInner');
const scopeTabs = element('scopeTabs');
const viewTabs = element('viewTabs');
const searchForm = element('searchForm');
const searchInput = element('search');
const sourceNote = element('sourceNote');
const results = element('results');
const resultsStatus = element('resultsStatus');
const moreButton = element('more');
const playerCover = element('playerCover');
const bookTitle = element('bookTitle');
const bookAuthor = element('bookAuthor');
const chapterTitle = element('chapterTitle');
const sentence = element('sentence');
const progressBar = element('progressBar');
const progressFill = element('progressFill');
const percentLabel = element('percent');
const remainingLabel = element('remaining');
const playPauseButton = element('playPause');
const sectionBackButton = element('sectionBack');
const sectionForwardButton = element('sectionForward');
const playerStatus = element('playerStatus');
const sheet = element('sheet');
const sheetTitle = element('sheetTitle');
const sheetBody = element('sheetBody');


// State - the persisted state, the open book ({key, chapters, loading, progress, error}), the browse results, and the
// sheet being shown
const state = loadState();
// The narrator was one setting for every book - each book listened to keeps it (as the listener's choice for the
// book), so no book's narrator changes mid-book. Listeners who chose a classic (rule) voice get its neural counterpart.
if (state.settings !== undefined) {
    const classicVoices = {'male': 'neural-male', 'female': 'neural-female'};
    const {voice, rate} = state.settings;
    const savedVoice = voiceChoices.some(({value}) => value === voice) ? voice : (classicVoices[voice] ?? fallbackVoice);
    for (const book of Object.values(state.books).filter((item) => item.char > 0)) {
        book.voice ??= savedVoice;
        book.rate ??= typeof rate === 'number' ? nearestSpeed(rate) : defaultRate;
    }
    delete state.settings;
}
// The library's scope (the whole library or my library) and view (all books, by author, or by genre)
delete state.sourceTab;
state.scope = ['library', 'wikipedia', 'mine'].includes(state.scope) ? state.scope : 'library';
state.libraryView = ['all', 'authors', 'genres'].includes(state.libraryView) ? state.libraryView : 'all';
let current = null;
const browseState = {'query': '', 'page': 1, 'books': [], 'error': null, 'openGroups': new Set(), 'scroll': 0};
let openSheetName = null;
let lastSave = 0;
// (?slowdown=N stretches synthesis N times - to reproduce a device slower than real time; ?model=<name> speaks with a
// development voice model, build/app-models/<name>.js - a training checkpoint, say - on a development server)
const appParameters = new URLSearchParams(window.location.search);
const slowdown = Number(appParameters.get('slowdown')) || 1;
const modelName = appParameters.get('model');
const voiceModelUrl = modelName !== null && /^[a-z0-9-]+$/.test(modelName) ?
    new URL(`./build/app-models/${modelName}.js`, import.meta.url).href : undefined;
const engine = new Engine({'onChange': onEngineChange, slowdown, voiceModelUrl});


// The startup timeline overlay (?timing in the URL) - the engine's events since the last play, for diagnosing slow
// starts on a device. With &log=<url>, the timeline, page errors, and the user agent are also posted to <url>/log every
// two seconds (tools/devlog.js receives them).
const debugParameters = new URLSearchParams(window.location.search);
if (debugParameters.has('timing')) {
    const overlay = document.createElement('pre');
    overlay.className = 'timing-overlay';
    document.body.append(overlay);
    window.addEventListener('error', (event) => engine.mark(`page error: ${event.message} ${event.filename}:${event.lineno}`));
    window.addEventListener('unhandledrejection', (event) => engine.mark(`page rejection: ${event.reason?.stack || event.reason}`));
    const logUrl = debugParameters.get('log');
    let logged = '';
    setInterval(() => {
        const text = engine.timeline.map(({ms, event}) => `${String(ms).padStart(6)} ms  ${event}`).join('\n');
        overlay.textContent = text;
        if (logUrl && text !== logged) {
            logged = text;
            navigator.sendBeacon(`${logUrl}/log`, JSON.stringify({'userAgent': navigator.userAgent, 'href': window.location.href, text}));
        }
    }, 2000);
}


// Create an element with a class and text
function make(tag, className = '', text = '') {
    const created = document.createElement(tag);
    if (className !== '') {
        created.className = className;
    }
    if (text !== '') {
        created.textContent = text;
    }
    return created;
}


// An SVG icon (from the page's symbols)
function icon(name, className = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
}


// A book's key - its source and id
function bookKey(book) {
    return `${book.source}:${book.id}`;
}


// A book's link id - stable across catalog builds: its Project Gutenberg ebook number (pg1342), its Standard Ebooks
// path (se.jane-austen.pride-and-prejudice - the path's segments are lowercase letters, digits, hyphens, and
// underscores, so the id needs no URL encoding), or a Wikipedia article's title, as Wikipedia's links write it
// (wp.Moby-Dick, wp.Herman_Melville)
function linkId(book) {
    if (book.source === 'gutenberg') {
        return `pg${book.id}`;
    }
    if (book.source === 'wikipedia') {
        return `wp.${book.id.replaceAll(' ', '_')}`;
    }
    return `se.${book.id.replace(/^\/ebooks\//, '').replaceAll('/', '.')}`;
}


// A link id's book - {source, id}, or null
function linkBook(id) {
    const gutenbergMatch = /^pg(\d+)$/.exec(id);
    if (gutenbergMatch !== null) {
        return {'source': 'gutenberg', 'id': gutenbergMatch[1]};
    }
    const wikipediaMatch = /^wp\.(.+)$/.exec(id);
    if (wikipediaMatch !== null) {
        return {'source': 'wikipedia', 'id': wikipediaMatch[1].replaceAll('_', ' ')};
    }
    const seMatch = /^se\.([a-z0-9_-]+(?:\.[a-z0-9_-]+)+)$/.exec(id);
    return seMatch === null ? null : {'source': 'standardebooks', 'id': `/ebooks/${seMatch[1].replaceAll('.', '/')}`};
}


// The hash parameters - key=value pairs joined by "&", their keys and values URL-encoded (as MarkdownUp's); a part
// without "=" is ignored
function decodeHash(hash) {
    const params = {};
    for (const part of hash.replace(/^#/, '').split('&')) {
        const equal = part.indexOf('=');
        if (equal > 0) {
            try {
                params[decodeURIComponent(part.slice(0, equal))] = decodeURIComponent(part.slice(equal + 1));
            } catch {
                // A malformed escape - the part is ignored
            }
        }
    }
    return params;
}


// Encode hash parameters (null values left out)
function encodeHash(params) {
    return Object.entries(params).filter(([, value]) => value !== null).
        map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}


// The open book's link - #book=ID, and with a section (the contents' sections and subsections in order, from 1),
// &section=N
function bookLink(section = null) {
    const book = state.books[current.key];
    return `${window.location.origin}${window.location.pathname}${window.location.search}#${encodeHash({'book': linkId(book), section})}`;
}


// The section number of a character offset in the open book (null before the first section)
function sectionNumber(char) {
    const chapter = chapterAt(char);
    return chapter === null ? null : current.chapters.indexOf(chapter) + 1;
}


// Keep the address the open book's link at the listener's section (the library's address has no hash), without new
// history entries
function updateAddress() {
    const showing = current !== null && !playerView.hidden;
    let hash = '';
    if (showing) {
        const ready = !current.loading && current.error === null && engine.loaded;
        const section = ready ? sectionNumber(engine.state().sentenceChar) : current.section ?? null;
        hash = `#${encodeHash({'book': linkId(state.books[current.key]), section})}`;
    }
    if (window.location.hash !== hash) {
        history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
}


// Open a link's book (#book=ID&section=N) - in the player, at the section (the listener's place, if it's in the
// section); returns false if the link names no book
async function openLink(hash) {
    const params = decodeHash(hash);
    const linked = linkBook(params.book ?? '');
    if (linked === null) {
        return false;
    }
    const section = /^[1-9]\d*$/.test(params.section ?? '') ? Number(params.section) : null;
    const saved = state.books[bookKey(linked)];
    let book = saved;
    if (book === undefined && linked.source === 'wikipedia') {
        book = articleBook({'title': linked.id});
    } else if (book === undefined) {
        book = findBook(await catalogPromise.catch(() => ({'books': []})), linked.source, linked.id);
    }
    if (book === null) {
        return false;
    }
    openBook(book, {'play': false, 'show': true, section});
    return true;
}


// A book's cover - its image, or a generated cover (a color from the title) if there is none or it fails to load
function coverElement(book, className = '') {
    const cover = make('div', `cover ${className}`.trim());
    const generated = () => {
        let hash = 0;
        for (const char of book.title || '?') {
            hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        }
        const label = make('div', 'generated', book.title || '');
        label.style.background = `hsl(${hash % 360} 38% 34%)`;
        cover.replaceChildren(label);
    };
    if (book.cover) {
        const image = make('img');
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        image.src = book.cover;
        image.onerror = generated;
        cover.append(image);
    } else {
        generated();
    }
    return cover;
}


// Format the time left
function formatRemaining(seconds) {
    if (!(seconds > 0)) {
        return '';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) {
        return 'Less than a minute left';
    }
    if (minutes < 60) {
        return `${minutes} min left`;
    }
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}


// Save the persisted state - throttled unless forced
function persist(force = true) {
    const now = Date.now();
    if (force || now - lastSave > 3000) {
        lastSave = now;
        saveState(state);
    }
}


// The chapter at a character offset - the last chapter starting at or before it
function chapterAt(char) {
    if (current === null) {
        return null;
    }
    let found = null;
    for (const chapter of current.chapters) {
        if (chapter.char > char) {
            break;
        }
        found = chapter;
    }
    return found;
}


// Remember the place in the open book
function savePosition(force = false) {
    if (current === null || current.loading || current.error !== null || !engine.loaded) {
        return;
    }
    const engineState = engine.state();
    const entry = state.books[current.key];
    if (entry === undefined) {
        return;
    }
    const chapter = chapterAt(engineState.char);
    entry.char = engineState.sentenceChar;
    entry.percent = engineState.status === 'ended' ? 100 : engineState.percent;
    entry.remaining = engineState.status === 'ended' ? 0 : engineState.remainingSeconds;
    entry.chapter = chapter === null ? '' : chapter.title;
    entry.updated = Date.now();
    persist(force);
}


// Engine changes - a new sentence, play, pause, buffering, or the end
function onEngineChange(engineState) {
    savePosition(engineState.status !== 'playing');
    renderPlayer();
    renderMiniPlayer();
    updateMediaSession();
}


// Open a book - download it (or use the cached copy) and load it at the listener's place. To play, call from a user
// gesture (it unlocks audio).
async function openBook(book, {play = false, show = true, section = null} = {}) {
    const key = bookKey(book);
    const saved = state.books[key] || {};
    state.books[key] = {
        'char': 0, 'percent': 0, ...saved, 'source': book.source, 'id': book.id, 'title': book.title || saved.title || '',
        'author': book.author || saved.author || '', 'cover': book.cover || saved.cover || null, 'updated': Date.now()
    };
    state.current = key;
    persist();
    if (show) {
        showPlayer();
    }
    if (play) {
        engine.ensureAudio();
    }

    // Already open? (at a linked section, if not in it)
    if (current !== null && current.key === key && current.error === null) {
        if (section !== null) {
            if (current.loading) {
                current.section = section;
            } else if (engine.loaded) {
                const start = sectionStart(current.chapters, section, engine.state().sentenceChar);
                if (start !== engine.state().sentenceChar) {
                    engine.seekChar(start);
                }
            }
        }
        if (play && !current.loading) {
            engine.play();
        }
        current.playWhenLoaded ||= play;
        renderAll();
        return;
    }
    engine.pause();
    current = {key, 'chapters': [], 'loading': true, 'progress': null, 'error': null, 'playWhenLoaded': play, section};
    renderAll();
    const opening = current;
    try {
        // The book's default voice - the catalog's (a cached book plays without the catalog); a Wikipedia article's,
        // the articles' narrator (Wikipedia's articles aren't in the catalog - the article is its own entry)
        const isArticle = book.source === 'wikipedia';
        const catalogEntry = isArticle ? {'voice': articleVoice} :
            findBook(await catalogPromise.catch(() => ({'books': []})), book.source, book.id);
        opening.defaultVoice = voiceChoices.some(({value}) => value === catalogEntry?.voice) ? catalogEntry.voice : fallbackVoice;
        let prepared = await getCachedBook(key);
        if (prepared === null) {
            const loader = loaders[book.source];
            const entry = isArticle ? articleBook({'title': book.id}) : findBook(await catalogPromise, book.source, book.id);
            if (loader === undefined || entry === null) {
                throw new Error('This book is no longer in the catalog.');
            }
            prepared = await loader.load(entry, (loaded, total) => {
                opening.progress = total ? loaded / total : null;
                opening.loaded = loaded;
                renderPlayer();
            });
            const {text, chapters, title, author} = prepared;
            await putCachedBook({key, text, chapters, title, author});
        }
        if (current !== opening) {
            return;
        }
        opening.chapters = prepared.chapters || [];
        opening.loading = false;
        const entry = state.books[key];
        entry.title ||= prepared.title || '';
        entry.author ||= prepared.author || '';
        engine.load(prepared.text, narrator(), sectionStart(opening.chapters, opening.section, entry.char || 0));
        persist();
        renderAll();
        if (opening.playWhenLoaded) {
            engine.play();
        }
    } catch (error) {
        if (current === opening) {
            opening.loading = false;
            opening.error = error.message || String(error);
            renderAll();
        }
    }
}


// Play or pause the open book (from a user gesture)
function togglePlay() {
    if (current === null) {
        return;
    }
    if (current.error !== null) {
        // Retry a failed download
        const book = state.books[current.key];
        current = null;
        openBook(book, {'play': true, 'show': !playerView.hidden});
        return;
    }
    if (current.loading) {
        current.playWhenLoaded = !current.playWhenLoaded;
        engine.ensureAudio();
        renderAll();
        return;
    }
    engine.toggle();
}


// Skip back or forward
function skip(seconds) {
    if (current !== null && !current.loading && engine.loaded) {
        engine.skip(seconds);
        savePosition(true);
    }
}


// A linked section's starting place - the listener's place if it's in the section (or there's no such section), else
// the section's start
function sectionStart(chapters, section, char) {
    const chapter = section === null ? undefined : chapters[section - 1];
    if (chapter === undefined) {
        return char;
    }
    const next = chapters[section];
    return char >= chapter.char && (next === undefined || char < next.char) ? char : chapter.char;
}


// Go to the next or the previous section - back goes to the section's start, or to the previous section's from near
// its start
const sectionRestartChars = 120;
function skipSection(direction) {
    if (current === null || current.loading || current.error !== null || !engine.loaded) {
        return;
    }
    const target = sectionTarget(direction);
    if (target !== null) {
        engine.seekChar(target.char);
        savePosition(true);
        renderPlayer();
    }
}


// The section skipSection goes to - null if none
function sectionTarget(direction) {
    const {sentenceChar} = engine.state();
    const chapter = chapterAt(sentenceChar);
    const index = chapter === null ? -1 : current.chapters.indexOf(chapter);
    if (direction > 0) {
        return current.chapters[index + 1] ?? null;
    }
    if (chapter !== null && sentenceChar > chapter.char + sectionRestartChars) {
        return chapter;
    }
    return current.chapters[index - 1] ?? null;
}


// Show the library
function showLibrary() {
    closeSheet();
    const returning = libraryView.hidden;
    state.view = 'library';
    persist();
    playerView.hidden = true;
    libraryView.hidden = false;
    updateAddress();
    renderLibrary();
    renderMiniPlayer();
    if (returning) {
        window.scrollTo(0, browseState.scroll);
    }
}


// Show the player (with a history entry, so the back gesture returns to the library)
function showPlayer() {
    if (!libraryView.hidden) {
        browseState.scroll = window.scrollY;
    }
    if (playerView.hidden && history.state?.view !== 'player') {
        history.pushState({'view': 'player'}, '');
    }
    state.view = 'player';
    persist();
    libraryView.hidden = true;
    miniPlayer.hidden = true;
    playerView.hidden = false;
    window.scrollTo(0, 0);
    renderPlayer();
    updateAddress();
}


// Render everything
function renderAll() {
    renderPlayer();
    renderMiniPlayer();
    if (!libraryView.hidden) {
        renderLibrary();
    }
}


// Render the player
function renderPlayer() {
    if (current === null || playerView.hidden) {
        return;
    }
    const book = state.books[current.key];
    if (playerCover.dataset.key !== current.key) {
        playerCover.dataset.key = current.key;
        playerCover.replaceChildren(...coverElement(book).childNodes);
        bookTitle.textContent = book.title;
        bookAuthor.textContent = book.source === 'wikipedia' ? 'From Wikipedia, the free encyclopedia (CC BY-SA)' : book.author;
        document.title = `${book.title} - PicoShelf`;
    }
    const engineState = engine.state();
    const ready = !current.loading && current.error === null && engine.loaded;
    const percent = ready ? engineState.percent : (book.percent || 0);
    const chapter = ready ? chapterAt(engineState.char) : null;
    chapterTitle.textContent = chapter === null ? (book.chapter || '') : chapter.title;
    sentence.textContent = ready ? engineState.sentence : '';
    progressFill.style.width = `${Math.min(100, percent).toFixed(2)}%`;
    progressBar.setAttribute('aria-valuenow', Math.floor(percent));
    percentLabel.textContent = `${Math.floor(percent)}%`;
    remainingLabel.textContent = ready ? formatRemaining(engineState.remainingSeconds) : formatRemaining(book.remaining);

    // The play button and the status
    let status = '';
    let isError = false;
    let buttonIcon = 'play';
    let label = 'Play';
    if (current.error !== null) {
        status = `${current.error} Press play to try again.`;
        isError = true;
    } else if (current.loading) {
        status = current.progress === null ? 'Downloading the book...' : `Downloading the book... ${Math.round(100 * current.progress)}%`;
        if (current.playWhenLoaded) {
            buttonIcon = 'busy';
            label = 'Pause';
        }
    } else if (engine.error) {
        status = engine.error;
        isError = true;
    } else if (engineState.status === 'buffering') {
        buttonIcon = 'busy';
        label = 'Pause';
    } else if (engineState.status === 'playing') {
        buttonIcon = 'pause';
        label = 'Pause';
    } else if (engineState.status === 'loading') {
        status = 'Loading the voice...';
    } else if (engineState.status === 'ended') {
        status = 'The end. Press play to listen again.';
    }
    setPlayIcon(playPauseButton, buttonIcon, label);
    sectionBackButton.disabled = !ready || sectionTarget(-1) === null;
    sectionForwardButton.disabled = !ready || sectionTarget(1) === null;
    playerStatus.textContent = status;
    playerStatus.classList.toggle('error', isError);
}


// Set a play button's icon and label
function setPlayIcon(button, name, label) {
    if (button.dataset.icon !== name) {
        button.dataset.icon = name;
        button.replaceChildren(icon(name, name === 'busy' ? 'icon spinner' : 'icon'));
    }
    button.setAttribute('aria-label', label);
}


// The open book's play button state - 'pause' while playing (or about to), else 'play'
function isPlayingOrStarting() {
    if (current === null) {
        return false;
    }
    if (current.loading) {
        return current.playWhenLoaded;
    }
    const {status} = engine.state();
    return status === 'playing' || status === 'buffering';
}


// Render the mini player (in the library, while a book is open)
function renderMiniPlayer() {
    const visible = current !== null && !libraryView.hidden;
    miniPlayer.hidden = !visible;
    if (!visible) {
        return;
    }
    const book = state.books[current.key];
    if (miniPlayerInner.dataset.key !== current.key) {
        miniPlayerInner.dataset.key = current.key;
        const open = make('button', 'book-open');
        open.type = 'button';
        open.setAttribute('aria-label', `Open the player for ${book.title}`);
        const text = make('div', 'book-text');
        text.append(make('div', 'book-title', book.title), make('div', 'book-meta'));
        open.append(coverElement(book), text);
        open.addEventListener('click', showPlayer);
        const play = make('button', 'round-play');
        play.type = 'button';
        play.addEventListener('click', togglePlay);
        const close = make('button', 'icon-button');
        close.type = 'button';
        close.setAttribute('aria-label', `Close ${book.title}`);
        close.title = 'Close';
        close.append(icon('close'));
        close.addEventListener('click', closeBook);
        miniPlayerInner.replaceChildren(open, play, close);
    }
    const playing = isPlayingOrStarting();
    const busy = current.loading && current.playWhenLoaded || engine.state().status === 'buffering';
    setPlayIcon(miniPlayerInner.querySelector('.round-play'), busy ? 'busy' : (playing ? 'pause' : 'play'), playing ? 'Pause' : 'Play');
    const engineState = engine.loaded && !current.loading ? engine.state() : null;
    const chapter = engineState === null ? book.chapter : (chapterAt(engineState.char) || {}).title;
    const percent = engineState === null ? book.percent || 0 : engineState.percent;
    miniPlayerInner.querySelector('.book-meta').textContent = [chapter, `${Math.floor(percent)}%`].filter(Boolean).join(' · ');
}


// A book list row - open the book on click; with an optional remove button and progress
function bookRow(book, {progress = false, removable = false} = {}) {
    const row = make('li', 'book-row');
    const open = make('button', 'book-open');
    open.type = 'button';
    const text = make('div', 'book-text');
    text.append(make('div', 'book-title', book.title));
    const meta = [book.source === 'wikipedia' ? book.description || 'Wikipedia' : book.author];
    const saved = state.books[bookKey(book)];
    if (progress && saved !== undefined) {
        meta.push(saved.percent >= 99.5 ? 'Finished' : `${Math.floor(saved.percent || 0)}%`);
    }
    text.append(make('div', 'book-meta', meta.filter(Boolean).join(' · ')));
    if (progress && saved !== undefined) {
        const bar = make('div', 'mini-progress');
        const fill = make('div');
        fill.style.width = `${Math.min(100, saved.percent || 0)}%`;
        bar.append(fill);
        text.append(bar);
    }
    open.append(coverElement(book), text);
    open.addEventListener('click', () => openBook(book, {'play': false}));
    row.append(open);
    if (removable && saved !== undefined) {
        const remove = make('button', 'icon-button');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${book.title} from my library`);
        remove.title = 'Remove';
        remove.append(icon('delete'));
        remove.addEventListener('click', () => removeBook(bookKey(book)));
        row.append(remove);
    }
    return row;
}


// Remove a book from your books - its place, bookmarks, and downloaded copy
function removeBook(key) {
    const book = state.books[key];
    if (book !== undefined) {
        openSheetName = 'confirm';
        confirmInSheet(`Remove "${book.title}" from my library? Your place and bookmarks in it are removed too.`, 'Remove',
            () => removeBookNow(key), closeSheet, 'Remove book');
        if (!sheet.open) {
            sheet.showModal();
        }
    }
}


// Close the open book - nothing playing (the book stays in my library, at its place)
function closeBook() {
    if (current === null) {
        return;
    }
    savePosition(true);
    closeSheet();
    engine.unload();
    current = null;
    state.current = null;
    persist();
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        mediaKey = '';
    }
    if (!playerView.hidden) {
        showLibrary();
    }
    renderMiniPlayer();
    renderLibrary();
}


// Remove a book now
function removeBookNow(key) {
    closeSheet();
    if (current !== null && current.key === key) {
        closeBook();
    }
    delete state.books[key];
    delete state.bookmarks[key];
    deleteCachedBook(key);
    persist();
    renderLibrary();
    renderMiniPlayer();
}


// Render the library - the scope (the whole library or my library), the view (all, authors, or genres), and the
// books
function renderLibrary() {
    renderTabs();
    browse(searchInput.value.trim(), 1);
}


// Render the scope and view tabs
function renderTabs() {
    const tabs = (container, choices, selected, onSelect) => {
        container.replaceChildren(...choices.map(([id, name]) => {
            const tab = make('button', '', name);
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(id === selected));
            tab.addEventListener('click', () => {
                if (id !== selected) {
                    onSelect(id);
                    browseState.openGroups.clear();
                    persist();
                    renderLibrary();
                }
            });
            return tab;
        }));
    };
    tabs(scopeTabs, [['library', 'Library'], ['wikipedia', 'Wikipedia'], ['mine', 'My Library']], state.scope, (scope) => {
        state.scope = scope;
    });
    // Wikipedia's articles have no authors or genres - its shelf is a list
    viewTabs.hidden = state.scope === 'wikipedia';
    const placeholder = state.scope === 'wikipedia' ? 'Search Wikipedia' : 'Search titles and authors';
    searchInput.placeholder = placeholder;
    searchInput.setAttribute('aria-label', placeholder);
    tabs(viewTabs, [['all', 'All'], ['authors', 'Authors'], ['genres', 'Genres']], state.libraryView, (view) => {
        state.libraryView = view;
    });
}


// The scope's books - the whole library's (the catalog's, by popularity), or my library's (the books the listener has
// opened, most recently listened first, with their catalog details - for their authors and genres; a Wikipedia article,
// in the catalog or not, is in the Wikipedia genre)
function scopeBooks() {
    if (state.scope === 'mine') {
        return Object.values(state.books).sort((first, second) => (second.updated || 0) - (first.updated || 0)).
            map((book) => (book.source === 'wikipedia' ? {...book, 'genres': [wikipediaGenre]} :
                {...(catalog === null ? null : findBook(catalog, book.source, book.id)), ...book}));
    }
    return catalog === null ? [] : listBooks(catalog);
}


// Browse the scope's books - all, or a search's matches; page 1 replaces the list, later pages (the all view's) extend it
function browse(query, page) {
    if (state.scope === 'wikipedia') {
        browseWikipedia(query, page);
        return;
    }
    browseState.query = query;
    browseState.page = page;
    browseState.books = matchBooks(scopeBooks(), query);
    renderResults();
}


// Browse Wikipedia - today's articles (no query - fetched once a session), or a search's results, More its next page -
// live; a newer browse supersedes one still loading
let wikipediaRequest = 0;
let todaysPromise = null;
async function browseWikipedia(query, page) {
    const request = ++wikipediaRequest;
    const isCurrent = () => request === wikipediaRequest && state.scope === 'wikipedia';
    browseState.query = query;
    browseState.page = page;
    browseState.error = null;
    browseState.loading = true;
    if (page === 1) {
        browseState.books = [];
        browseState.next = null;
    }
    renderResults();
    try {
        if (query === '') {
            todaysPromise ??= todaysArticles().catch((error) => {
                todaysPromise = null;
                throw error;
            });
            const books = await todaysPromise;
            if (isCurrent()) {
                browseState.books = books;
            }
        } else {
            const result = await searchArticles(query, page === 1 ? 0 : browseState.next ?? 0, pageSize);
            if (isCurrent()) {
                browseState.books = page === 1 ? result.books : [...browseState.books, ...result.books];
                browseState.next = result.next;
            }
        }
    } catch (error) {
        if (isCurrent()) {
            browseState.error = error.message || String(error);
        }
    }
    if (isCurrent()) {
        browseState.loading = false;
        renderResults();
    }
}


// The books shown at once (and per More)
const pageSize = 24;

// The Wikipedia articles' genre (my library's Genres view)
const wikipediaGenre = 'wikipedia';


// Render the books - a list (all), or groups by author or genre; Wikipedia's articles, a list
function renderResults() {
    if (state.scope === 'wikipedia') {
        renderArticles();
        return;
    }
    const mine = state.scope === 'mine';
    const {books, query} = browseState;
    const row = (book) => bookRow(book, {'progress': book.percent !== undefined || bookKey(book) in state.books, 'removable': mine});
    let groups = null;
    if (state.libraryView === 'all') {
        const list = make('ul', 'book-list');
        list.append(...books.slice(0, pageSize * browseState.page).map(row));
        results.replaceChildren(list);
    } else {
        groups = state.libraryView === 'authors' ? groupByAuthor(books) :
            groupByGenre(books, {...catalog?.genres, [wikipediaGenre]: 'Wikipedia'});
        // A search's few groups open at once
        const openAll = query !== '' && groups.length <= 3;
        results.replaceChildren(...groups.map((group) => groupElement(group, row, openAll)));
    }
    moreButton.hidden = state.libraryView !== 'all' || books.length <= pageSize * browseState.page;

    // The note and the status
    if (mine) {
        sourceNote.textContent = Object.keys(state.books).length === 0 ? 'Books you open appear here.' :
            'The books you\'ve opened, most recent first.';
    } else if (catalog !== null) {
        const sourceNames = Object.values(catalog.sources).map((source) => source.name).join(' and ');
        sourceNote.textContent = `${catalog.books.length.toLocaleString()} public-domain books from ${sourceNames}.`;
    } else {
        sourceNote.textContent = '';
    }
    let status = '';
    if (browseState.error !== null && !mine) {
        status = browseState.error;
    } else if (catalog === null && !mine) {
        status = 'Loading the catalog...';
    } else if (books.length === 0) {
        status = query === '' ? (mine ? '' : 'No books found.') : `No books match "${query}".`;
    } else if (query !== '') {
        const matches = books.length === 1 ? '1 book matches' : `${books.length.toLocaleString()} books match`;
        const grouped = groups === null ? '' : ` (${groups.length.toLocaleString()} ${state.libraryView === 'authors' ?
            (groups.length === 1 ? 'author' : 'authors') : (groups.length === 1 ? 'genre' : 'genres')})`;
        status = `${matches} "${query}"${grouped}.`;
    }
    resultsStatus.textContent = status;
    resultsStatus.classList.toggle('error', browseState.error !== null && !mine);
}


// Render the Wikipedia shelf - today's articles, or a search's (with More while there are more)
function renderArticles() {
    const {books, query, loading, error} = browseState;
    const list = make('ul', 'book-list');
    list.append(...books.map((book) => bookRow(book, {'progress': bookKey(book) in state.books})));
    results.replaceChildren(list);
    moreButton.hidden = loading || query === '' || browseState.next === null || browseState.next === undefined;
    sourceNote.textContent = query === '' ? 'Today on Wikipedia - the featured article and the most read. Search for any ' +
        'article: it\'s read aloud from Wikipedia, the free encyclopedia (CC BY-SA).' :
        'Articles from Wikipedia, the free encyclopedia (CC BY-SA).';
    let status = '';
    if (error !== null) {
        status = error;
    } else if (loading) {
        status = 'Loading from Wikipedia...';
    } else if (books.length === 0) {
        status = query === '' ? 'No articles today.' : `No articles match "${query}".`;
    }
    resultsStatus.textContent = status;
    resultsStatus.classList.toggle('error', error !== null);
}


// A group - an author or a genre: its name and book count, and its books when opened (pageSize at a time); groups the
// listener opened stay open as the library re-renders
function groupElement(group, row, open) {
    const id = `${state.libraryView}:${group.key ?? group.name}`;
    const details = make('details', 'group');
    const summary = make('summary');
    const count = make('span', 'group-count', group.books.length.toLocaleString());
    summary.append(icon('chevron'), make('span', 'group-name', group.name), count);
    details.append(summary);
    const list = make('ul', 'book-list');
    const more = make('button', 'button group-more', 'More');
    more.type = 'button';
    let shown = 0;
    const showMore = () => {
        list.append(...group.books.slice(shown, shown + pageSize).map(row));
        shown = Math.min(group.books.length, shown + pageSize);
        more.hidden = shown >= group.books.length;
    };
    more.addEventListener('click', showMore);
    details.addEventListener('toggle', () => {
        if (details.open) {
            browseState.openGroups.add(id);
            if (shown === 0) {
                details.append(list, more);
                showMore();
            }
        } else {
            browseState.openGroups.delete(id);
        }
    });
    details.open = open || browseState.openGroups.has(id);
    return details;
}


// Sheets - contents, bookmarks, and settings
function openSheet(name) {
    if (current === null || current.loading || current.error !== null) {
        return;
    }
    openSheetName = name;
    renderSheet();
    if (!sheet.open) {
        sheet.showModal();
    }
}

function closeSheet() {
    openSheetName = null;
    if (sheet.open) {
        sheet.close();
    }
}

function renderSheet() {
    if (openSheetName === 'contents') {
        renderContents();
    } else if (openSheetName === 'bookmarks') {
        renderBookmarks();
    } else if (openSheetName === 'settings') {
        renderSettings();
    } else if (openSheetName === 'share') {
        renderShare();
    }
}


// The share sheet - links to the book and to the listener's section (the system's share sheet, else copied)
function renderShare() {
    sheetTitle.textContent = 'Share';
    const book = state.books[current.key];
    const section = engine.loaded ? sectionNumber(engine.state().sentenceChar) : null;
    const choices = [{'label': book.title, 'detail': 'This book', 'url': bookLink()}];
    if (section !== null) {
        choices.push({'label': current.chapters[section - 1].title, 'detail': 'This section', 'url': bookLink(section)});
    }
    const list = make('ul', 'sheet-list');
    const note = make('p', 'muted share-note', '');
    for (const choice of choices) {
        const item = make('li', 'sheet-item');
        const go = make('button', 'sheet-go');
        go.type = 'button';
        go.append(make('span', 'label', choice.label), make('span', 'detail', choice.detail));
        go.addEventListener('click', async () => {
            if (navigator.share) {
                try {
                    await navigator.share({'title': book.title, 'url': choice.url});
                    closeSheet();
                } catch {
                    // Canceled
                }
                return;
            }
            try {
                await navigator.clipboard.writeText(choice.url);
                note.textContent = 'Link copied.';
            } catch {
                note.textContent = choice.url;
            }
        });
        item.append(go);
        list.append(item);
    }
    sheetBody.replaceChildren(list, note);
}


// The contents sheet - the chapters, the current one marked
function renderContents() {
    sheetTitle.textContent = 'Contents';
    if (current.chapters.length === 0) {
        sheetBody.replaceChildren(make('p', 'sheet-empty', 'This book has no chapter headings.'));
        return;
    }
    const currentChapter = chapterAt(engine.state().char);
    const list = make('ul', 'sheet-list');
    let currentButton = null;
    for (const chapter of current.chapters) {
        const item = make('li', 'sheet-item');
        const go = make('button', 'sheet-go');
        go.type = 'button';
        go.style.paddingLeft = `${10 + 16 * Math.max(0, (chapter.level || 1) - 1)}px`;
        go.append(make('span', 'label', chapter.title));
        if (chapter === currentChapter) {
            go.setAttribute('aria-current', 'true');
            currentButton = go;
        }
        go.addEventListener('click', () => {
            engine.seekChar(chapter.char);
            savePosition(true);
            closeSheet();
        });
        item.append(go);
        list.append(item);
    }
    sheetBody.replaceChildren(list);
    if (currentButton !== null) {
        requestAnimationFrame(() => currentButton.scrollIntoView({'block': 'center'}));
    }
}


// The bookmarks sheet - add one here, and go to, rename, or delete bookmarks
function renderBookmarks(editingId = null) {
    sheetTitle.textContent = 'Bookmarks';
    const {key} = current;
    const bookmarks = (state.bookmarks[key] || []).slice().sort((first, second) => first.char - second.char);
    const add = make('button', 'button primary add-bookmark');
    add.type = 'button';
    add.append(icon('bookmark'), document.createTextNode(' Bookmark this spot'));
    add.style.display = 'inline-flex';
    add.style.alignItems = 'center';
    add.style.justifyContent = 'center';
    add.style.gap = '8px';
    add.addEventListener('click', addBookmark);
    const nodes = [add];
    if (bookmarks.length === 0) {
        nodes.push(make('p', 'sheet-empty', 'No bookmarks yet. Bookmarks keep a spot to come back to - name them to remember why.'));
    }
    const list = make('ul', 'sheet-list');
    for (const bookmark of bookmarks) {
        const item = make('li', 'sheet-item');
        if (bookmark.id === editingId) {
            const input = make('input');
            input.type = 'text';
            input.value = bookmark.label;
            input.setAttribute('aria-label', 'Bookmark name');
            input.maxLength = 120;
            let done = false;
            const finish = (save) => {
                if (done) {
                    return;
                }
                done = true;
                if (save && input.value.trim() !== '') {
                    bookmark.label = input.value.trim();
                    persist();
                }
                renderBookmarks();
            };
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    finish(true);
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(false);
                }
            });
            input.addEventListener('blur', () => finish(true));
            item.append(input);
            requestAnimationFrame(() => {
                input.focus();
                input.select();
            });
        } else {
            const go = make('button', 'sheet-go');
            go.type = 'button';
            const date = new Date(bookmark.created).toLocaleDateString(undefined, {'month': 'short', 'day': 'numeric'});
            const detail = `${Math.floor(bookmark.percent)}% · ${date} · ${bookmark.snippet}`;
            go.append(make('span', 'label', bookmark.label), make('span', 'detail', detail));
            go.addEventListener('click', () => {
                engine.seekChar(bookmark.char);
                savePosition(true);
                closeSheet();
            });
            const rename = make('button', 'icon-button');
            rename.type = 'button';
            rename.setAttribute('aria-label', `Rename the bookmark "${bookmark.label}"`);
            rename.title = 'Rename';
            rename.append(icon('edit'));
            rename.addEventListener('click', () => renderBookmarks(bookmark.id));
            const remove = make('button', 'icon-button');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Delete the bookmark "${bookmark.label}"`);
            remove.title = 'Delete';
            remove.append(icon('delete'));
            remove.addEventListener('click', () => {
                confirmInSheet(`Delete the bookmark "${bookmark.label}"?`, 'Delete', () => {
                    state.bookmarks[key] = state.bookmarks[key].filter((other) => other.id !== bookmark.id);
                    persist();
                }, renderBookmarks);
            });
            item.append(go, rename, remove);
        }
        list.append(item);
    }
    nodes.push(list);
    sheetBody.replaceChildren(...nodes);
}


// Ask for confirmation in the sheet - onConfirm runs on the action button, then onDone (also on cancel)
function confirmInSheet(message, actionLabel, onConfirm, onDone, title = sheetTitle.textContent) {
    sheetTitle.textContent = title;
    const cancel = make('button', 'button', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', onDone);
    const action = make('button', 'button primary', actionLabel);
    action.type = 'button';
    action.addEventListener('click', () => {
        onConfirm();
        onDone();
    });
    const buttons = make('div', 'confirm-buttons');
    buttons.append(cancel, action);
    sheetBody.replaceChildren(make('p', 'confirm-message', message), buttons);
    action.focus();
}


// Bookmark the current sentence
function addBookmark() {
    const engineState = engine.state();
    const chapter = chapterAt(engineState.char);
    const snippet = engineState.sentence.length > 100 ? `${engineState.sentence.slice(0, 97)}...` : engineState.sentence;
    const bookmarks = state.bookmarks[current.key] || [];
    if (bookmarks.some((bookmark) => bookmark.char === engineState.sentenceChar)) {
        return;
    }
    const bookmark = {
        'id': newId(), 'char': engineState.sentenceChar, 'percent': engineState.percent, snippet,
        'label': chapter === null ? snippet : chapter.title, 'created': Date.now()
    };
    state.bookmarks[current.key] = [...bookmarks, bookmark];
    persist();
    renderBookmarks(bookmark.id);
}


// The offered speed nearest a speed (a speed the app no longer offers - 1.4x, say - becomes its nearest)
function nearestSpeed(rate) {
    return speeds.reduce((best, speed) => (Math.abs(speed - rate) < Math.abs(best - rate) ? speed : best));
}


// The open book's narrator - the listener's voice and speed for it (if still offered), or its defaults
function narrator() {
    const book = state.books[current.key];
    const voice = voiceChoices.some(({value}) => value === book.voice) ? book.voice : (current.defaultVoice ?? fallbackVoice);
    return {voice, 'rate': typeof book.rate === 'number' ? nearestSpeed(book.rate) : defaultRate, 'expressive': state.expressive !== false};
}


// The settings sheet - the open book's narrator (its voice and speed), the book's defaults unless the listener chose
// others
function renderSettings() {
    sheetTitle.textContent = 'Narrator';
    if (current === null) {
        sheetBody.replaceChildren();
        return;
    }
    const choice = (title, options, selected, onSelect) => {
        const section = make('section', 'setting');
        section.append(make('h3', '', title));
        const tabs = make('div', 'tabs');
        tabs.setAttribute('role', 'radiogroup');
        tabs.setAttribute('aria-label', title);
        for (const [value, label] of options) {
            const button = make('button', '', label);
            button.type = 'button';
            button.setAttribute('role', 'radio');
            button.setAttribute('aria-selected', String(value === selected));
            button.setAttribute('aria-checked', String(value === selected));
            button.addEventListener('click', () => onSelect(value));
            tabs.append(button);
        }
        section.append(tabs);
        return section;
    };
    const book = state.books[current.key];
    const defaults = {'voice': current.defaultVoice ?? fallbackVoice, 'rate': defaultRate};
    const defaultLabel = voiceChoices.find(({value}) => value === defaults.voice).label;

    // A choice for the book - the book's default is no choice
    const apply = (settings) => {
        for (const [name, value] of Object.entries(settings)) {
            if (value === defaults[name]) {
                delete book[name];
            } else {
                book[name] = value;
            }
        }
        persist();
        engine.setVoice(narrator());
        renderSettings();
    };
    const {voice, rate} = narrator();

    // The voice - a list by sex, with the voice's description
    const voiceSetting = () => {
        const section = make('section', 'setting');
        section.append(make('h3', '', 'Voice'));
        const select = make('select', 'voice-select');
        select.setAttribute('aria-label', 'Voice');
        for (const [sex, label] of [['female', 'Female voices'], ['male', 'Male voices']]) {
            const group = document.createElement('optgroup');
            group.label = label;
            for (const item of voiceChoices.filter((choiceItem) => choiceItem.sex === sex)) {
                const option = make('option', '', item.value === defaults.voice ? `${item.label} (default)` : item.label);
                option.value = item.value;
                option.selected = item.value === voice;
                group.append(option);
            }
            select.append(group);
        }
        select.addEventListener('change', () => apply({'voice': select.value}));
        section.append(select);
        const selected = voiceChoices.find((item) => item.value === voice);
        section.append(make('p', 'muted', selected.description));
        return section;
    };

    // Reset - the book's default narrator
    const resetSetting = () => {
        const section = make('section', 'setting reset-setting');
        const changed = book.voice !== undefined || book.rate !== undefined;
        section.append(make('p', 'muted', changed ?
            `This book's default narrator is ${defaultLabel} at ${defaults.rate}×.` :
            `${defaultLabel} at ${defaults.rate}× - the narrator chosen for this book.`));
        if (changed) {
            const button = make('button', 'button', 'Reset to default');
            button.type = 'button';
            button.addEventListener('click', () => apply(defaults));
            section.append(button);
        }
        return section;
    };
    const note = make('p', 'muted', 'The voices are synthesized in your browser - no recordings. A small neural network, ' +
        'trained on 53 hours of 237 American audiobook readers, drives a model of the human voice.');
    // Expressive dialogue - a listener's preference for every book (on by default)
    const expressive = choice('Expressive dialogue', [[false, 'Off'], [true, 'On']], state.expressive !== false, (value) => {
        state.expressive = value;
        persist();
        engine.setVoice(narrator());
        renderSettings();
    });
    expressive.append(make('p', 'muted', 'Dialogue is read a little livelier than the narration, and each paragraph ' +
        'shaped as a narrator reads it.'));
    sheetBody.replaceChildren(
        voiceSetting(),
        choice('Speed', speeds.map((speed) => [speed, `${speed}×`]), rate, (value) => apply({'rate': value})),
        resetSetting(),
        expressive,
        note
    );
}


// The lock screen and media keys
let mediaHandlersSet = false;
let mediaKey = '';
function updateMediaSession() {
    if (!('mediaSession' in navigator) || current === null) {
        return;
    }
    if (!mediaHandlersSet) {
        mediaHandlersSet = true;
        const handlers = {
            'play': () => engine.play(), 'pause': () => engine.pause(), 'seekbackward': () => skip(-skipSeconds),
            'seekforward': () => skip(skipSeconds), 'previoustrack': () => skip(-skipSeconds), 'nexttrack': () => skip(skipSeconds)
        };
        for (const [action, handler] of Object.entries(handlers)) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch {
                // An unsupported action
            }
        }
    }
    const book = state.books[current.key];
    const chapter = engine.loaded && !current.loading ? chapterAt(engine.state().char) : null;
    const key = `${current.key}|${chapter === null ? '' : chapter.title}`;
    if (key !== mediaKey && typeof MediaMetadata !== 'undefined') {
        mediaKey = key;
        navigator.mediaSession.metadata = new MediaMetadata({
            'title': chapter === null ? book.title : chapter.title, 'artist': book.author,
            'album': book.title, 'artwork': book.cover ? [{'src': book.cover, 'sizes': '512x768', 'type': 'image/jpeg'}] : []
        });
    }
    navigator.mediaSession.playbackState = isPlayingOrStarting() ? 'playing' : 'paused';
}


// Wire up the controls
element('toLibrary').addEventListener('click', () => {
    if (history.state?.view === 'player') {
        history.back();
    } else {
        showLibrary();
    }
});
window.addEventListener('popstate', () => {
    if (!playerView.hidden) {
        showLibrary();
    }
});
playPauseButton.addEventListener('click', togglePlay);
element('skipBack').addEventListener('click', () => skip(-skipSeconds));
element('skipForward').addEventListener('click', () => skip(skipSeconds));
sectionBackButton.addEventListener('click', () => skipSection(-1));
sectionForwardButton.addEventListener('click', () => skipSection(1));
element('shareButton').addEventListener('click', () => openSheet('share'));
window.addEventListener('hashchange', () => {
    openLink(window.location.hash);
});
element('contentsButton').addEventListener('click', () => openSheet('contents'));
element('bookmarksButton').addEventListener('click', () => openSheet('bookmarks'));
element('settingsButton').addEventListener('click', () => openSheet('settings'));
element('sheetClose').addEventListener('click', closeSheet);
sheet.addEventListener('close', () => {
    openSheetName = null;
});
sheet.addEventListener('click', (event) => {
    // A click on the backdrop closes the sheet
    if (event.target === sheet) {
        closeSheet();
    }
});
searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    searchInput.blur();
    browse(searchInput.value.trim(), 1);
});
let searchTimer = null;
searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    // (Wikipedia's search is a request a query - it waits for a pause in the typing)
    searchTimer = setTimeout(() => browse(searchInput.value.trim(), 1), state.scope === 'wikipedia' ? 500 : 150);
});
moreButton.addEventListener('click', () => browse(browseState.query, browseState.page + 1));
document.addEventListener('keydown', (event) => {
    if (sheet.open || event.target.closest('input, textarea, button[role="tab"]') || event.metaKey || event.ctrlKey || event.altKey) {
        return;
    }
    if (event.key === ' ' && current !== null && event.target === document.body) {
        event.preventDefault();
        togglePlay();
    } else if (event.key === 'ArrowLeft' && !playerView.hidden) {
        skip(-skipSeconds);
    } else if (event.key === 'ArrowRight' && !playerView.hidden) {
        skip(skipSeconds);
    }
});

// Keep the place when the page is hidden or closed
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        savePosition(true);
    }
});
window.addEventListener('pagehide', () => savePosition(true));

// Refresh the player and mini player, and remember the place, as playback moves
setInterval(() => {
    renderPlayer();
    updateAddress();
    if (!miniPlayer.hidden) {
        renderMiniPlayer();
    }
    if (current !== null && isPlayingOrStarting()) {
        savePosition(false);
    }
}, 250);


// Start - the library, or the player where the listener left off (paused - audio needs a tap to start)
browse('', 1);
catalogPromise.then((loaded) => {
    catalog = loaded;
    renderLibrary();
}, (error) => {
    browseState.error = error.message;
    renderResults();
});
const resumeBook = state.current === null ? undefined : state.books[state.current];
const startHash = window.location.hash;
if (linkBook(decodeHash(startHash).book ?? '') !== null) {
    // A link - its book, at its section
    history.replaceState({'view': 'library'}, '', `${window.location.pathname}${window.location.search}`);
    openLink(startHash).then((opened) => {
        if (!opened) {
            showLibrary();
        }
    });
} else if (resumeBook !== undefined && state.view === 'player') {
    history.replaceState({'view': 'library'}, '');
    openBook(resumeBook, {'play': false, 'show': true});
} else {
    showLibrary();
    if (resumeBook !== undefined) {
        openBook(resumeBook, {'play': false, 'show': false});
    }
}
