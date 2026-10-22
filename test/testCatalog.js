import {
    authorSortKey, bookAuthors, findBook, groupByAuthor, groupByGenre, listBooks, matchBooks, normalizeText, pageItems, searchBooks
} from '../lib/catalog.js';
import {strict as assert} from 'node:assert';
import test from 'node:test';


// A small catalog - two sources (and a book from a source not in the catalog's sources)
function testCatalog() {
    return {
        'version': 1,
        'sources': {
            'gutenberg': {'name': 'Project Gutenberg'},
            'standardebooks': {'name': 'Standard Ebooks'}
        },
        'genres': {'fiction': 'Fiction', 'adventure': 'Adventure'},
        'books': [
            {'source': 'gutenberg', 'id': '11', 'title': 'Alice\'s Adventures in Wonderland', 'author': 'Lewis Carroll',
                'subjects': ['Fantasy fiction'], 'rank': 2, 'genres': ['fiction', 'adventure']},
            {'source': 'standardebooks', 'id': 'carroll', 'title': 'Through the Looking-Glass', 'subtitle': 'And What Alice Found There',
                'author': 'Lewis Carroll', 'subjects': ['Fantasy fiction'], 'rank': 2, 'genres': ['fiction']},
            {'source': 'gutenberg', 'id': '1342', 'title': 'Pride & Prejudice', 'author': 'Jane Austen',
                'subjects': ['Courtship', 'England -- Fiction'], 'rank': 1, 'genres': ['romance']},
            {'source': 'other', 'id': 'x', 'title': 'Beowulf', 'rank': 2},
            {'source': 'gutenberg', 'id': '84', 'title': 'Frankenstein', 'author': 'Mary Wollstonecraft Shelley', 'rank': 3}
        ]
    };
}


test('normalizeText', () => {
    assert.equal(normalizeText('Alice\'s Adventures'), 'alices adventures');
    assert.equal(normalizeText('Alice’s  Adventures'), 'alices adventures');
    assert.equal(normalizeText('Pride & Prejudice'), 'pride and prejudice');
    assert.equal(normalizeText('Les Misérables'), 'les miserables');
    assert.equal(normalizeText('Æsop’s Fables, Straße, Søren, Þór'), 'aesops fables strasse soren thor');
    assert.equal(normalizeText('  -- The Time-Machine! --  '), 'the time machine');
    assert.equal(normalizeText('...'), '');
});


test('listBooks', () => {
    const catalog = testCatalog();
    const ids = (books) => books.map((book) => book.id);

    // All sources - by rank, then source order (unknown sources last), then title
    assert.deepEqual(ids(listBooks(catalog)), ['1342', '11', 'carroll', 'x', '84']);
    assert.deepEqual(ids(listBooks(catalog, 'all')), ['1342', '11', 'carroll', 'x', '84']);

    // One source
    assert.deepEqual(ids(listBooks(catalog, 'gutenberg')), ['1342', '11', '84']);
    assert.deepEqual(ids(listBooks(catalog, 'none')), []);

    // Not sorted in place
    assert.equal(catalog.books[0].id, '11');

    // Same rank and source - by title; no sources
    const books = [
        {'source': 'a', 'id': '2', 'title': 'Zebra', 'rank': 1},
        {'source': 'a', 'id': '1', 'title': 'Apple', 'rank': 1}
    ];
    assert.deepEqual(ids(listBooks({books})), ['1', '2']);
});


test('searchBooks', () => {
    const catalog = testCatalog();
    const ids = (books) => books.map((book) => book.id);

    // Empty query lists the source's books
    assert.deepEqual(ids(searchBooks(catalog, '')), ['1342', '11', 'carroll', 'x', '84']);
    assert.deepEqual(ids(searchBooks(catalog, ' ! ', 'gutenberg')), ['1342', '11', '84']);

    // Word prefixes of title, subtitle, and author
    assert.deepEqual(ids(searchBooks(catalog, 'alice')), ['11', 'carroll']);
    assert.deepEqual(ids(searchBooks(catalog, 'Alice\'s')), ['11']);
    assert.deepEqual(ids(searchBooks(catalog, 'carr look')), ['carroll']);
    assert.deepEqual(ids(searchBooks(catalog, 'pride & prej')), ['1342']);
    assert.deepEqual(ids(searchBooks(catalog, 'alice', 'gutenberg')), ['11']);
    assert.deepEqual(ids(searchBooks(catalog, 'beowulf')), ['x']);

    // Subject matches after primary matches
    assert.deepEqual(ids(searchBooks(catalog, 'fiction')), ['1342', '11', 'carroll']);
    assert.deepEqual(ids(searchBooks(catalog, 'fantasy')), ['11', 'carroll']);
    assert.deepEqual(ids(searchBooks(catalog, 'jane court')), ['1342']);
    assert.deepEqual(ids(searchBooks(catalog, 'wonder')), ['11']);

    // Every word must match
    assert.deepEqual(ids(searchBooks(catalog, 'alice austen')), []);
    assert.deepEqual(ids(searchBooks(catalog, 'zzz')), []);
});


test('matchBooks', () => {
    const books = [
        {'title': 'Fantasy Stories', 'author': 'A'},
        {'title': 'Tales', 'author': 'B', 'subjects': ['Fantasy']}
    ];
    assert.deepEqual(matchBooks(books, 'fantasy'), books);
    assert.deepEqual(matchBooks([books[1], books[0]], 'fantasy'), [books[0], books[1]]);
    assert.equal(matchBooks(books, ''), books);

    // Cached words - a second search of the same book
    assert.deepEqual(matchBooks(books, 'tales'), [books[1]]);
    assert.deepEqual(matchBooks(books, 'ta'), [books[1]]);
});


test('bookAuthors', () => {
    assert.deepEqual(bookAuthors({'author': 'Lewis Carroll'}), ['Lewis Carroll']);
    assert.deepEqual(bookAuthors({'author': 'William Strunk , E. B. White,'}), ['William Strunk', 'E. B. White']);
    assert.deepEqual(bookAuthors({'author': ''}), ['Anonymous']);
    assert.deepEqual(bookAuthors({}), ['Anonymous']);
});


test('authorSortKey', () => {
    assert.equal(authorSortKey('Lewis Carroll'), 'carroll lewis');
    assert.equal(authorSortKey('Homer'), 'homer');
    assert.equal(authorSortKey('Ludwig van Beethoven'), 'van beethoven ludwig');
    assert.equal(authorSortKey('Alexis de Tocqueville'), 'de tocqueville alexis');
    assert.equal(authorSortKey('Martin Luther King Jr.'), 'king martin luther');
    assert.equal(authorSortKey('Henry VIII'), 'viii henry');
    assert.equal(authorSortKey('Henry III'), 'henry');
    assert.equal(authorSortKey('Jr'), 'jr');
    assert.equal(authorSortKey('de Gaulle'), 'de gaulle');
    assert.equal(authorSortKey('United States. Congress'), 'united states congress');
    assert.equal(authorSortKey('J. R. R. Tolkien'), 'tolkien j r r');
    assert.equal(authorSortKey(''), '');
});


test('groupByAuthor', () => {
    const books = [
        {'id': '1', 'author': 'Lewis Carroll'},
        {'id': '2', 'author': 'Jane Austen, Lewis Carroll'},
        {'id': '3'},
        {'id': '4', 'author': 'Jane Austen'},
        {'id': '5', 'author': 'Austen Jane'}
    ];
    const groups = groupByAuthor(books);
    assert.deepEqual(groups.map((group) => [group.name, group.books.map((book) => book.id)]), [
        ['Anonymous', ['3']],
        ['Jane Austen', ['2', '4']],
        ['Lewis Carroll', ['1', '2']],
        ['Austen Jane', ['5']]
    ]);
    assert.deepEqual(groupByAuthor([]), []);

    // Same sort key - by name
    const same = groupByAuthor([{'id': '1', 'author': 'Jane Áusten'}, {'id': '2', 'author': 'Jane Austen'}]);
    assert.deepEqual(same.map((group) => group.name), ['Jane Austen', 'Jane Áusten']);
});


test('groupByGenre', () => {
    const books = [
        {'id': '1', 'genres': ['fiction', 'adventure']},
        {'id': '2'},
        {'id': '3', 'genres': ['romance', 'fiction']}
    ];
    const groups = groupByGenre(books, {'fiction': 'Fiction', 'adventure': 'Adventure'});
    assert.deepEqual(groups.map((group) => [group.key, group.name, group.books.map((book) => book.id)]), [
        ['adventure', 'Adventure', ['1']],
        ['fiction', 'Fiction', ['1', '3']],
        ['romance', 'romance', ['3']]
    ]);
});


test('findBook', () => {
    const catalog = testCatalog();
    assert.equal(findBook(catalog, 'gutenberg', '84').title, 'Frankenstein');
    assert.equal(findBook(catalog, 'standardebooks', 'carroll').title, 'Through the Looking-Glass');
    assert.equal(findBook(catalog, 'standardebooks', '84'), null);
    assert.equal(findBook(catalog, 'gutenberg', 'missing'), null);
});


test('pageItems', () => {
    const items = Array.from({'length': 50}, (_value, ix) => ix);
    assert.deepEqual(pageItems(items), {
        'items': items.slice(0, 24), 'page': 1, 'pageCount': 3, 'total': 50, 'hasMore': true
    });
    assert.deepEqual(pageItems(items, 3), {
        'items': [48, 49], 'page': 3, 'pageCount': 3, 'total': 50, 'hasMore': false
    });
    assert.deepEqual(pageItems(items, 2.7, 10), {
        'items': [10, 11, 12, 13, 14, 15, 16, 17, 18, 19], 'page': 2, 'pageCount': 5, 'total': 50, 'hasMore': true
    });
    assert.equal(pageItems(items, 0).page, 1);
    assert.equal(pageItems(items, -5).page, 1);
    assert.equal(pageItems(items, Number.NaN).page, 1);
    assert.equal(pageItems(items, '2').page, 1);
    assert.deepEqual(pageItems(items, 9).items, []);
    assert.deepEqual(pageItems([], 1), {'items': [], 'page': 1, 'pageCount': 0, 'total': 0, 'hasMore': false});
});
