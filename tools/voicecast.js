// Cast each catalog book's narrator - a local Ollama decision model chooses the PicoVox voice that suits the book (its
// author, narrator, genre, and tone): Pride and Prejudice a low, grounded woman's voice, Moby Dick a deep, grave man's.
// The decision model answers a typed choice question about the book's catalog entry with each voice's probability, in
// one forward pass (tools/decide.js).
//
// node tools/voicecast.js [--model <model>] [--eval] [--book <title>]
//
//   --model <model>    the Ollama decision model (default tools/decide.js's)
//   --eval             score the model on the hand-cast books (tools/voicelabels.json) - each book's best voice first,
//                      then the others that suit it
//   --book <title>     cast the catalog books whose title contains this
//
// The catalog builder (tools/catalog.js) casts every book; each cast is cached under cache/catalog/voices/ by model,
// the question (the voices' casting notes), and the book's details, so a rebuild casts only new or changed books.

import {catalogBooks, checkModel, decide, decideBooks, decisionModel, root} from './decide.js';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import process from 'node:process';
import {readFileSync} from 'node:fs';


// The voice question's instructions
const castInstructions = 'Cast the narrator of this audiobook: which voice best suits the book - its author, its narrator or ' +
    'main character, its genre, and its tone?';

// The voices and their casting notes - PicoShelf's voice keys (PicoVox's designed voices). Each note fits the voice as
// PicoVox 2.0 speaks it (its description, and its pace and pitch on PicoVox's panel texts): Kate is the slowest, most
// expressive woman's voice and Sarah a quicker, decisive one; Robert is the deepest and steadiest man's voice, Thomas a
// fast, lively one, and David the fastest.
export const castVoices = {
    'sarah': 'A woman narrates in a brisk, bright, decisive voice - for books written by women: detective and mystery stories ' +
        '(such as Agatha Christie\'s), and nonfiction - essays, argument, women\'s rights, history, memoir, and how-to.',
    'helen': 'A woman narrates in a low, grounded, sincere voice with quiet authority - for novels of manners, courtship, and ' +
        'polite society, serious literary fiction by women, and weighty nonfiction by women.',
    'amy': 'A woman narrates in a young, playful, upbeat voice - for children\'s books, fairy tales, girls\' stories, and ' +
        'light-hearted comedy.',
    'kate': 'A woman narrates in a settled, kind, unhurried storyteller\'s voice - for novels and stories told by or centered ' +
        'on a woman: family and domestic life, hardship, coming of age, and passionate drama.',
    'grace': 'A woman narrates in a soft, relaxed, gentle voice - for poetry by women, devotional and spiritual writing, and ' +
        'quiet bedtime reading.',
    'james': 'A man narrates in a resonant, decisive storyteller\'s voice - for literary fiction, westerns, and historical and ' +
        'adventure novels by men, and travel writing and memoirs by men.',
    'robert': 'A man narrates in a deep, grave, steady voice - for epics, tragedy, sea and war stories, gothic horror and ' +
        'dark tales, classical philosophy, and ancient texts, and for poetry, meditations, spiritual writing, and nature ' +
        'writing by men.',
    'michael': 'A man narrates in a young, buoyant, playful voice - for boys\' adventures, children\'s books, and science ' +
        'fiction and fantasy adventure.',
    'david': 'A man narrates in a punchy, crisp, quick voice - for books written by men: detective, mystery, and crime stories ' +
        '(such as Arthur Conan Doyle\'s), and nonfiction - science, history, biography, politics, and essays.',
    'thomas': 'A man narrates in a high-energy, encouraging voice - for comedy, farce, and humor by men, sports, and ' +
        'inspirational and self-help writing.'
};

// The women's voices
const femaleVoices = ['sarah', 'helen', 'amy', 'kate', 'grace'];

// The cast question
const castQuestions = {
    'voice': {'type': 'choice', 'instructions': castInstructions, 'criteria': castVoices}
};


// Cast a book - {voice, probabilities (each voice's)}
export async function castBook(book, {model}) {
    return castAnswer(await decide(book, {model, 'questions': castQuestions}));
}


// A cast from the answers - {voice, probabilities}
function castAnswer(answers) {
    return {'voice': answers.voice.choice, 'probabilities': answers.voice.probabilities};
}


// Cast books - each book's voice key, by "source|id". Casts are cached by model, the question, and the book's state.
export async function castBooks(books, {model, log}) {
    const casts = await decideBooks(books, {
        model, 'questions': castQuestions, 'answer': castAnswer,
        'cacheName': `voices/${model.replace(/[^a-zA-Z0-9.-]/g, '_')}`, 'label': 'Voices', log
    });
    return Object.fromEntries(Object.entries(casts).map(([key, cast]) => [key, cast.voice]));
}


// Score a model on the hand-cast books - the share cast with the best voice, with a voice that suits, and with the
// right sex
async function evaluate(model) {
    await checkModel(model);
    // The hand-cast books in the catalog (a book the catalog has left out has no details to cast it by)
    const books = new Map(catalogBooks().map((book) => [`${book.source}|${book.id}`, book]));
    const allLabels = JSON.parse(readFileSync(join(root, 'tools', 'voicelabels.json'), 'utf-8'));
    const labels = allLabels.filter((label) => books.has(`${label.source}|${label.id}`));
    const female = new Set(femaleVoices);

    // Warm the model, then cast each book
    await castBook(books.get(`${labels[0].source}|${labels[0].id}`), {model});
    let best = 0;
    let suits = 0;
    let sex = 0;
    const misses = [];
    const start = Date.now();
    for (const label of labels) {
        const {voice} = await castBook(books.get(`${label.source}|${label.id}`), {model});
        best += voice === label.voices[0] ? 1 : 0;
        suits += label.voices.includes(voice) ? 1 : 0;
        sex += female.has(voice) === female.has(label.voices[0]) ? 1 : 0;
        if (!label.voices.includes(voice)) {
            misses.push(`${label.title} (${label.author}): ${voice} - not ${label.voices.join(', ')}`);
        }
    }
    const milliseconds = (Date.now() - start) / labels.length;
    const percent = (count) => `${(100 * count / labels.length).toFixed(1)}%`;
    process.stdout.write(`${model}: best ${percent(best)}, suits ${percent(suits)}, sex ${percent(sex)}, ` +
        `${milliseconds.toFixed(0)} ms a book (${labels.length} books)\n`);
    for (const miss of misses) {
        process.stdout.write(`    ${miss}\n`);
    }
    const missing = allLabels.filter((label) => !books.has(`${label.source}|${label.id}`));
    if (missing.length > 0) {
        process.stdout.write(`${missing.length} hand-cast books not in the catalog: ${missing.map((label) => label.title).join('; ')}\n`);
    }
}


// The command line
async function main() {
    const args = process.argv.slice(2);
    let model = decisionModel;
    let title = '';
    let evalMode = false;
    for (let ix = 0; ix < args.length; ix++) {
        if (args[ix] === '--model') {
            model = args[++ix];
        } else if (args[ix] === '--eval') {
            evalMode = true;
        } else if (args[ix] === '--book') {
            title = args[++ix].toLowerCase();
        } else {
            throw new Error(`Unknown argument "${args[ix]}"`);
        }
    }
    if (evalMode) {
        await evaluate(model);
        return;
    }
    await checkModel(model);
    for (const book of catalogBooks().filter((item) => item.title.toLowerCase().includes(title))) {
        const {voice, probabilities} = await castBook(book, {model});
        const odds = Object.entries(probabilities).sort((first, second) => second[1] - first[1]).slice(0, 3)
            .map(([key, probability]) => `${key} ${(100 * probability).toFixed(0)}%`).join(', ');
        process.stdout.write(`${book.title} (${book.author}): ${voice} - ${odds}\n`);
    }
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`error: ${error.message}\n`);
        process.exitCode = 1;
    });
}
