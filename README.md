# PicoShelf

**Every public-domain book, read aloud. Right in your browser.**

PicoShelf is an audiobook player for public-domain books (Project Gutenberg and Standard Ebooks) and Wikipedia's
articles. Each book is fetched
from its source and read aloud by [PicoVox](https://github.com/craigahobbs/picovox)
([npm](https://www.npmjs.com/package/picovox)) - realistic speech synthesis in pure JavaScript, under 1 MB - synthesized
on your device, in a Web Worker. No server, no recorded speech, no runtime dependencies beyond PicoVox.

It is a static site, published with GitHub Pages: `index.html` is the app, and `.nojekyll` keeps GitHub Pages from
processing the files.

## Links

A book's address is its link, and it follows the listener's section - share it from the player's share button, or
copy it from the address bar. The link's hash parameters (key=value pairs joined by "&", URL-encoded, as
[MarkdownUp](https://github.com/craigahobbs/markdown-up)'s) name the book and, optionally, the section:

- `book` - the book's id, stable across catalog builds: `pg` and its Project Gutenberg ebook number (`pg1342`),
  `se.` and its Standard Ebooks path with dots for slashes (`se.jane-austen.pride-and-prejudice`), or `wp.` and a
  Wikipedia article's title as Wikipedia's links write it (`wp.Moby-Dick`, `wp.Herman_Melville`)
- `section` - the section's number in the book's contents (its sections and subsections in order, from 1)

For example, `#book=se.miguel-de-cervantes-saavedra.don-quixote.john-ormsby&section=12` opens Don Quixote at its fifth
chapter - or at the listener's place, if that is in the section.

## Layout

- `index.html`, `app.js`, `engine.js`, `worker.js`, `renderworker.js`, `store.js`, `bookcache.js` - the app (copied
  from voice-synth's `static/audiobook/`); the synthesis worker runs the voice network and its render worker the
  synthesizer, at once on two cores
- `sources/` - the book sources (Project Gutenberg, Standard Ebooks) and the Wikipedia shelf (`wikipedia.js` - live, from
  Wikipedia's CORS-enabled APIs: today's featured and most-read articles, search, and an article's plain text, its
  sections the chapters, read by default by Michael - of the best-measured voices on encyclopedia prose; CC BY-SA, credited on
  each article)
- `lib/` - the catalog and book-format code (catalog search, Gutenberg text cleanup, EPUB and ZIP reading)
- `data/catalog.json` - the book catalog, each book with its narrator's voice and its genres (`make catalog`)
- `tools/` - the catalog builder (`catalog.js` - every Standard Ebooks book and the most-downloaded Project Gutenberg
  books, its pages cached under `build/catalog/`), and the decisions a local Ollama decision model makes about each
  book (`decide.js`): its narrator (`voicecast.js`; `voicelabels.json`, 132 hand-cast books, scores the decision models)
  and its genres (`genres.js`)
- `picovox/` - the PicoVox voice - a copy of the npm package `picovox`'s `lib/` (the text front end and G2P, the neural
  model and synthesizer runtime, the synthesis pipeline and sentence splitting the app uses, and the generated model
  modules, `lib/models/`), with its `package.json` (the version) and `LICENSE`
- `package.json`, `package-lock.json` - the PicoVox dependency, pinned by the lock file
- `Makefile` - `make picovox` copies the installed package into `picovox/`; `make catalog` builds the catalog

## The catalog and its narrators

`make catalog` rebuilds `data/catalog.json` (`node tools/catalog.js`; `--cache-only` builds from the cached pages
alone). Each book's default narrator is cast by a local [Ollama](https://ollama.com) decision model,
`kev:9b-nvfp4` (`ollama pull kev:9b-nvfp4`, with Ollama running): it answers a choice of the ten designed voices, each
with casting notes, about the book's title, author, subjects, and description - Jane Austen gets Helen, a composed,
refined voice, and Moby Dick gets Robert, a deep, weathered one. The casts are cached by model and book, so a rebuild
casts only new or changed books. `node tools/voicecast.js --eval --model <model>` scores a decision model on the
hand-cast books; `--book <title>` shows a book's cast. A listener's voice and speed for a book override its defaults
(the cast voice, at 1×), and the Narrator sheet resets them.

The same decision model chooses each book's genres (`tools/genres.js`): one choice of 23 genres - Adventure, Mystery &
Crime, Poetry, Children's, ... - about the book's catalog entry, the book's genres its choice and up to two others it
finds nearly as likely (Alice's Adventures in Wonderland is Children's and Fantasy). `node tools/genres.js --book
<title>` shows a book's.

## The library

The library is the whole catalog (Library) or the books you've opened (My Library, most recent first), searched by
title, author, and subject, and shown three ways: all its books, by author (by surname - a book with several authors
under each), or by genre; an author or a genre opens to its books. The book playing is in the player bar at the
bottom - close it there (×) to stop, its place kept in My Library.

## Updating PicoVox

A static site can't resolve bare imports (`import ... from 'picovox'`), so the app imports a committed copy of the
package, `picovox/`, which GitHub Pages serves. To update it, install the new version, copy it, and commit:

```sh
npm install picovox@latest
make picovox
git add package.json package-lock.json picovox
```

`make picovox` runs `npm ci` (the version in `package-lock.json`) and replaces `picovox/` with
`node_modules/picovox/lib/`, `package.json`, and `LICENSE`.

## Running locally

Serve the directory with any static file server, for example:

```sh
python3 -m http.server 8000
```

then open http://localhost:8000/.
