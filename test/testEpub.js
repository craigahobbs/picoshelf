import {convertEpub, isEpubTextEntry} from '../lib/epub.js';
import {JSDOM} from 'jsdom';
import {strict as assert} from 'node:assert';
import {openZip} from '../lib/zip.js';
import test from 'node:test';


// epub.js parses XML with the global DOMParser - jsdom's
globalThis.DOMParser = new JSDOM('').window.DOMParser;


// Write a ZIP file of stored entries - files is an object of name to text - returns the ZIP's bytes
function writeZip(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [nameText, dataText] of Object.entries(files)) {
        const name = encoder.encode(nameText);
        const data = encoder.encode(dataText);
        const local = new Uint8Array(30);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint32(18, data.length, true);
        localView.setUint32(22, data.length, true);
        localView.setUint16(26, name.length, true);
        parts.push(local, name, data);
        const header = new Uint8Array(46);
        const headerView = new DataView(header.buffer);
        headerView.setUint32(0, 0x02014b50, true);
        headerView.setUint32(20, data.length, true);
        headerView.setUint32(24, data.length, true);
        headerView.setUint16(28, name.length, true);
        headerView.setUint32(42, offset, true);
        central.push(header, name);
        offset += 30 + name.length + data.length;
    }
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(10, central.length / 2, true);
    endView.setUint32(12, central.reduce((total, part) => total + part.length, 0), true);
    endView.setUint32(16, offset, true);
    const all = [...parts, ...central, end];
    const bytes = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
    let pos = 0;
    for (const part of all) {
        bytes.set(part, pos);
        pos += part.length;
    }
    return bytes;
}


// An EPUB zip reader - the container (naming epub/content.opf) and files
function epubZip(files) {
    return openZip(writeZip({
        'META-INF/container.xml': '<?xml version="1.0"?>\n<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" ' +
            'version="1.0"><rootfiles><rootfile full-path="epub/content.opf" media-type="application/oebps-package+xml"/>' +
            '</rootfiles></container>',
        ...files
    }));
}


// An OPF package document
function opf(metadata, manifest, spine) {
    return '<?xml version="1.0"?>\n<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
        `version="3.0"><metadata>${metadata}</metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
}


// An XHTML document
function xhtml(body) {
    return '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" ' +
        `xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Ignored</title></head>${body}</html>`;
}


test('isEpubTextEntry', () => {
    assert.equal(isEpubTextEntry('epub/text/chapter-1.xhtml'), true);
    assert.equal(isEpubTextEntry('OEBPS/chapter.HTML'), true);
    assert.equal(isEpubTextEntry('index.htm'), true);
    assert.equal(isEpubTextEntry('META-INF/container.xml'), true);
    assert.equal(isEpubTextEntry('epub/content.opf'), true);
    assert.equal(isEpubTextEntry('toc.ncx'), true);
    assert.equal(isEpubTextEntry('epub/images/cover.jpg'), false);
    assert.equal(isEpubTextEntry('epub/css/core.css'), false);
    assert.equal(isEpubTextEntry('epub/fonts/font.otf'), false);
    assert.equal(isEpubTextEntry('mimetype'), false);
});


test('convertEpub, Standard Ebooks', async () => {
    const metadata = '<dc:title id="title">The   Book</dc:title>' +
        '<meta property="title-type" refines="#title">main</meta>' +
        '<dc:title id="subtitle">A Story</dc:title>' +
        '<meta property="title-type" refines="#subtitle">subtitle</meta>' +
        '<meta property="file-as" refines="#subtitle">Story, A</meta>' +
        '<meta property="se:word-count">1000</meta>' +
        '<dc:creator id="author">Jane\n  Doe</dc:creator>' +
        '<dc:creator>John Roe</dc:creator>' +
        '<dc:creator> </dc:creator>';
    const manifest = '<item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
        '<item id="titlepage" href="text/titlepage.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="preface" href="text/preface.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="part-1" href="text/part-1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="chapter-1" href="text/chapter%201.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="play" href="./text/../text/play.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="broken" href="text/broken.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="rootless" href="text/rootless.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="colophon" href="text/colophon.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="css" href="css/core.css" media-type="text/css"/>' +
        '<item id="untyped" href="text/untyped.xhtml"/>';
    const spine = '<itemref idref="titlepage"/><itemref idref="preface"/><itemref idref="part-1"/><itemref idref="chapter-1"/>' +
        '<itemref idref="play"/><itemref idref="broken"/><itemref idref="rootless"/><itemref idref="css"/>' +
        '<itemref idref="untyped"/><itemref idref="missing"/><itemref idref="toc" linear="no"/><itemref idref="colophon"/>';
    const zip = epubZip({
        'epub/content.opf': opf(metadata, manifest, spine),
        'epub/toc.xhtml': xhtml(
            '<body><nav epub:type="landmarks"><ol><li><a href="text/part-1.xhtml">Landmark</a></li></ol></nav>' +
            '<nav epub:type="toc"><ol>' +
            '<li><a href="text/preface.xhtml">Preface.</a></li>' +
            '<li><a href="text/preface.xhtml">Duplicate</a></li>' +
            '<li><a href="text/part-1.xhtml#part-1">Part I</a></li>' +
            '<li><a href="text/chapter%201.xhtml#chapter-1-1">Chapter 1</a></li>' +
            '<li><a href="text/chapter%201.xhtml#chapter-1-2">The Second­ Chapter</a></li>' +
            '<li><a>No Link</a></li>' +
            '<li><a href="text/play.xhtml"> </a></li>' +
            '</ol></nav></body>'
        ),
        'epub/text/titlepage.xhtml': xhtml(
            '<body epub:type="frontmatter"><section id="titlepage" epub:type="titlepage"><h1>The Book</h1></section></body>'
        ),
        'epub/text/preface.xhtml': xhtml(
            '<body epub:type="frontmatter"><section id="preface" epub:type="preface"><p>Some   preface\ntext.</p></section></body>'
        ),
        'epub/text/part-1.xhtml': xhtml(
            '<body epub:type="bodymatter z3998:fiction"><section id="part-1" epub:type="part">' +
            '<h2 epub:type="z3998:ordinal">I</h2></section></body>'
        ),
        'epub/text/chapter 1.xhtml': xhtml(
            '<body epub:type="bodymatter z3998:fiction">' +
            '<section id="chapter-1-1" data-parent="part-1" epub:type="chapter">' +
            '<hgroup><h3 epub:type="z3998:ordinal">I</h3>' +
            '<p epub:type="title">The Start<a href="endnotes.xhtml#note-1" id="noteref-1" epub:type="noteref">1</a></p>' +
            '<p epub:type="subtitle">In Which Things Begin</p></hgroup>' +
            '<p>It was a dark night.<br/>\n  A second line.</p>' +
            '<p>Note<a role="doc-noteref">2</a> here. <img alt="An image"/><span hidden="hidden">Hidden.</span> ' +
            '<i>italic</i> word space⁠.<!-- comment --><![CDATA[ More & more.]]></p>' +
            '<aside epub:type="endnote"><p>Skipped note.</p></aside>' +
            '<blockquote><p>A quote.</p></blockquote>' +
            '</section>' +
            '<section id="chapter-1-2" data-parent="part-1" epub:type="chapter">' +
            '<header><p>Epigraph</p><p>Really?</p></header><p>Text two.</p></section>' +
            '<section id="chapter-1-3" epub:type="chapter"><header><h2>What Is <abbr>Man</abbr>?</h2></header></section>' +
            '</body>'
        ),
        'epub/text/play.xhtml': xhtml(
            '<body><article id="scene" data-parent="unknown" epub:type="z3998:scene">' +
            '<h3>Scene <b>1</b></h3>' +
            '<h4><img alt="Ornament"/></h4>' +
            '<h4 role="doc-subtitle">A Castle</h4>' +
            '<table><tbody>' +
            '<tr><td epub:type="z3998:persona">Hamlet</td><td>To be, or not to be.</td></tr>' +
            '<tr><td epub:type="z3998:persona">Horatio</td><td><p>Line one,</p><p>Line two.</p></td></tr>' +
            '<tr><td>Stage,</td><td>direction</td></tr>' +
            '<tr><td>Enter</td><td><i>Ghost</i></td></tr>' +
            '<tr><td epub:type="z3998:persona"> </td><td><p>Nobody</p></td></tr>' +
            '</tbody></table>' +
            '</article>' +
            '<section epub:type="chapter"><h2><span epub:type="se:label">Book</span> <span epub:type="z3998:ordinal">II</span>' +
            '<br/><span epub:type="fulltitle">Two<!-- note --><![CDATA[ & Three]]></span></h2>' +
            '<h3><span epub:type="z3998:ordinal">IV</span><a epub:type="noteref">3</a><svg/></h3>' +
            '<h3><span epub:type="title">Just a Title</span><span epub:type="subtitle">With Subtitle</span></h3>' +
            '</section>' +
            '<section epub:type="appendix"><h3 epub:type="z3998:ordinal">V</h3></section>' +
            '</body>'
        ),
        'epub/text/broken.xhtml': xhtml(
            '<body><section id="broken" epub:type="chapter"><h2 epub:type="z3998:ordinal">V</h2>' +
            '<p>Broken&nbsp;<br>text</p></section></body>'
        ),
        'epub/text/rootless.xhtml': '<div xmlns="http://www.w3.org/1999/xhtml"><p>Rootless.</p></div>',
        'epub/text/colophon.xhtml': xhtml(
            '<body epub:type="backmatter colophon"><section id="colophon"><p>Colophon.</p></section></body>'
        ),
        'epub/css/core.css': 'body {}'
    });
    const result = await convertEpub(zip);
    assert.equal(result.title, 'The Book');
    assert.equal(result.author, 'Jane Doe and John Roe');
    assert.deepEqual(result.text.split('\n\n'), [
        'The Book: A Story.',
        'By Jane Doe and John Roe.',
        'Preface.',
        'Some preface text.',
        'Part I.',
        'Chapter I. The Start.',
        'In Which Things Begin.',
        'It was a dark night.\nA second line.',
        'Note here. italic word space. More & more.',
        'A quote.',
        'The Second Chapter.',
        'Epigraph.',
        'Really?',
        'Text two.',
        'What Is Man?',
        'Scene 1.',
        'A Castle.',
        'Hamlet: To be, or not to be.',
        'Horatio: Line one,\nLine two.',
        'Stage, direction',
        'Enter, Ghost',
        'Nobody',
        'Book II. Two & Three.',
        'Chapter IV.',
        'Just a Title.',
        'With Subtitle.',
        'V.',
        'Chapter V.',
        'Broken\ntext',
        'Rootless.'
    ]);
    // A paragraph's character offset
    const paragraphs = result.text.split('\n\n');
    const chars = (paragraph) => paragraphs.slice(0, paragraphs.indexOf(paragraph)).reduce((total, text) => total + text.length + 2, 0);
    assert.deepEqual(result.chapters, [
        {'title': 'Preface', 'char': chars('Preface.'), 'level': 1},
        {'title': 'Part I', 'char': chars('Part I.'), 'level': 1},
        {'title': 'Chapter I. The Start', 'char': chars('Chapter I. The Start.'), 'level': 2},
        {'title': 'The Second Chapter', 'char': chars('The Second Chapter.'), 'level': 2},
        {'title': 'What Is Man?', 'char': chars('What Is Man?'), 'level': 1},
        {'title': 'Scene 1', 'char': chars('Scene 1.'), 'level': 1},
        {'title': 'Book II. Two & Three', 'char': chars('Book II. Two & Three.'), 'level': 1},
        {'title': 'Chapter IV', 'char': chars('Chapter IV.'), 'level': 1},
        {'title': 'Just a Title', 'char': chars('Just a Title.'), 'level': 1},
        {'title': 'V', 'char': chars('V.'), 'level': 1},
        {'title': 'Chapter V', 'char': chars('Chapter V.'), 'level': 1}
    ]);
    assert.equal(result.chapters[0].char, 47);
    assert.equal(result.text.slice(47, 55), 'Preface.');
});


test('convertEpub, metadata', async () => {
    const files = (metadata) => ({
        'epub/content.opf': opf(metadata, '<item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>',
            '<itemref idref="text"/>'),
        'epub/text.xhtml': xhtml('<body><p>Text.</p></body>')
    });

    // The first title, no author
    let result = await convertEpub(epubZip(files('<dc:title>First?</dc:title><dc:title>Second</dc:title>')));
    assert.deepEqual(result, {'text': 'First?\n\nText.', 'chapters': [], 'title': 'First?', 'author': ''});

    // The expanded title, three authors
    result = await convertEpub(epubZip(files(
        '<dc:title id="t1">Short</dc:title><meta property="title-type" refines="#t1">main</meta>' +
        '<dc:title id="t2">Short: The Long Title</dc:title><meta property="title-type" refines="#t2">expanded</meta>' +
        '<dc:creator>A</dc:creator><dc:creator>B</dc:creator><dc:creator>C</dc:creator>'
    )));
    assert.deepEqual(result, {
        'text': 'Short: The Long Title.\n\nBy A, B, and C.\n\nText.', 'chapters': [], 'title': 'Short', 'author': 'A, B, and C'
    });

    // No title - no title paragraph
    result = await convertEpub(epubZip(files('<dc:creator>A</dc:creator>')));
    assert.equal(result.title, '');
    assert.equal(result.text, 'By A.\n\nText.');
});


test('convertEpub, table of contents', async () => {
    const files = (nav, navFile) => ({
        'epub/content.opf': opf(
            '<dc:title>Book</dc:title>',
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="scripted nav"/>' +
                '<item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>',
            '<itemref idref="text"/>'
        ),
        'epub/text.xhtml': xhtml('<body><section id="one"><p>One.</p></section><section id="two"><p>Two.</p></section></body>'),
        [navFile]: xhtml(`<body>${nav}</body>`)
    });
    const links = '<ol><li><a href="text.xhtml">First</a></li><li><a href="text.xhtml#two">Second</a></li></ol>';

    // The first nav, without an epub:type
    let result = await convertEpub(epubZip(files(`<nav>${links}</nav><nav epub:type="landmarks"><a href="text.xhtml">L</a></nav>`,
        'epub/nav.xhtml')));
    assert.equal(result.text, 'Book.\n\nFirst.\n\nOne.\n\nSecond.\n\nTwo.');
    assert.deepEqual(result.chapters, [{'title': 'First', 'char': 7, 'level': 1}, {'title': 'Second', 'char': 21, 'level': 1}]);

    // No nav
    result = await convertEpub(epubZip(files(links, 'epub/nav.xhtml')));
    assert.equal(result.text, 'Book.\n\nOne.\n\nTwo.');

    // The nav document missing
    result = await convertEpub(epubZip(files(`<nav>${links}</nav>`, 'epub/other.xhtml')));
    assert.equal(result.text, 'Book.\n\nOne.\n\nTwo.');
});


test('convertEpub, errors', async () => {
    // No container
    await assert.rejects(convertEpub(openZip(writeZip({'mimetype': 'application/epub+zip'}))),
        {'message': 'ZIP entry not found: META-INF/container.xml'});

    // No rootfile
    const container = (rootfile) => openZip(writeZip({
        'META-INF/container.xml': `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>${rootfile}` +
            '</rootfiles></container>'
    }));
    await assert.rejects(convertEpub(container('')), {'message': 'EPUB package file not found'});
    await assert.rejects(convertEpub(container('<rootfile/>')), {'message': 'EPUB package file not found'});

    // Invalid XML
    await assert.rejects(convertEpub(epubZip({'epub/content.opf': '<package><metadata></package>'})), {'message': 'Invalid XML'});

    // A missing spine document
    await assert.rejects(
        convertEpub(epubZip({
            'epub/content.opf': opf('', '<item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="text"/>')
        })),
        {'message': 'ZIP entry not found: epub/text.xhtml'}
    );
});
