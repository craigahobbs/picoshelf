// Project Gutenberg's catalog - its RDF records (rdf-files.tar.bz2, updated daily: every ebook's title, authors,
// subjects, bookshelves, files, downloads, and summary), read as Gutendex-style results (Gutendex is built from the same
// records): {id, title, authors: [{name}], subjects, bookshelves, languages, copyright, media_type, formats (by media
// type), summaries, download_count, text_bytes (the plain-text file's size, or null), wikipedia (the book's Wikipedia
// page - Project Gutenberg links a notable book's - or null)}
//
// The archive is read with the system tar (bzip2), its records streamed - about 75,000, 2 GB of XML.

import {spawn} from 'node:child_process';


// XML's entities
const xmlEntities = {'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': '\''};

// Decode XML text
function decodeXML(text) {
    return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-z]+));/g, (match, decimal, hex, name) => {
        if (decimal !== undefined) {
            return String.fromCodePoint(Number(decimal));
        }
        return hex === undefined ? (xmlEntities[name] ?? match) : String.fromCodePoint(parseInt(hex, 16));
    });
}


// The texts of an element's matches in XML (each decoded and trimmed)
function elementTexts(xml, regex) {
    return [...xml.matchAll(regex)].map((match) => decodeXML(match[1]).trim());
}


// The rdf:values of each block (a dcterms:subject, a pgterms:bookshelf, ...) in a vocabulary (memberOf), or any
const valueRegex = /<rdf:value[^>]*>([^<]*)<\/rdf:value>/;
const blockRegexes = new Map();
function blockValues(xml, tag, vocabulary = null) {
    if (!blockRegexes.has(tag)) {
        blockRegexes.set(tag, new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'));
    }
    const values = [];
    for (const [block] of xml.matchAll(blockRegexes.get(tag))) {
        if (vocabulary === null || block.includes(`rdf:resource="${vocabulary}"`)) {
            const value = valueRegex.exec(block);
            if (value !== null) {
                values.push(decodeXML(value[1]).trim());
            }
        }
    }
    return values;
}


// A Gutenberg RDF record as a Gutendex-style result, or null if it isn't an ebook's record
export function parseRecord(xml) {
    const idMatch = /<pgterms:ebook rdf:about="ebooks\/(\d+)">/.exec(xml);
    if (idMatch === null) {
        return null;
    }

    // The files - each one's media types (a file may have several - "text/plain; charset=utf-8" and its zip) and size
    const formats = {};
    let textBytes = null;
    for (const [file] of xml.matchAll(/<pgterms:file rdf:about="[^"]*">[\s\S]*?<\/pgterms:file>/g)) {
        const url = decodeXML(/rdf:about="([^"]*)"/.exec(file)[1]);
        const extent = Number(/<dcterms:extent[^>]*>(\d+)</.exec(file)?.[1] ?? 0);
        for (const type of blockValues(file, 'dcterms:format')) {
            // (as Gutendex - the first file of each type, but the medium cover for image/jpeg)
            if (!(type in formats) || (type === 'image/jpeg' && url.endsWith('.cover.medium.jpg'))) {
                formats[type] = url;
            }
            if (type.startsWith('text/plain') && !url.endsWith('.zip')) {
                textBytes = Math.max(textBytes ?? 0, extent);
            }
        }
    }

    const rights = elementTexts(xml, /<dcterms:rights>([^<]*)<\/dcterms:rights>/g)[0] ?? '';
    const creators = [...xml.matchAll(/<dcterms:creator>[\s\S]*?<\/dcterms:creator>/g)].map(([creator]) => creator);
    return {
        'id': Number(idMatch[1]),
        'title': elementTexts(xml, /<dcterms:title>([^<]*)<\/dcterms:title>/g)[0] ?? '',
        'authors': creators.flatMap((creator) => elementTexts(creator, /<pgterms:name>([^<]*)<\/pgterms:name>/g)).
            map((name) => ({name})),
        'subjects': blockValues(xml, 'dcterms:subject', 'http://purl.org/dc/terms/LCSH').sort(),
        'bookshelves': blockValues(xml, 'pgterms:bookshelf').sort(),
        'languages': blockValues(xml, 'dcterms:language'),
        'copyright': rights.startsWith('Copyrighted') ? true : (rights.startsWith('Public domain') ? false : null),
        'media_type': blockValues(xml, 'dcterms:type')[0] ?? null,
        formats,
        'summaries': elementTexts(xml, /<pgterms:marc520>([^<]*)<\/pgterms:marc520>/g),
        'download_count': Number(/<pgterms:downloads[^>]*>(\d+)</.exec(xml)?.[1] ?? 0),
        'text_bytes': textBytes,
        'wikipedia': elementTexts(xml, /<dcterms:description>([^<]*)<\/dcterms:description>/g).
            map((description) => /^Wikipedia page about this book: (\S+)/.exec(description)?.[1]).find((url) => url !== undefined) ?? null
    };
}


// The records of the RDF archive (a tar.bz2 file), each parsed (parseRecord) - spawn runs tar (replaceable for tests)
export async function readArchive(archivePath, spawnTar = (args) => spawn('tar', args, {'stdio': ['ignore', 'pipe', 'pipe']})) {
    const tar = spawnTar(['-xOjf', archivePath]);
    // (its exit code once its output is read - its close, after its stdout and stderr end)
    const closed = new Promise((resolve) => {
        tar.on('close', resolve);
    });
    const records = [];
    let errors = '';
    tar.stderr.setEncoding('utf-8');
    tar.stderr.on('data', (text) => {
        errors += text;
    });

    // The files' contents are concatenated - each record starts with its XML declaration
    let pending = '';
    const takeRecords = (final) => {
        const starts = [...pending.matchAll(/<\?xml /g)].map((match) => match.index);
        const complete = final ? starts.length : starts.length - 1;
        for (let ix = 0; ix < complete; ix++) {
            const record = parseRecord(pending.slice(starts[ix], starts[ix + 1]));
            if (record !== null) {
                // (a copy - the record's strings are slices of the stream's text, which they would keep in memory)
                records.push(JSON.parse(JSON.stringify(record)));
            }
        }
        if (final) {
            pending = '';
        } else if (complete > 0) {
            pending = pending.slice(starts[complete]);
        }
    };
    tar.stdout.setEncoding('utf-8');
    for await (const chunk of tar.stdout) {
        pending += chunk;
        takeRecords(false);
    }
    takeRecords(true);
    const code = await closed;
    if (code !== 0) {
        throw new Error(`tar ${archivePath}: ${errors.trim() || `exit ${code}`}`);
    }
    return records;
}
