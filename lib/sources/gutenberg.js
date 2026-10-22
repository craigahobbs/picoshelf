// The Project Gutenberg source - read a catalog book's plain text for reading aloud
//
// gutenberg.org doesn't send CORS headers, so the text (the catalog's book.text.url) is fetched from the GITenberg
// mirror on GitHub (raw.githubusercontent.com sends Access-Control-Allow-Origin: *), decoded with the catalog's
// book.text.encoding, and prepared for reading aloud (lib/gutenberg.js): no license boilerplate, no table of contents
// or markup, paragraphs unwrapped, and chapter headings found and listed.

import {decodeText, prepareText} from '../gutenberg.js';
import {fetchResponse, readBody} from './download.js';


// Error messages
const errorOffline = 'Couldn\'t download the book - check your connection and try again.';
const errorUnavailable = 'This book isn\'t available from GITenberg, the Project Gutenberg mirror this app reads.';


// The source
export const source = {
    'id': 'gutenberg',
    load
};


// A catalog book's text for reading aloud and display - {text, chapters, title, author}; onProgress(loadedBytes,
// totalBytes or null) while downloading
async function load(book, onProgress) {
    const url = book?.text?.url;
    if (!url) {
        throw new Error(errorUnavailable);
    }
    const response = await fetchResponse(url, {}, errorOffline);
    if (response.status === 404) {
        throw new Error(errorUnavailable);
    }
    if (!response.ok) {
        throw new Error(`The book couldn't be downloaded (error ${response.status}) - try again later.`);
    }

    // The total is unknown for a cross-origin response - GitHub compresses text, so its Content-Length is the compressed
    // size (and its Content-Encoding is hidden)
    const isLengthKnown = response.type !== 'cors' || response.headers.get('Content-Encoding') === 'identity';
    const bytes = await readBody(response, onProgress, errorOffline, isLengthKnown);
    return prepareText(decodeText(bytes, book.text.encoding ?? 'utf-8'), book);
}
