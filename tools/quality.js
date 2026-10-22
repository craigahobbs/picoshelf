// A Gutenberg text's quality for reading aloud - measured on its prepared text (lib/gutenberg.js prepareText, as the
// app reads it): too short or too long a book, scholarly apparatus (notes in brackets), stray markup, numbers inside
// words (ledgers, Middle English, scanning errors), mangled encoding, and tables. The thresholds were set on the
// catalog's 567 most popular Gutenberg texts - they reject the variorum editions, the annotated classics, the
// reference compilations, and the garbled texts (about 9%), not a play's bracketed stage directions or a memoir's
// ordinals ("2d", "6th").

// The rules' version - a cached quality is measured again when it changes
export const qualityVersion = 1;

// The reasons a text is rejected - each rule's test of the measures
const rules = [
    ['too short', (measures) => measures.words < 500],
    ['too long', (measures) => measures.words > 500000],
    ['notes', (measures) => measures.notes > 10],
    ['marks', (measures) => measures.marks > 5],
    ['numbers in words', (measures) => measures.numbers > 5],
    ['encoding', (measures) => measures.encoding > 0.1],
    ['tables', (measures) => measures.tables > 0.05]
];


// The words that start a bracketed note
const noteWords = '(?:Variant|Footnote|Sub-Footnote|Note|See|Greek|Transcriber)\\b|i\\.\\s?e\\.|cf\\.';


// Measure a prepared text - its words, and its problems (per 1,000 words, or tables' share of paragraphs)
export function measureText(text) {
    const words = (text.match(/\S+/g) ?? []).length;
    const perThousand = (regex) => 1000 * (text.match(regex) ?? []).length / Math.max(words, 1);
    const paragraphs = text.split('\n\n');
    return {
        words,
        // (bracketed notes - "[1", "[a]", "[See", "[Variant" - braces, pipes, and angle brackets; not stage directions)
        'notes': perThousand(new RegExp(`\\[(?:\\s*\\d|[a-z*†‡§]\\]|\\s*(?:${noteWords})|\\s*\\{)|[{}|<>]`, 'g')),
        'marks': perThousand(/[_*#~^]/g),
        // (not ordinals - "2d", "6th")
        'numbers': perThousand(/[A-Za-z]\d|\d(?!(?:st|nd|rd|th|d)\b)[A-Za-z]/g),
        'encoding': perThousand(/Ã|â€|Â|�/g),
        'tables': paragraphs.filter((paragraph) => /\S {3,}\S.* {3,}\S|\.{5,}/.test(paragraph) && paragraph.split('\n').length > 2).length /
            paragraphs.length
    };
}


// A prepared text's quality - {words, reasons (the rules it fails - none for a good text)}
export function textQuality(text) {
    const measures = measureText(text);
    return {'words': measures.words, 'reasons': rules.filter(([, test]) => test(measures)).map(([reason]) => reason)};
}
