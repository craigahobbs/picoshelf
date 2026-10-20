// The catalog's genres - a local Ollama decision model chooses each book's genres from its catalog entry (its title,
// author, subjects, and description - tools/decide.js): one choice question over the genres, the book's genres its
// choice and up to two others at least genreShare as likely, and at least genreMinimum likely
//
// node tools/genres.js [--model <model>] [--book <title>]
//
//   --model <model>  the Ollama decision model (default tools/decide.js's)
//   --book <title>   the genres of the catalog books whose title contains this, with their probabilities
//
// The catalog builder (tools/catalog.js) gives every book its genres (the catalog's "genres" names them); each book's
// genres are cached under build/catalog/genres/ by model, questions, and the book's details.

import {catalogBooks, checkModel, decide, decideBooks, decisionModel} from './decide.js';
import {fileURLToPath} from 'node:url';
import process from 'node:process';


// The genres - key, name, and the decision model's description
export const genres = {
    'adventure': ['Adventure', 'Adventure - quests, journeys, battles, sea stories, swashbucklers, and westerns.'],
    'biography': ['Biography & Memoir', 'Biography & Memoir - a real person\'s life: biographies, autobiographies, memoirs, ' +
        'journals, and diaries.'],
    'childrens': ['Children\'s', 'Children\'s - books for children and young readers: fairy tales, nursery stories, school ' +
        'stories, and children\'s novels.'],
    'drama': ['Drama', 'Drama - plays written for the stage: tragedies, comedies, and dramatic poems.'],
    'essays': ['Essays & Letters', 'Essays & Letters - collections of essays, speeches, lectures, and letters.'],
    'fantasy': ['Fantasy', 'Fantasy - magic, enchantment, imagined worlds, and the supernatural.'],
    'fiction': ['General Fiction', 'General Fiction - novels and stories of everyday life, society, family, and character.'],
    'historical': ['Historical Fiction', 'Historical Fiction - novels set in an earlier historical period, among its real ' +
        'events and people.'],
    'history': ['History', 'History - accounts of past events, eras, nations, peoples, and wars.'],
    'horror': ['Horror & Ghost Stories', 'Horror & Ghost Stories - terror, ghosts, monsters, and the gothic.'],
    'humor': ['Humor & Satire', 'Humor & Satire - comic novels and stories, satire, and humorous writing.'],
    'mystery': ['Mystery & Crime', 'Mystery & Crime - detectives, crimes, puzzles, and thrillers.'],
    'myths': ['Myths & Legends', 'Myths & Legends - mythology, legends, folklore, sagas, and epics.'],
    'nonfiction': ['Practical & Reference', 'Practical & Reference - handbooks and guides: how-to, reference, health, cooking, ' +
        'business, and hobbies.'],
    'philosophy': ['Philosophy', 'Philosophy - philosophy and ethics: knowledge, mind, morals, and the good life.'],
    'poetry': ['Poetry', 'Poetry - poems and verse.'],
    'politics': ['Politics & Society', 'Politics & Society - politics, government, economics, law, and social questions.'],
    'religion': ['Religion & Spirituality', 'Religion & Spirituality - scripture, theology, devotion, and the spiritual life.'],
    'romance': ['Romance', 'Romance - love and courtship at the heart of the story.'],
    'science': ['Science & Nature', 'Science & Nature - the natural world and the sciences: biology, astronomy, physics, and ' +
        'natural history.'],
    'scifi': ['Science Fiction', 'Science Fiction - the future, space, invention, and other worlds imagined from science.'],
    'shorts': ['Short Stories', 'Short Stories - collections of short stories.'],
    'travel': ['Travel', 'Travel - travel writing, voyages, and exploration.']
};

// A book's genres beyond its choice - up to genreOthers genres at least genreShare of the choice's probability and at
// least genreMinimum
export const genreShare = 0.25;
export const genreMinimum = 0.12;
export const genreOthers = 2;

// The genre question
const questions = {
    'genre': {
        'type': 'choice', 'instructions': 'Which genre best describes this book?',
        'criteria': Object.fromEntries(Object.entries(genres).map(([key, [, description]]) => [key, description]))
    }
};


// A book's genres from the answers - {genres (its choice first, then by probability), probabilities}
function genreAnswer(answers) {
    const {choice, probabilities} = answers.genre;
    const least = Math.max(genreShare * probabilities[choice], genreMinimum);
    const others = Object.keys(probabilities).filter((key) => key !== choice && probabilities[key] >= least).
        sort((first, second) => probabilities[second] - probabilities[first]).slice(0, genreOthers);
    return {'genres': [choice, ...others], probabilities};
}


// The books' genres - each book's genre keys, by "source|id" (cached by model and the book's state)
export async function bookGenres(books, {model = decisionModel, log = null} = {}) {
    const decisions = await decideBooks(books, {
        model, questions, 'answer': genreAnswer, 'cacheName': `genres/${model.replace(/[^a-zA-Z0-9.-]/g, '_')}`, 'label': 'Genres', log
    });
    return Object.fromEntries(Object.entries(decisions).map(([key, decision]) => [key, decision.genres]));
}


// The genre names, by key - the catalog's "genres"
export function genreNames() {
    return Object.fromEntries(Object.entries(genres).map(([key, [name]]) => [key, name]));
}


// The command line - the genres of the books whose titles contain the argument
async function main() {
    const args = process.argv.slice(2);
    let model = decisionModel;
    let title = '';
    for (let ix = 0; ix < args.length; ix++) {
        if (args[ix] === '--model') {
            model = args[++ix];
        } else if (args[ix] === '--book') {
            title = args[++ix].toLowerCase();
        } else {
            throw new Error(`Unknown argument "${args[ix]}"`);
        }
    }
    await checkModel(model);
    for (const book of catalogBooks().filter((item) => item.title.toLowerCase().includes(title))) {
        const answer = genreAnswer(await decide(book, {model, questions}));
        const odds = Object.entries(answer.probabilities).sort((first, second) => second[1] - first[1]).slice(0, 4).
            map(([key, probability]) => `${key} ${(100 * probability).toFixed(0)}%`).join(', ');
        process.stdout.write(`${book.title} (${book.author}): ${answer.genres.join(', ')} - ${odds}\n`);
    }
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`error: ${error.message}\n`);
        process.exitCode = 1;
    });
}
