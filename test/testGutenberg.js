import {decodeText, displayTitle, prepareText} from '../lib/gutenberg.js';
import {strict as assert} from 'node:assert';
import test from 'node:test';


// Check a prepareText result - the paragraphs, and the chapters as [title, level], each chapter's char at its paragraph
function assertPrepared(result, paragraphs, chapters) {
    assert.deepEqual(result.text.split('\n\n'), paragraphs);
    assert.deepEqual(result.chapters.map((chapter) => [chapter.title, chapter.level]), chapters);
    for (const chapter of result.chapters) {
        assert.equal(result.text.slice(chapter.char, chapter.char + chapter.title.length), chapter.title);
        assert.ok(chapter.char === 0 || result.text.slice(chapter.char - 2, chapter.char) === '\n\n');
    }
}


test('decodeText', () => {
    const utf8 = new TextEncoder().encode('Café “quoted”');
    assert.equal(decodeText(utf8), 'Café “quoted”');
    assert.equal(decodeText(utf8, 'UTF-8'), 'Café “quoted”');

    // Not UTF-8 - Windows-1252
    const latin1 = Uint8Array.from([0x43, 0x61, 0x66, 0xE9, 0x20, 0x93, 0x71, 0x94]);
    assert.equal(decodeText(latin1), 'Café “q”');
    assert.equal(decodeText(latin1, 'windows-1252'), 'Café “q”');
    assert.equal(decodeText(Uint8Array.from([0x43, 0xE9]), 'iso-8859-2'), 'Cé');
});


test('displayTitle', () => {
    assert.equal(displayTitle('Frankenstein'), 'Frankenstein');
    assert.equal(displayTitle('  Moby Dick; Or, The Whale  '), 'Moby Dick; Or, The Whale');

    // Lines joined - with a colon, unless the line ends with punctuation
    assert.equal(displayTitle('Dracula\r\nA Mystery'), 'Dracula: A Mystery');
    assert.equal(displayTitle('Moby Dick;\nor, The Whale'), 'Moby Dick; or, The Whale');

    // A generic subtitle removed
    assert.equal(displayTitle('Emma: A Novel'), 'Emma');
    assert.equal(displayTitle('Ivanhoe\nA Romance.'), 'Ivanhoe');
    assert.equal(displayTitle('The Raven, an Poem'), 'The Raven');

    // A long title's subtitle removed
    assert.equal(displayTitle('The Life and Adventures of Robinson Crusoe: Written by Himself'),
        'The Life and Adventures of Robinson Crusoe');
    assert.equal(displayTitle('Narrative of the Life of Frederick Douglass — An American Slave'),
        'Narrative of the Life of Frederick Douglass');
    assert.equal(displayTitle('A very long title without any subtitle separator at all'),
        'A very long title without any subtitle separator at all');
    assert.equal(displayTitle('Short: Subtitle'), 'Short: Subtitle');
});


test('prepareText, novel', () => {
    const raw = [
        'The Project Gutenberg eBook of Alice\'s Adventures in Wonderland',
        '',
        'This ebook is for the use of anyone anywhere in the United States and',
        'most other parts of the world at no cost.',
        '',
        'Title: Alice\'s Adventures in Wonderland',
        '',
        'Author: Lewis Carroll (1832-1898)',
        '',
        'Release date: June 27, 2008 [eBook #11]',
        '',
        '*** START OF THE PROJECT GUTENBERG EBOOK ALICE\'S ADVENTURES IN',
        'WONDERLAND ***',
        '',
        '[Illustration]',
        '',
        'Alice\'s Adventures in Wonderland',
        '',
        'by Lewis Carroll',
        '',
        'THE MILLENNIUM FULCRUM EDITION 3.0',
        '',
        'Contents',
        '',
        ' CHAPTER I.     Down the Rabbit-Hole',
        ' CHAPTER II.    The Pool of Tears',
        ' CHAPTER III.   A Caucus-Race and a Long Tale',
        '',
        '',
        '',
        'CHAPTER I.',
        'Down the Rabbit-Hole',
        '',
        '',
        'Alice was beginning to get very tired of sitting by her sister on the',
        'bank, and of having nothing to do: once or twice she had peeped into the',
        'book her sister was reading, but it had no pictures or conversations in',
        'it, “and what is the use of a book,” thought Alice “without pictures or',
        'conversations?”',
        '',
        'CHAPTER II.',
        'The Pool of Tears',
        '',
        '',
        '“Curiouser and curiouser!” cried Alice (she was so much surprised, that',
        'for the moment she quite forgot how to speak good English).',
        '',
        'CHAPTER III.',
        'A Caucus-Race and a Long Tale',
        '',
        '',
        'They were indeed a queer-looking party that assembled on the bank--the',
        'birds with draggled feathers, the animals with their fur clinging close',
        'to them, and all dripping wet, cross, and uncomfortable.',
        '',
        'THE END',
        '',
        '*** END OF THE PROJECT GUTENBERG EBOOK ALICE\'S ADVENTURES IN WONDERLAND ***',
        '',
        'Updated editions will replace the previous one.',
    ].join('\r\n');
    const result = prepareText(raw);
    assert.equal(result.title, 'Alice\'s Adventures in Wonderland');
    assert.equal(result.author, 'Lewis Carroll');
    assertPrepared(result, [
        'Alice\'s Adventures in Wonderland.',
        'By Lewis Carroll.',
        'Chapter I. Down the Rabbit-Hole.',
        'Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice ' +
            'she had peeped into the book her sister was reading, but it had no pictures or conversations in it, “and what is the use ' +
            'of a book,” thought Alice “without pictures or conversations?”',
        'Chapter II. The Pool of Tears.',
        '“Curiouser and curiouser!” cried Alice (she was so much surprised, that for the moment she quite forgot how to speak good ' +
            'English).',
        'Chapter III. A Caucus-Race and a Long Tale.',
        'They were indeed a queer-looking party that assembled on the bank—the birds with draggled feathers, the animals with their ' +
            'fur clinging close to them, and all dripping wet, cross, and uncomfortable.',
        'THE END'
    ], [
        ['Chapter I. Down the Rabbit-Hole', 1],
        ['Chapter II. The Pool of Tears', 1],
        ['Chapter III. A Caucus-Race and a Long Tale', 1]
    ]);
});


test('prepareText, play', () => {
    const raw = [
        'The Project Gutenberg EBook of Hamlet, by William Shakespeare',
        '',
        'Title: Hamlet',
        '       Prince of Denmark',
        '',
        'Author: William Shakespeare',
        '',
        '*** START OF THIS PROJECT GUTENBERG EBOOK HAMLET ***',
        '',
        'Produced by the PG Shakespeare Team',
        '',
        'THE TRAGEDY OF HAMLET, PRINCE OF DENMARK',
        '',
        'by William Shakespeare',
        '',
        'Contents',
        '',
        'ACT I',
        'Scene I. Elsinore. A platform before the Castle.',
        'Scene II. Elsinore. A room of state in the Castle.',
        '',
        'ACT I Scene I. Elsinore. A platform. Scene II. A room of state. Scene III. A room in Polonius’s house.',
        '',
        'Dramatis Personæ',
        '',
        'HAMLET, Prince of Denmark.',
        'HORATIO, friend to Hamlet.',
        '',
        'ACT I. SCENE 1. Elsinore. A platform before the Castle.',
        '',
        'Enter Francisco and Barnardo, two sentinels.',
        '',
        'BARNARDO.',
        'Who’s there?',
        '',
        'FRANCISCO.',
        'Nay, answer me. Stand and unfold yourself.',
        '',
        'ACT_1|SC_2',
        'ACT I. SCENE 2.',
        'Elsinore. A room of state in the Castle.',
        '',
        'Enter the King, Queen, Hamlet, Polonius, Laertes, Lords and Attendants.',
        '',
        'KING.',
        'Though yet of Hamlet our dear brother’s death',
        'The memory be green, and that it us befitted',
        'To bear our hearts in grief, and our whole kingdom',
        'To be contracted in one brow of woe,',
        '',
        'ACT II',
        '',
        'SCENE I. A room in Polonius’s house.',
        '',
        'Enter Polonius and Reynaldo.',
        '',
        'POLONIUS.',
        'Give him this money and these notes, Reynaldo.',
        '',
        'End of the Project Gutenberg EBook of Hamlet'
    ].join('\n');
    const result = prepareText(raw);
    assert.equal(result.title, 'Hamlet: Prince of Denmark');
    assert.equal(result.author, 'William Shakespeare');
    assertPrepared(result, [
        'Hamlet: Prince of Denmark.',
        'By William Shakespeare.',
        'THE TRAGEDY OF HAMLET, PRINCE OF DENMARK',
        'Dramatis Personæ',
        'HAMLET, Prince of Denmark.\nHORATIO, friend to Hamlet.',
        'Act I. Scene 1. Elsinore. A platform before the Castle.',
        'Enter Francisco and Barnardo, two sentinels.',
        'BARNARDO.\nWho’s there?',
        'FRANCISCO.\nNay, answer me. Stand and unfold yourself.',
        'Act I. Scene 2. Elsinore. A room of state in the Castle.',
        'Enter the King, Queen, Hamlet, Polonius, Laertes, Lords and Attendants.',
        'KING.\nThough yet of Hamlet our dear brother’s death\nThe memory be green, and that it us befitted\nTo bear our ' +
            'hearts in grief, and our whole kingdom\nTo be contracted in one brow of woe,',
        'Act II.',
        'Scene I. A room in Polonius’s house.',
        'Enter Polonius and Reynaldo.',
        'POLONIUS.\nGive him this money and these notes, Reynaldo.'
    ], [
        ['Act I. Scene 1. Elsinore. A platform before the Castle', 1],
        ['Act I. Scene 2. Elsinore. A room of state in the Castle', 2],
        ['Act II', 1],
        ['Scene I. A room in Polonius’s house', 2]
    ]);
});


test('prepareText, verse', () => {
    const raw = [
        '*** START OF THE PROJECT GUTENBERG EBOOK POEMS ***',
        '',
        'POEMS',
        '',
        'CONTENTS',
        '',
        '  THE SONNETS',
        '  A Lover\'s Complaint',
        '  VENUS AND ADONIS',
        '',
        'THE SONNETS',
        '',
        'I',
        '',
        'From fairest creatures we desire increase,',
        'That thereby beauty’s rose might never die,',
        'But as the riper should by time decease,',
        'His tender heir might bear his memory:',
        '',
        'II',
        '',
        'When forty winters shall besiege thy brow,',
        'And dig deep trenches in thy beauty’s field,',
        'Thy youth’s proud livery so gazed on now,',
        'Will be a tattered weed of small worth held:',
        '',
        'A Lover\'s Complaint',
        '',
        'From off a hill whose concave womb reworded',
        'A plaintful story from a sistering vale,',
        'My spirits to attend this double voice accorded,',
        'And down I laid to list the sad-tuned tale;',
        '',
        'VENUS AND ADONIS',
        '',
        'Even as the sun with purple-colour’d face            1',
        'Had ta’en his last leave of the weeping morn,        2',
        'Rose-cheek’d Adonis hied him to the chase;           3',
        'Hunting he loved, but love he laugh’d to scorn;      4',
        '',
        'The Tyger',
        '',
        '  Tyger Tyger, burning bright, In the forests of the night; What immortal hand or eye,',
        '      Could frame thy fearful symmetry?',
        '  In what distant deeps or skies,',
        '  Burnt the fire of thine eyes?',
        '',
        '1',
        '',
        'I wandered lonely as a cloud',
        'That floats on high o\'er vales and hills,',
        'When all at once I saw a crowd,',
        'A host, of golden daffodils;',
        '',
        '*** END OF THE PROJECT GUTENBERG EBOOK POEMS ***'
    ].join('\n');
    const result = prepareText(raw, {'title':'Poems','author':'William Shakespeare'});
    assert.equal(result.title, 'Poems');
    assert.equal(result.author, 'William Shakespeare');
    assertPrepared(result, [
        'Poems.',
        'By William Shakespeare.',
        'The Sonnets.',
        'Sonnet I.',
        'From fairest creatures we desire increase,\nThat thereby beauty’s rose might never die,\nBut as the riper ' +
            'should by time decease,\nHis tender heir might bear his memory:',
        'Sonnet II.',
        'When forty winters shall besiege thy brow,\nAnd dig deep trenches in thy beauty’s field,\nThy youth’s proud ' +
            'livery so gazed on now,\nWill be a tattered weed of small worth held:',
        'A Lover\'s Complaint.',
        'From off a hill whose concave womb reworded\nA plaintful story from a sistering vale,\nMy spirits to attend ' +
            'this double voice accorded,\nAnd down I laid to list the sad-tuned tale;',
        'Venus and Adonis.',
        'Even as the sun with purple-colour’d face\nHad ta’en his last leave of the weeping morn,\nRose-cheek’d Adonis ' +
            'hied him to the chase;\nHunting he loved, but love he laugh’d to scorn;',
        'The Tyger.',
        'Tyger Tyger, burning bright, In the forests of the night; What immortal hand or eye, Could frame thy fearful ' +
            'symmetry?\nIn what distant deeps or skies,\nBurnt the fire of thine eyes?',
        'Poem 1.',
        'I wandered lonely as a cloud\nThat floats on high o\'er vales and hills,\nWhen all at once I saw a crowd,\nA ' +
            'host, of golden daffodils;'
    ], [
        ['The Sonnets', 1],
        ['Sonnet I', 2],
        ['Sonnet II', 2],
        ['A Lover\'s Complaint', 2],
        ['Venus and Adonis', 1],
        ['The Tyger', 2]
    ]);
});


test('prepareText, books', () => {
    const raw = [
        'Title: A Tale of Two Cities;',
        '    or, A Story of the French Revolution',
        '  and Other Things',
        '',
        'Author: Charles Dickens',
        '',
        '***START OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES***',
        '',
        'A TALE OF TWO CITIES',
        '',
        'A STORY OF THE FRENCH REVOLUTION',
        '',
        'By Charles Dickens',
        '',
        'London: Chapman and Hall, Publishers',
        '',
        'PREFACE',
        '',
        'When I was acting, with my children and friends, in Mr Wilkie Collins’s',
        'drama of The Frozen Deep, I first conceived the main idea of this story.',
        '',
        'Book the First—Recalled to Life',
        '',
        'I. The Period',
        '',
        'It was the best of times, it was the worst of times, it was the age of',
        'wisdom, it was the age of foolishness.',
        '',
        'II. The Mail',
        '',
        'It was the Dover road that lay, on a Friday night late in November,',
        'before the first of the persons with whom this history has business.',
        '',
        'THE SECOND BOOK. The Golden Thread',
        '',
        'CHAPTER 1. Five Years Later',
        '',
        'Tellson’s Bank by Temple Bar was an old-fashioned place, even in the',
        'year one thousand seven hundred and eighty.',
        '',
        'Chapter Twenty-One',
        'Echoing Footsteps',
        '',
        'A wonderful corner for echoes, it has been remarked, that corner where',
        'the Doctor lived.',
        '',
        'The Last Chapter',
        '',
        'They said of him, about the city that night, that it was the',
        'peacefullest man’s face ever beheld there.',
        '',
        'EPILOGUE',
        'Epilogue: After the Revolution',
        '',
        'Many years later.',
        '',
        'APPENDIX: Notes on the Text',
        '',
        'Some notes.'
    ].join('\n');
    const result = prepareText(raw);
    assert.equal(result.title, 'A Tale of Two Cities, or, A Story of the French Revolution, and Other Things');
    assert.equal(result.author, 'Charles Dickens');
    assertPrepared(result, [
        'A Tale of Two Cities, or, A Story of the French Revolution, and Other Things.',
        'By Charles Dickens.',
        'Preface.',
        'When I was acting, with my children and friends, in Mr Wilkie Collins’s drama of The Frozen Deep, I first ' +
            'conceived the main idea of this story.',
        'Book the First. Recalled to Life.',
        'Chapter I. The Period.',
        'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.',
        'Chapter II. The Mail.',
        'It was the Dover road that lay, on a Friday night late in November, before the first of the persons with whom ' +
            'this history has business.',
        'The Second Book. The Golden Thread.',
        'Chapter 1. Five Years Later.',
        'Tellson’s Bank by Temple Bar was an old-fashioned place, even in the year one thousand seven hundred and eighty.',
        'Chapter Twenty-One. Echoing Footsteps.',
        'A wonderful corner for echoes, it has been remarked, that corner where the Doctor lived.',
        'The Last Chapter.',
        'They said of him, about the city that night, that it was the peacefullest man’s face ever beheld there.',
        'Epilogue. After the Revolution.',
        'Many years later.',
        'Appendix. Notes on the Text.',
        'Some notes.'
    ], [
        ['Preface', 1],
        ['Book the First. Recalled to Life', 1],
        ['Chapter I. The Period', 2],
        ['Chapter II. The Mail', 2],
        ['The Second Book. The Golden Thread', 1],
        ['Chapter 1. Five Years Later', 2],
        ['Chapter Twenty-One. Echoing Footsteps', 2],
        ['The Last Chapter', 2],
        ['Epilogue. After the Revolution', 2],
        ['Appendix. Notes on the Text', 2]
    ]);
});


test('prepareText, junk', () => {
    const raw = [
        '﻿Title: Dracula',
        '',
        'Author: Bram Stoker',
        '',
        '*** START OF THE PROJECT GUTENBERG EBOOK DRACULA ***',
        '',
        '* CONTENT NOTE (added in 2023)',
        'This book contains outdated language.',
        '* END CONTENT NOTE',
        '',
        'Transcriber\'s Notes:',
        '',
        'Obvious typographical errors have been silently corrected.',
        '',
        'Spelling has been kept as in the original.',
        '',
        '',
        'DRACULA',
        '',
        'BY',
        '',
        'BRAM STOKER',
        '',
        'Copyright, 1897, in the United States of America, by Bram Stoker',
        '',
        '[Illustration: The castle',
        'at night]',
        '',
        'CONTENTS',
        '',
        'CHAPTER I. Jonathan Harker’s Journal ....... 1',
        '',
        'CHAPTER II. Jonathan Harker’s Journal—continued ....... 14',
        '',
        'Page',
        '',
        'CHAPTER III. Dr. Seward’s Diary ....... 27',
        '',
        'A short line',
        '',
        'CHAPTER IV. Mina Murray’s Journal ....... 40',
        '',
        'LIST OF ILLUSTRATIONS',
        '',
        'The castle   Frontispiece',
        'Count Dracula   12',
        '',
        'CHAPTER I',
        '',
        'JONATHAN HARKER’S JOURNAL',
        '',
        '_3 May. Bistritz._--Left Munich at 8:35 P.M., on 1st May, arriving at',
        'Vienna early next morning; should have arrived at 6:46, but train was an',
        'hour late.[1] Buda-Pesth seems a wonderful place.',
        '',
        '[Footnote 1: A note about the train.]',
        '',
        '* * * * *',
        '',
        'CHAPTER II',
        '',
        'JONATHAN HARKER’S JOURNAL—continued',
        '',
        '_5 May._--I must have been asleep, for certainly if I had been fully',
        'awake I must have noticed the approach of such a remarkable place.',
        '[Illustration] It was all =very= strange.',
        '',
        'CHAPTER III',
        '',
        'Dr. Seward’s diary, being a',
        'record of the strange events at the asylum',
        '',
        'The asylum was quiet that night, and the patients slept in their rooms',
        'without the usual disturbance.',
        '',
        'CHAPTER IV',
        '',
        'Lucy was asleep, and Mina sat by her side, watching over her through the',
        'long night.',
        '',
        '12',
        '',
        'Short.',
        '',
        'I.',
        'II.',
        'III.',
        '',
        '[Sidenote: An unclosed',
        'note that goes on',
        '',
        'THE END',
        '',
        'PUBLISHERS\' ANNOUNCEMENTS',
        '',
        'Other books by the same author, available at all booksellers and',
        'libraries throughout the country.',
        '',
        '*** END OF THE PROJECT GUTENBERG EBOOK DRACULA ***',
        '',
        'This and all associated files of various formats will be found in the',
        'Project Gutenberg eBook license.'
    ].join('\n');
    const result = prepareText(raw);
    assert.equal(result.title, 'Dracula');
    assert.equal(result.author, 'Bram Stoker');
    assertPrepared(result, [
        'Dracula.',
        'By Bram Stoker.',
        'Chapter I. Jonathan Harker’s Journal.',
        '3 May. Bistritz.—Left Munich at 8:35 P.M., on 1st May, arriving at Vienna early next morning; should have ' +
            'arrived at 6:46, but train was an hour late. Buda-Pesth seems a wonderful place.',
        'Chapter II. Jonathan Harker’s Journal—continued.',
        '5 May.—I must have been asleep, for certainly if I had been fully awake I must have noticed the approach of ' +
            'such a remarkable place. It was all very strange.',
        'Chapter III. Dr. Seward’s Diary.',
        'Dr. Seward’s diary, being a record of the strange events at the asylum',
        'The asylum was quiet that night, and the patients slept in their rooms without the usual disturbance.',
        'Chapter IV. Mina Murray’s Journal.',
        'Lucy was asleep, and Mina sat by her side, watching over her through the long night.',
        '12',
        'Short.',
        '[Sidenote: An unclosed note that goes on',
        'THE END',
        'PUBLISHERS\' ANNOUNCEMENTS',
        'Other books by the same author, available at all booksellers and libraries throughout the country.'
    ], [
        ['Chapter I. Jonathan Harker’s Journal', 1],
        ['Chapter II. Jonathan Harker’s Journal—continued', 1],
        ['Chapter III. Dr. Seward’s Diary', 1],
        ['Chapter IV. Mina Murray’s Journal', 1]
    ]);
});


test('prepareText, contents and headings', () => {
    const raw = [
        'Title: Moby Dick:',
        '  The Whale',
        '',
        '*** START OF THE PROJECT GUTENBERG EBOOK MOBY DICK ***',
        '',
        'CONTENTS',
        '',
        'ETYMOLOGY.',
        '',
        'EXTRACTS (Supplied by a Sub-Sub-Librarian).',
        '',
        'CHAPTER 1. Loomings.',
        '',
        'CHAPTER 2. The Carpet-Bag.',
        '',
        'CHAPTER 3. The Spouter-Inn.',
        '',
        'CHAPTER 3. The Spouter-Inn Again.',
        '',
        '* * *',
        '',
        'CHAPTER THE LAST',
        '',
        'Original Transcriber’s Note: This is a long transcriber\'s note that goes on and on about the many corrections ' +
            'that were made to this text.',
        '',
        'ETYMOLOGY.',
        '',
        'The pale Usher—threadbare in coat, heart, body, and brain; I see him now.',
        'He was ever dusting his old lexicons and grammars.',
        '',
        'EXTRACTS (Supplied by a Sub-Sub-Librarian).',
        '',
        'It will be seen that this mere painstaking burrower and grub-worm of a poor devil',
        'of a Sub-Sub appears to have gone through the long Vaticans and street-stalls.',
        '',
        'CHAPTER 1. Loomings.',
        'Call me Ishmael. Some years ago—never mind how long precisely—having',
        'little or no money in my purse, and nothing particular to interest me.',
        '',
        'CHAPTER 1',
        '',
        'Loomings',
        '',
        'Call me Ishmael. Some years ago—never mind how long precisely—having',
        'little or no money in my purse, and nothing particular to interest me.',
        '',
        'FOOTNOTES:',
        '',
        'Footnote 1: A footnote.',
        '',
        'This eBook is for the use of anyone anywhere, see the Project Gutenberg License.',
        '',
        'CHAPTER 2',
        '',
        'The Carpet-Bag',
        '',
        'I stuffed a shirt or two into my old carpet-bag, tucked it under my arm,',
        'and started for Cape Horn and the Pacific.',
        '',
        'CHAPTER 3',
        '',
        'There once was a ship that sailed the sea, and the ship it sailed was',
        'the Pequod, and her captain was Ahab.',
        '',
        'CHAPTER IIII.',
        '',
        'VX. Not a roman numeral.',
        '',
        'Part One of the Story is not a heading.',
        '',
        'Chapter 5 was long and not a heading either.',
        '',
        'I. The Way of',
        '',
        'II. a lower case title',
        '',
        'III. A Title, With Commas,',
        '',
        'CHAPTER THE LAST',
        '',
        'The end of the story, at last.'
    ].join('\n');
    const result = prepareText(raw);
    assert.equal(result.title, 'Moby Dick: The Whale');
    assert.equal(result.author, '');
    assertPrepared(result, [
        'Moby Dick: The Whale.',
        'Etymology.',
        'The pale Usher—threadbare in coat, heart, body, and brain; I see him now. He was ever dusting his old lexicons and grammars.',
        'EXTRACTS (Supplied by a Sub-Sub-Librarian).',
        'It will be seen that this mere painstaking burrower and grub-worm of a poor devil of a Sub-Sub appears to have ' +
            'gone through the long Vaticans and street-stalls.',
        'CHAPTER 1. Loomings. Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in ' +
            'my purse, and nothing particular to interest me.',
        'Chapter 1. Loomings.',
        'Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and ' +
            'nothing particular to interest me.',
        'Chapter 2. The Carpet-Bag.',
        'I stuffed a shirt or two into my old carpet-bag, tucked it under my arm, and started for Cape Horn and the Pacific.',
        'Chapter 3.',
        'There once was a ship that sailed the sea, and the ship it sailed was the Pequod, and her captain was Ahab.',
        'CHAPTER IIII.',
        'VX. Not a roman numeral.',
        'Part One of the Story is not a heading.',
        'Chapter 5 was long and not a heading either.',
        'I. The Way of',
        'II. a lower case title',
        'III. A Title, With Commas,',
        'Chapter The Last.',
        'The end of the story, at last.'
    ], [
        ['Etymology', 1],
        ['EXTRACTS (Supplied by a Sub-Sub-Librarian)', 1],
        ['Chapter 1. Loomings', 1],
        ['Chapter 2. The Carpet-Bag', 1],
        ['Chapter 3', 1],
        ['Chapter The Last', 1]
    ]);
});


test('prepareText, heading runs and levels', () => {
    const raw = [
        'BOOK I',
        '',
        'CHAPTER I. O’BRIEN’S VISIT TO L’AMOUR AND THE ENGINEER\'S \'TWAS',
        '',
        'Paragraph 1 of the story, which goes on for a while.',
        '',
        'Paragraph 2 of the story, which goes on for a while.',
        '',
        'Paragraph 3 of the story, which goes on for a while.',
        '',
        '1',
        '',
        'The first part of the chapter, which',
        'continues on a second line of text.',
        '',
        '2',
        '',
        'The second part of the chapter, which',
        'continues on a second line of text.',
        '',
        'CHAPTER V.',
        '',
        'CHAPTER VI.',
        '',
        'CHAPTER VII.',
        '',
        'CHAPTER VIII.',
        '',
        'BOOK IX.',
        '',
        'PART X.',
        '',
        'Paragraph between the runs.',
        '',
        'ACT XI.',
        '',
        'SCENE XII.',
        '',
        'STAVE XIII.',
        '',
        'Paragraph 4 of the story, which goes on for a while.',
        '',
        'Paragraph 5 of the story, which goes on for a while.',
        '',
        'Paragraph 6 of the story, which goes on for a while.',
        '',
        'Paragraph 7 of the story, which goes on for a while.',
        '',
        'Paragraph 8 of the story, which goes on for a while.',
        '',
        'Paragraph 9 of the story, which goes on for a while.',
        '',
        'Paragraph 10 of the story, which goes on for a while.',
        '',
        'Paragraph 11 of the story, which goes on for a while.',
        '',
        'Paragraph 12 of the story, which goes on for a while.',
        '',
        'Paragraph 13 of the story, which goes on for a while.',
        '',
        'Paragraph 14 of the story, which goes on for a while.',
        '',
        'Paragraph 15 of the story, which goes on for a while.',
        '',
        'Paragraph 16 of the story, which goes on for a while.',
        '',
        'Paragraph 17 of the story, which goes on for a while.',
        '',
        'Paragraph 18 of the story, which goes on for a while.',
        '',
        'THE END',
        '',
        '*** END OF THE PROJECT GUTENBERG EBOOK ***'
    ].join('\n');
    const result = prepareText(raw, {'title':'The Book: With a Subtitle','author':'Book Author'});
    assert.equal(result.title, 'The Book: With a Subtitle');
    assert.equal(result.author, 'Book Author');
    assertPrepared(result, [
        'The Book: With a Subtitle.',
        'By Book Author.',
        'Book I.',
        'Chapter I. O’Brien’s Visit to L’amour and the Engineer\'s \'twas.',
        'Paragraph 1 of the story, which goes on for a while.',
        'Paragraph 2 of the story, which goes on for a while.',
        'Paragraph 3 of the story, which goes on for a while.',
        'Part 1.',
        'The first part of the chapter, which continues on a second line of text.',
        'Part 2.',
        'The second part of the chapter, which continues on a second line of text.',
        'Paragraph between the runs.',
        'Act XI.',
        'Scene XII.',
        'Stave XIII.',
        'Paragraph 4 of the story, which goes on for a while.',
        'Paragraph 5 of the story, which goes on for a while.',
        'Paragraph 6 of the story, which goes on for a while.',
        'Paragraph 7 of the story, which goes on for a while.',
        'Paragraph 8 of the story, which goes on for a while.',
        'Paragraph 9 of the story, which goes on for a while.',
        'Paragraph 10 of the story, which goes on for a while.',
        'Paragraph 11 of the story, which goes on for a while.',
        'Paragraph 12 of the story, which goes on for a while.',
        'Paragraph 13 of the story, which goes on for a while.',
        'Paragraph 14 of the story, which goes on for a while.',
        'Paragraph 15 of the story, which goes on for a while.',
        'Paragraph 16 of the story, which goes on for a while.',
        'Paragraph 17 of the story, which goes on for a while.',
        'Paragraph 18 of the story, which goes on for a while.',
        'THE END'
    ], [
        ['Book I', 1],
        ['Chapter I. O’Brien’s Visit to L’amour and the Engineer\'s \'twas', 2],
        ['Act XI', 2],
        ['Stave XIII', 2]
    ]);

    // No title or author
    const untitled = prepareText(raw);
    assert.equal(untitled.title, '');
    assert.equal(untitled.author, '');
    assert.equal(untitled.text.slice(0, 9), 'Book I.\n\n');
});


test('prepareText, end matter', () => {
    const paragraphs = Array.from({'length': 200}, (_value, ix) => `Paragraph ${ix + 1} of the story.`);

    // What follows the last 'THE END' is dropped
    let raw = ['*** START OF THE PROJECT GUTENBERG EBOOK STORY ***', paragraphs.join('\n\n'), 'THE END', 'Advertisement.'].join('\n\n');
    assertPrepared(prepareText(raw), [...paragraphs, 'THE END'], []);

    // Transcriber's notes near the end run to the end - past a wider gap and a heading
    raw = [
        paragraphs.join('\n\n'),
        '',
        'Transcriber’s Notes',
        '',
        'A note.',
        '',
        '',
        'CHAPTER I',
        '',
        'Another note.'
    ].join('\n');
    assertPrepared(prepareText(raw), paragraphs, []);

    // Elsewhere, to a wider gap or a heading
    raw = [
        'Transcriber’s Notes',
        '',
        'A note.',
        '',
        '',
        'After the gap.',
        '',
        '[Transcriber’s Note: Spelling kept.]',
        '',
        'Transcriber’s note:',
        '',
        'Another note.',
        '',
        'CHAPTER I',
        '',
        paragraphs.join('\n\n')
    ].join('\n');
    assertPrepared(prepareText(raw), ['After the gap.', 'Chapter I.', ...paragraphs], [['Chapter I', 1]]);
});


test('prepareText, unlabeled headings', () => {
    const raw = [
        '*** START OF THE PROJECT GUTENBERG EBOOK ESSAYS ***',
        '',
        'CONTENTS',
        '',
        'I. Introduction',
        '',
        'ACT I. SCENE 1. The Platform',
        '',
        'PART II. The Second Part',
        '',
        'III. The Third Essay',
        '',
        'I. Introduction',
        '',
        'The transcriber of this edition kept the original spelling throughout,',
        'except where noted.',
        '',
        'This essay was typed by a volunteer transcriber working from a library copy of the first edition, with care: and some help.',
        '',
        'I.',
        '',
        'II.',
        '',
        'III.',
        '',
        'And so on, for a while, as the essays continue on their course through',
        'the book.',
        '',
        'III',
        '',
        'The third essay, which is longer than the others and runs on to a',
        'second line.'
    ].join('\n');
    const result = prepareText(raw);
    assert.equal(result.title, '');
    assert.equal(result.author, '');
    assertPrepared(result, [
        'Chapter I. Introduction.',
        'The transcriber of this edition kept the original spelling throughout, except where noted.',
        'This essay was typed by a volunteer transcriber working from a library copy of the first edition, with care: and some help.',
        'And so on, for a while, as the essays continue on their course through the book.',
        'Part III. The Third Essay.',
        'The third essay, which is longer than the others and runs on to a second line.'
    ], [
        ['Chapter I. Introduction', 1],
        ['Part III. The Third Essay', 2]
    ]);
});


test('prepareText, unwrapped paragraphs', () => {
    // Each paragraph one line - prose (no multi-line paragraphs isn't verse), so its ordinals are chapters
    const raw = [
        'I.',
        '',
        'It was a dark and stormy night, and the rain fell in torrents upon the town below.',
        '',
        'II.',
        '',
        'The next morning was bright and clear, and the town was washed clean by the rain.'
    ].join('\n');
    assertPrepared(prepareText(raw), [
        'Chapter I.',
        'It was a dark and stormy night, and the rain fell in torrents upon the town below.',
        'Chapter II.',
        'The next morning was bright and clear, and the town was washed clean by the rain.'
    ], [
        ['Chapter I', 1],
        ['Chapter II', 1]
    ]);
});

test('prepareText, titles that start with their label', () => {
    // A title that repeats its label loses it ('EPILOGUE' / 'EPILOGUE.'); a title word that starts with the label is kept
    const prose = 'It was a dark and stormy night, and the rain fell in torrents upon the town\nbelow, and the wind blew.';
    const raw = ['PART I.\nPARTING', 'ACT I. Action', 'LETTER I.\nLetters from Home', 'EPILOGUE\nEPILOGUE.']
        .map((heading) => `${heading}\n\n${prose}`).join('\n\n');
    const proseText = prose.replace('\n', ' ');
    assertPrepared(prepareText(raw), [
        'Part I. Parting.', proseText,
        'Act I. Action.', proseText,
        'Letter I. Letters from Home.', proseText,
        'Epilogue.', proseText
    ], [
        ['Part I. Parting', 1],
        ['Act I. Action', 2],
        ['Letter I. Letters from Home', 2],
        ['Epilogue', 2]
    ]);
});

test('prepareText, verse parts', () => {
    const raw = [
        '*** START OF THE PROJECT GUTENBERG EBOOK IN MEMORIAM ***',
        '',
        'I',
        '',
        'I held it truth, with him who sings',
        'To one clear harp in divers tones,',
        'That men may rise on stepping-stones',
        'Of their dead selves to higher things.',
        '',
        'II',
        '',
        'Old Yew, which graspest at the stones',
        'That name the under-lying dead,',
        'Thy fibres net the dreamless head,',
        'Thy roots are wrapt about the bones.'
    ].join('\n');
    const result = prepareText(raw);
    assert.equal(result.title, '');
    assert.equal(result.author, '');
    assertPrepared(result, [
        'Part I.',
        'I held it truth, with him who sings\nTo one clear harp in divers tones,\nThat men may rise on ' +
            'stepping-stones\nOf their dead selves to higher things.',
        'Part II.',
        'Old Yew, which graspest at the stones\nThat name the under-lying dead,\nThy fibres net the dreamless head,\nThy ' +
            'roots are wrapt about the bones.'
    ], [
        ['Part I', 1],
        ['Part II', 1]
    ]);
});


test('prepareText, old header and markup', () => {
    const raw = [
        'The Project Gutenberg Etext of Old Book',
        '',
        'Title: Old Book',
        '',
        '*END*THE SMALL PRINT! FOR PUBLIC DOMAIN ETEXTS*Ver.04.29.93*END*',
        '',
        'Prepared by A. Volunteer.',
        '',
        'The =bold= word, a footnote[2]{12} marker[*], and--a dash.',
        'He said ** and then * * * and so on* and stopped.',
        '	Tabbed    spaces   collapsed.',
        '',
        '[Illustration: A picture.] The text after the picture.',
        '',
        '[Decoration] An ornament [Image of a cat] inline.',
        '',
        'ACT_3|SC_1',
        '',
        'Separated.',
        '',
        'End of the Project Gutenberg Etext of Old Book'
    ].join('\n');
    const result = prepareText(raw);
    assert.equal(result.title, 'Old Book');
    assert.equal(result.author, '');
    assertPrepared(result, [
        'Old Book.',
        'The bold word, a footnote marker, and—a dash. He said … and then … and so on and stopped. Tabbed spaces collapsed.',
        'The text after the picture.',
        'An ornament inline.',
        'Separated.'
    ], [

    ]);
});


test('prepareText, empty header fields', () => {
    // An empty 'Title:' field - the book's title
    const raw = [
        'Title:',
        'Author:',
        '',
        '*** START OF THE PROJECT GUTENBERG EBOOK X ***',
        '',
        'The text.'
    ].join('\n');
    const result = prepareText(raw, {'title': 'The Book', 'author': 'An Author'});
    assert.equal(result.title, 'The Book');
    assert.equal(result.author, 'An Author');
    assertPrepared(result, ['The Book.', 'By An Author.', 'The text.'], []);
});

test('prepareText, footnotes', () => {
    const raw = [
        'It was a dark night.[1] The wind howled.[12]',
        '',
        '[1] A footnote, its marker one digit.',
        '',
        '[12] A footnote, its marker two digits.',
        '',
        '[1234] A footnote, its marker four digits.',
        '',
        '[A] A lettered marker is not a footnote paragraph.',
        '',
        'The story went on.'
    ].join('\n');
    assertPrepared(prepareText(raw), [
        'It was a dark night. The wind howled.',
        'A lettered marker is not a footnote paragraph.',
        'The story went on.'
    ], []);
});
