// Cast each catalog book's narrator - a local Ollama decision model chooses the PicoVox voice that suits the book (its
// author, narrator, genre, and tone): Jane Austen a composed, proper woman's voice, Moby Dick a deep, weathered man's.
// The decision model answers a typed choice question about the book's catalog entry with each voice's probability, in
// one forward pass (tools/decide.js).
//
// node tools/voicecast.js [--model <model>] [--scheme <scheme>] [--eval] [--book <title>]
//
//   --model <model>    the Ollama decision model (default tools/decide.js's)
//   --scheme <scheme>  the questions - "voice" (one choice of the ten voices, the default) or "split" (the narrator's
//                      sex and the voice's style, two questions)
//   --eval             score the model on the hand-cast books (tools/voicelabels.json) - each book's best voice first,
//                      then the others that suit it
//   --book <title>     cast the catalog books whose title contains this
//
// The catalog builder (tools/catalog.js) casts every book; each cast is cached under cache/catalog/voices/ by model,
// scheme, and the book's details, so a rebuild casts only new or changed books.

import {catalogBooks, checkModel, decide, decideBooks, decisionModel, root} from './decide.js';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import process from 'node:process';
import {readFileSync} from 'node:fs';


// The default questions
export const castScheme = 'voice';

// The voice question's instructions
const castInstructions = 'Cast the narrator of this audiobook: which voice best suits the book - its author, its narrator or ' +
    'main character, its genre, and its tone?';

// The voices and their casting notes - PicoShelf's voice keys (PicoVox's designed voices)
export const castVoices = {
    'sarah': 'A woman narrates in a warm, unhurried storyteller\'s voice - for novels and stories told by or centered on a ' +
        'woman: family and domestic life, hardship, coming of age, and passionate drama.',
    'helen': 'A woman narrates in a mature, composed, refined, and proper voice with quiet authority - for novels of manners, ' +
        'courtship, and polite society, serious literary fiction by women, and weighty nonfiction by women.',
    'amy': 'A woman narrates in a young, bright, lively voice - for children\'s books, fairy tales, girls\' stories, and ' +
        'light-hearted comedy.',
    'kate': 'A woman narrates in a brisk, crisp, articulate voice - for nonfiction by women (essays, argument, history, ' +
        'how-to) and mysteries by women.',
    'grace': 'A woman narrates in a gentle, soft, slow voice - for poetry by women, devotional and spiritual writing, and ' +
        'quiet bedtime reading.',
    'james': 'A man narrates in a warm, relaxed storyteller\'s voice - for novels and stories by men: literary fiction, ' +
        'westerns, comedy, and historical and adventure novels for adults.',
    'robert': 'A man narrates in a deep, grave, weathered voice - for epics, tragedy, sea and war stories, gothic horror, ' +
        'classical philosophy, and ancient texts.',
    'michael': 'A man narrates in a young, bright, energetic voice - for boys\' adventures, children\'s books, science fiction ' +
        'and fantasy adventure, and farce.',
    'david': 'A man narrates in a brisk, clear, matter-of-fact voice - for nonfiction by men (science, history, politics, ' +
        'essays) and detective and mystery stories.',
    'thomas': 'A man narrates in a gentle, soft, slow voice - for poetry by men, meditations, spiritual writing, and nature ' +
        'writing.'
};

// The split scheme's questions - the narrator's sex, and the voice's style - and their voices
const sexCriteria = {
    'female': 'A woman should narrate - the author is a woman, or the book is told by or centered on a woman or girl.',
    'male': 'A man should narrate - the author is a man, or the book is told by or centered on a man or boy.'
};
const styleCriteria = {
    'storyteller': 'A warm, unhurried storyteller - for novels and stories: literary fiction, romance, family life, westerns, ' +
        'comedy, and historical novels.',
    'grave': 'A mature, deep, grave voice with authority - for epics, tragedy, sea and war stories, gothic horror, novels of ' +
        'manners and high society, philosophy, and ancient texts.',
    'young': 'A young, bright, lively voice - for children\'s books, fairy tales, boys\' and girls\' adventures, science fiction ' +
        'and fantasy adventure, and farce.',
    'brisk': 'A brisk, crisp, matter-of-fact voice - for nonfiction (science, history, politics, essays, how-to) and detective ' +
        'and mystery stories.',
    'gentle': 'A gentle, soft, slow voice - for poetry, meditations, devotional and spiritual writing, and nature writing.'
};
const splitVoices = {
    'female': {'storyteller': 'sarah', 'grave': 'helen', 'young': 'amy', 'brisk': 'kate', 'gentle': 'grace'},
    'male': {'storyteller': 'james', 'grave': 'robert', 'young': 'michael', 'brisk': 'david', 'gentle': 'thomas'}
};

// The schemes' questions
const schemeQuestions = {
    'voice': {
        'voice': {'type': 'choice', 'instructions': castInstructions, 'criteria': castVoices}
    },
    'split': {
        'sex': {'type': 'choice', 'instructions': 'Should a woman or a man narrate this audiobook?', 'criteria': sexCriteria},
        'style': {
            'type': 'choice', 'instructions': 'Which narrator\'s voice best suits this audiobook\'s genre and tone?',
            'criteria': styleCriteria
        }
    }
};


// Cast a book - {voice, probabilities (each voice's)}
export async function castBook(book, {model, scheme}) {
    return castAnswer(await decide(book, {model, 'questions': schemeQuestions[scheme]}), scheme);
}


// A cast from the answers - {voice, probabilities}
function castAnswer(answers, scheme) {
    if (scheme === 'voice') {
        return {'voice': answers.voice.choice, 'probabilities': answers.voice.probabilities};
    }

    // The split scheme - each voice's probability is its sex's times its style's
    const probabilities = {};
    for (const [sex, styles] of Object.entries(splitVoices)) {
        for (const [style, voice] of Object.entries(styles)) {
            probabilities[voice] = answers.sex.probabilities[sex] * answers.style.probabilities[style];
        }
    }
    const voice = Object.keys(probabilities).reduce((best, key) => (probabilities[key] > probabilities[best] ? key : best));
    return {voice, probabilities};
}


// Cast books - each book's voice key, by "source|id". Casts are cached by model, scheme, and the book's state.
export async function castBooks(books, {model, scheme = castScheme, log}) {
    const casts = await decideBooks(books, {
        model, 'questions': schemeQuestions[scheme], 'answer': (answers) => castAnswer(answers, scheme),
        'cacheName': `voices/${model.replace(/[^a-zA-Z0-9.-]/g, '_')}-${scheme}`, 'label': 'Voices', log
    });
    return Object.fromEntries(Object.entries(casts).map(([key, cast]) => [key, cast.voice]));
}


// Score a model on the hand-cast books - the share cast with the best voice, with a voice that suits, and with the
// right sex
async function evaluate(model, scheme) {
    await checkModel(model);
    // The hand-cast books in the catalog (a book the catalog has left out has no details to cast it by)
    const books = new Map(catalogBooks().map((book) => [`${book.source}|${book.id}`, book]));
    const allLabels = JSON.parse(readFileSync(join(root, 'tools', 'voicelabels.json'), 'utf-8'));
    const labels = allLabels.filter((label) => books.has(`${label.source}|${label.id}`));
    const female = new Set(Object.values(splitVoices.female));

    // Warm the model, then cast each book
    await castBook(books.get(`${labels[0].source}|${labels[0].id}`), {model, scheme});
    let best = 0;
    let suits = 0;
    let sex = 0;
    const misses = [];
    const start = Date.now();
    for (const label of labels) {
        const {voice} = await castBook(books.get(`${label.source}|${label.id}`), {model, scheme});
        best += voice === label.voices[0] ? 1 : 0;
        suits += label.voices.includes(voice) ? 1 : 0;
        sex += female.has(voice) === female.has(label.voices[0]) ? 1 : 0;
        if (!label.voices.includes(voice)) {
            misses.push(`${label.title} (${label.author}): ${voice} - not ${label.voices.join(', ')}`);
        }
    }
    const milliseconds = (Date.now() - start) / labels.length;
    const percent = (count) => `${(100 * count / labels.length).toFixed(1)}%`;
    process.stdout.write(`${model} ${scheme}: best ${percent(best)}, suits ${percent(suits)}, sex ${percent(sex)}, ` +
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
    let scheme = castScheme;
    let title = '';
    let evalMode = false;
    for (let ix = 0; ix < args.length; ix++) {
        if (args[ix] === '--model') {
            model = args[++ix];
        } else if (args[ix] === '--scheme') {
            scheme = args[++ix];
        } else if (args[ix] === '--eval') {
            evalMode = true;
        } else if (args[ix] === '--book') {
            title = args[++ix].toLowerCase();
        } else {
            throw new Error(`Unknown argument "${args[ix]}"`);
        }
    }
    if (!(scheme in schemeQuestions)) {
        throw new Error(`Unknown scheme "${scheme}"`);
    }
    if (evalMode) {
        await evaluate(model, scheme);
        return;
    }
    await checkModel(model);
    for (const book of catalogBooks().filter((item) => item.title.toLowerCase().includes(title))) {
        const {voice, probabilities} = await castBook(book, {model, scheme});
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
