import './toolsHelpers.js';
import {strict as assert} from 'node:assert';
import test from 'node:test';


// The tools - imported after toolsHelpers.js sets their cache directory
const {measureText, qualityVersion, textQuality} = await import('../tools/quality.js');


// A text of words
const words = (count, word = 'word') => `${word} `.repeat(count).trim();


test('qualityVersion', () => {
    assert.ok(Number.isInteger(qualityVersion) && qualityVersion > 0);
});


test('measureText', () => {
    assert.deepEqual(measureText(''), {'words': 0, 'notes': 0, 'marks': 0, 'numbers': 0, 'encoding': 0, 'tables': 0});
    assert.deepEqual(measureText(words(1000)), {'words': 1000, 'notes': 0, 'marks': 0, 'numbers': 0, 'encoding': 0, 'tables': 0});
});


test('measureText, notes', () => {
    // Bracketed notes, braces, pipes, and angle brackets - 19 in 50 words
    const notes = '[1] [ 2] [a] [*] [†] [See [ Variant [Footnote [Note [Greek [Transcriber [i.e. [i. e. [cf. {x} | <b>';
    assert.equal(measureText(`${notes} ${words(30)}`).notes, 1000 * 19 / 50);

    // Not stage directions, a bracketed word, or a note word without its bracket
    assert.equal(measureText(`[Exit Hamlet.] [Aside] [Seeing him] See Note ${words(46)}`).notes, 0);
});


test('measureText, marks', () => {
    assert.equal(measureText(`_italic_ *bold* #3 ~ ^ ${words(95)}`).marks, 1000 * 7 / 100);
});


test('measureText, numbers', () => {
    // Numbers inside words - not ordinals
    assert.equal(measureText(`A2 h3llo 4x 2d 6th 3rd 1st 2nd 22nd 1880s ${words(90)}`).numbers, 1000 * 4 / 100);
});


test('measureText, encoding', () => {
    assert.equal(measureText(`CafÃ© â€œquotedâ€ Â½ �? ${words(96)}`).encoding, 1000 * 5 / 100);
});


test('measureText, tables', () => {
    const paragraphs = [
        // A table - columns spaced apart, on more than two lines
        'Name     Age     Town\nAnn      30      Bath\nBob      40      York',
        // A table of contents - dot leaders
        'CONTENTS\nChapter I ........ 1\nChapter II ....... 9',
        // Not tables - two lines, one column, or verse indented
        'Name     Age     Town\nAnn      30      Bath',
        'A line\nanother line\nand a third',
        '    Indented verse\n    over three\n    lines'
    ];
    assert.equal(measureText(paragraphs.join('\n\n')).tables, 2 / 5);
});


test('textQuality', () => {
    // A good text
    assert.deepEqual(textQuality(words(1000)), {'words': 1000, 'reasons': []});

    // At the limits
    assert.deepEqual(textQuality(words(500)).reasons, []);
    assert.deepEqual(textQuality(`${words(990)} ${'[1] '.repeat(10)}`).reasons, []);
    assert.deepEqual(textQuality(`${words(995)} ${'*x '.repeat(5)}`).reasons, []);

    // Each rule
    assert.deepEqual(textQuality(words(499)), {'words': 499, 'reasons': ['too short']});
    assert.deepEqual(textQuality(words(500001, 'a')).reasons, ['too long']);
    assert.deepEqual(textQuality(`${words(989)} ${'[1] '.repeat(11)}`).reasons, ['notes']);
    assert.deepEqual(textQuality(`${words(994)} ${'*x '.repeat(6)}`).reasons, ['marks']);
    assert.deepEqual(textQuality(`${words(994)} ${'A2 '.repeat(6)}`).reasons, ['numbers in words']);
    assert.deepEqual(textQuality(`${words(999)} �`).reasons, ['encoding']);
    assert.deepEqual(
        textQuality(`${words(1000)}\n\n${'Ann      30      Bath\n'.repeat(3)}`).reasons, ['tables']
    );

    // Several rules
    assert.deepEqual(
        textQuality('[1] {x} _a_ A2 �'), {'words': 5, 'reasons': ['too short', 'notes', 'marks', 'numbers in words', 'encoding']}
    );
});
