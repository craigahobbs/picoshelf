import {loadState, newId, saveState} from '../lib/store.js';
import {strict as assert} from 'node:assert';
import test from 'node:test';


// A fake localStorage - its items, optionally failing every access
function setStorage({items = {}, fail = false} = {}) {
    const storage = {
        'items': {...items},
        'getItem': (key) => {
            if (fail) {
                throw new Error('SecurityError');
            }
            return key in storage.items ? storage.items[key] : null;
        },
        'setItem': (key, value) => {
            if (fail) {
                throw new Error('QuotaExceededError');
            }
            storage.items[key] = String(value);
        }
    };
    Object.defineProperty(globalThis, 'localStorage', {'value': storage, 'configurable': true, 'writable': true});
    return storage;
}


const storageKey = 'gutenberg-audiobooks-v1';
const defaultState = {'current': null, 'view': 'library', 'books': {}, 'bookmarks': {}};


test('loadState, empty storage', () => {
    setStorage();
    const state = loadState();
    assert.deepEqual(state, defaultState);

    // Each default state is a fresh copy
    state.books.abc = {'title': 'Moby-Dick'};
    assert.deepEqual(loadState(), defaultState);
});


test('loadState, saved state', () => {
    const saved = {
        'current': 'abc',
        'view': 'player',
        'books': {'abc': {'title': 'Moby-Dick', 'position': 12}},
        'bookmarks': {'abc': [{'id': 'x', 'position': 3}]},
        'extra': 1
    };
    setStorage({'items': {[storageKey]: JSON.stringify(saved)}});
    assert.deepEqual(loadState(), saved);
});


test('loadState, saved state missing fields', () => {
    setStorage({'items': {[storageKey]: JSON.stringify({'current': 'abc', 'books': null})}});
    assert.deepEqual(loadState(), {'current': 'abc', 'view': 'library', 'books': {}, 'bookmarks': {}});
});


test('loadState, saved non-object', () => {
    setStorage({'items': {[storageKey]: '5'}});
    assert.deepEqual(loadState(), defaultState);
});


test('loadState, corrupt storage', () => {
    setStorage({'items': {[storageKey]: '{not json'}});
    assert.deepEqual(loadState(), defaultState);
});


test('loadState, storage unavailable', () => {
    setStorage({'fail': true});
    assert.deepEqual(loadState(), defaultState);
});


test('saveState', () => {
    const storage = setStorage();
    const state = {...defaultState, 'current': 'abc', 'books': {'abc': {'position': 5}}};
    assert.equal(saveState(state), true);
    assert.deepEqual(JSON.parse(storage.items[storageKey]), state);
    assert.deepEqual(loadState(), state);
});


test('saveState, storage unavailable', () => {
    setStorage({'fail': true});
    assert.equal(saveState(defaultState), false);
});


test('newId', () => {
    const id = newId();
    assert.match(id, /^[0-9a-z]{9,15}$/);
    assert.notEqual(newId(), id);
});
