// The book catalog (data/catalog.json) - listing, search, and grouping. Pure functions over the parsed catalog:
//
//   {'version': 1, 'generated': '<ISO time>', 'sources': {'<sourceId>': {'name', 'url', 'description'}, ...},
//    'genres': {'<genre>': '<name>', ...},
//    'books': [{'source', 'id', 'title', 'subtitle'?, 'author', 'description', 'subjects', 'language', 'cover',
//               'rank', 'words', 'text': {'url', 'format', 'encoding'?}, 'voice', 'genres'}, ...]}


// Letters that Unicode normalization (NFD) doesn't decompose to ASCII
const letterFolds = {
    'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'ı': 'i', 'ŋ': 'n'
};
const letterFoldRegex = new RegExp(`[${Object.keys(letterFolds).join('')}]`, 'g');


// Text normalized for searching and comparison - lowercase, without accents, apostrophes removed ("Alice's" is
// "alices"), "&" as "and", and other punctuation as word breaks, with single spaces between words
export function normalizeText(text) {
    return text.normalize('NFD').toLowerCase()
        .replace(/[̀-ͯ]/g, '')
        .replace(letterFoldRegex, (letter) => letterFolds[letter])
        .replace(/['’ʼ‘`]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}


// A book's normalized search words - title, subtitle, and author words, and subject words (cached per book)
const bookWordsCache = new WeakMap();
function bookWords(book) {
    let words = bookWordsCache.get(book);
    if (words === undefined) {
        // (no words is [''], which no query word starts)
        const splitWords = (text) => normalizeText(text).split(' ');
        words = {
            'primary': splitWords([book.title, book.subtitle ?? '', book.author].join(' ')),
            'subjects': splitWords((book.subjects ?? []).join(' '))
        };
        bookWordsCache.set(book, words);
    }
    return words;
}


// Does any of the words start with the query word?
function wordsMatch(words, queryWord) {
    return words.some((word) => word.startsWith(queryWord));
}


// Compare books by rank, then by the catalog order of their sources, then by title
function compareRank(catalog) {
    const sourceIds = Object.keys(catalog.sources ?? {});
    const sourceOrder = (book) => {
        const index = sourceIds.indexOf(book.source);
        return index === -1 ? sourceIds.length : index;
    };
    return (book1, book2) => (book1.rank - book2.rank) || (sourceOrder(book1) - sourceOrder(book2)) ||
        book1.title.localeCompare(book2.title);
}


// The catalog's books by popularity rank - every source's books interleaved by rank (the most popular book of each
// source, then the second of each source, and so on)
export function listBooks(catalog) {
    return [...catalog.books].sort(compareRank(catalog));
}


// The books matching a query by title, subtitle, author, and subjects - every query word must start a word of the book's
// text. Books matched by title, subtitle, and author come first, then books that needed their subjects to match, each in
// the books' order. An empty query matches every book.
export function matchBooks(books, query) {
    const normalQuery = normalizeText(query);
    if (normalQuery === '') {
        return books;
    }
    const queryWords = normalQuery.split(' ');
    const primaryMatches = [];
    const subjectMatches = [];
    for (const book of books) {
        const words = bookWords(book);
        const unmatched = queryWords.filter((queryWord) => !wordsMatch(words.primary, queryWord));
        if (unmatched.length === 0) {
            primaryMatches.push(book);
        } else if (unmatched.every((queryWord) => wordsMatch(words.subjects, queryWord))) {
            subjectMatches.push(book);
        }
    }
    return [...primaryMatches, ...subjectMatches];
}


// A book's authors - its author names (comma-separated in the catalog), or "Anonymous"
export function bookAuthors(book) {
    const authors = (book.author ?? '').split(/\s*,\s*/).filter((name) => name !== '');
    return authors.length === 0 ? ['Anonymous'] : authors;
}


// An author's sort key - the surname (the last name, with its particles - de, van, du, ... - and without a suffix - Jr.,
// III, abbé), then the given names; an organization's name (a period after a word, not an initial - "United States.
// Congress") as it is
const surnameParticles = new Set(['de', 'del', 'della', 'di', 'da', 'du', 'des', 'la', 'le', 'van', 'von', 'der', 'den', 'ten', 'st']);
const nameSuffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'abbe']);
export function authorSortKey(name) {
    if (/\p{L}{5,}\.\s/u.test(name)) {
        return normalizeText(name);
    }
    const words = normalizeText(name).split(' ');
    while (words.length > 1 && nameSuffixes.has(words[words.length - 1])) {
        words.pop();
    }
    let start = words.length - 1;
    while (start > 0 && surnameParticles.has(words[start - 1])) {
        start--;
    }
    return `${words.slice(start).join(' ')} ${words.slice(0, start).join(' ')}`.trim();
}


// The books by author - [{name, books}] by surname (a book with several authors is in each one's group), each group's
// books in the books' order
export function groupByAuthor(books) {
    const groups = new Map();
    for (const book of books) {
        for (const name of bookAuthors(book)) {
            if (!groups.has(name)) {
                groups.set(name, {name, 'books': []});
            }
            groups.get(name).books.push(book);
        }
    }
    const sortKeys = new Map([...groups.keys()].map((name) => [name, authorSortKey(name)]));
    return [...groups.values()].sort((first, second) =>
        sortKeys.get(first.name).localeCompare(sortKeys.get(second.name)) || first.name.localeCompare(second.name));
}


// The books by genre - [{key, name, books}] by name (genres - the catalog's genre names by key; a book is in each of
// its genres' groups), each group's books in the books' order
export function groupByGenre(books, genres) {
    const groups = new Map();
    for (const book of books) {
        for (const key of book.genres ?? []) {
            if (!groups.has(key)) {
                groups.set(key, {key, 'name': genres[key] ?? key, 'books': []});
            }
            groups.get(key).books.push(book);
        }
    }
    return [...groups.values()].sort((first, second) => first.name.localeCompare(second.name));
}


// A book by its source and id, or null if it isn't in the catalog
export function findBook(catalog, source, id) {
    return catalog.books.find((book) => book.source === source && book.id === id) ?? null;
}

