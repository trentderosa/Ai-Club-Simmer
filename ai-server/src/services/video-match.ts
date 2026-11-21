/**
 * Shared title checks for technique and dish videos.
 *
 * A title matches when every meaningful word of the dish or technique
 * appears as its own word (plurals count; "pho" does not match "phone").
 * Technique names also accept common verb endings ("dice" / "diced").
 * A different dish is a protein or another dish name between those words,
 * or a known dish phrase that adds a word the query did not ask for
 * ("scrambled eggs fried rice" is not scrambled eggs).
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'to', 'for', 'with', 'in', 'on', 'or',
  'from', 'by', 'at', 'into', 'your', 'you', 'it', 'its', 'this', 'that',
]);

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/** Words that change the dish when they sit between the query words. */
const GAP_DISH_HEADS = new Set([
  'alfredo', 'biryani', 'biscuit', 'biscuits', 'bolognese', 'bread', 'brownie', 'brownies',
  'burger', 'burgers', 'burrito', 'burritos', 'cake', 'cakes', 'carbonara', 'casserole',
  'chili', 'chilli', 'cookie', 'cookies', 'curry', 'dumpling', 'dumplings', 'falafel',
  'fries', 'gnocchi', 'gumbo', 'hummus', 'jambalaya', 'kebab', 'kebabs', 'lasagna',
  'lasagne', 'meatball', 'meatballs', 'meatloaf', 'muffin', 'muffins', 'noodle', 'noodles',
  'nugget', 'nuggets', 'oatmeal', 'omelet', 'omelette', 'paella', 'pancake', 'pancakes',
  'pasta', 'pho', 'pie', 'pies', 'pizza', 'porridge', 'pudding', 'quesadilla', 'ramen',
  'ravioli', 'risotto', 'salad', 'sandwich', 'sandwiches', 'soup', 'spaghetti', 'stew',
  'sushi', 'taco', 'tacos', 'toast', 'waffle', 'waffles', 'wrap', 'wraps',
]);

const PROTEINS = new Set([
  'bacon', 'beef', 'chicken', 'cod', 'crab', 'duck', 'fish', 'lamb', 'lobster', 'meat',
  'pork', 'prawn', 'prawns', 'salmon', 'sausage', 'sausages', 'shrimp', 'steak', 'tofu',
  'tuna', 'turkey',
]);

/**
 * Multi-word dishes that should not ride along on a shorter or different query.
 * A phrase hits only when it adds a word the query did not ask for, so
 * "egg fried rice" still matches fried rice, and "french onion soup" still
 * matches onion soup.
 */
const DIFFERENT_DISH_PHRASES: readonly (readonly string[])[] = [
  ['fried', 'rice'],
  ['fried', 'chicken'],
  ['chicken', 'noodle', 'soup'],
  ['chicken', 'nuggets'],
  ['chicken', 'parmesan'],
  ['chicken', 'pot', 'pie'],
  ['french', 'toast'],
  ['onion', 'rings'],
  ['onion', 'soup'],
  ['pasta', 'salad'],
  ['caesar', 'salad'],
  ['garlic', 'bread'],
  ['banana', 'bread'],
  ['pad', 'see', 'ew'],
  ['pot', 'pie'],
  ['mac', 'cheese'],
  ['macaroni', 'cheese'],
  ['egg', 'drop', 'soup'],
  ['grilled', 'cheese'],
  ['fish', 'chips'],
];

const WORD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  mac: ['macaroni'],
  macaroni: ['mac'],
  parm: ['parmesan'],
  parmesan: ['parm'],
  chili: ['chilli', 'chile'],
  chilli: ['chili', 'chile'],
  chile: ['chili', 'chilli'],
  donut: ['doughnut'],
  doughnut: ['donut'],
  yogurt: ['yoghurt'],
  yoghurt: ['yogurt'],
  omelet: ['omelette'],
  omelette: ['omelet'],
  lasagna: ['lasagne'],
  lasagne: ['lasagna'],
  barbecue: ['barbeque', 'bbq'],
  barbeque: ['barbecue', 'bbq'],
  bbq: ['barbecue', 'barbeque'],
};

/** Under a minute, or a title that calls itself a Short. */
export const VERY_SHORT_CLIP_SECONDS = 60;

const TECHNIQUE_DEMO = /\b(how to|tutorial|step by step|for beginners|beginner|technique|demo|guide)\b/;

export function parseIsoDuration(value: string): number | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3]) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

/** "how to dice an onion beginner cooking" -> "dice an onion". */
export function techniqueSubjectFromQuery(query: string): string {
  const trimmed = query.trim().toLowerCase();
  const prefix = 'how to ';
  const suffix = ' beginner cooking';
  if (trimmed.startsWith(prefix) && trimmed.endsWith(suffix) && trimmed.length > prefix.length + suffix.length) {
    return trimmed.slice(prefix.length, -suffix.length);
  }
  return trimmed;
}

export function meaningfulWords(name: string): string[] {
  return words(name).filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
}

export function titleSharesMeaningfulWords(title: string, name: string, inflectVerbs = false): boolean {
  const wanted = meaningfulWords(name);
  if (wanted.length === 0) return false;
  return locateWords(words(title), wanted, inflectVerbs) !== null;
}

export function hasConflictingDishWords(title: string, name: string, inflectVerbs = false): boolean {
  const queryWords = meaningfulWords(name);
  if (queryWords.length === 0) return false;
  const titleTokens = words(title);
  const positions = locateWords(titleTokens, queryWords, inflectVerbs);
  if (!positions) return false;
  const start = Math.min(...positions);
  const end = Math.max(...positions);
  const used = new Set(positions);
  for (let i = start + 1; i < end; i++) {
    if (used.has(i)) continue;
    const token = titleTokens[i];
    if (!token || STOP_WORDS.has(token) || isQueryToken(token, queryWords, inflectVerbs)) continue;
    if (isListed(token, PROTEINS) || isListed(token, GAP_DISH_HEADS)) return true;
  }
  return DIFFERENT_DISH_PHRASES.some(
    (phrase) => containsPhrase(titleTokens, phrase) && !phraseWithinQuery(phrase, queryWords)
  );
}

export function isTechniqueDemoTitle(title: string, techniqueName: string): boolean {
  if (!titleSharesMeaningfulWords(title, techniqueName, true)) return false;
  return TECHNIQUE_DEMO.test(fold(title));
}

/** True when a very short clip should be dropped because it is not a technique demo. */
export function isVeryShortNonDemo(title: string, durationSeconds: number, techniqueName: string): boolean {
  const labeledShort = /\bshorts\b/.test(fold(title));
  const veryShort = durationSeconds < VERY_SHORT_CLIP_SECONDS;
  if (!labeledShort && !veryShort) return false;
  return !isTechniqueDemoTitle(title, techniqueName);
}

function fold(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value: string): string[] {
  const folded = fold(value);
  return folded ? folded.split(' ') : [];
}

function nounForms(word: string): Set<string> {
  const forms = new Set<string>([word]);
  for (const alias of WORD_ALIASES[word] ?? []) forms.add(alias);
  if (word.length >= 2) {
    forms.add(`${word}s`);
    forms.add(`${word}es`);
  }
  if (word.length >= 3 && word.endsWith('y') && !VOWELS.has(word.at(-2) ?? '')) {
    forms.add(`${word.slice(0, -1)}ies`);
  }
  if (word.length > 4 && word.endsWith('ies')) forms.add(`${word.slice(0, -3)}y`);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) forms.add(word.slice(0, -1));
  if (word.length > 4 && word.endsWith('es')) forms.add(word.slice(0, -2));
  return forms;
}

function verbForms(word: string): Set<string> {
  const forms = nounForms(word);
  if (word.length < 3) return forms;
  forms.add(`${word}ed`);
  forms.add(`${word}ing`);
  forms.add(`${word}d`);
  if (word.endsWith('e')) forms.add(`${word.slice(0, -1)}ing`);
  if (word.endsWith('y')) forms.add(`${word.slice(0, -1)}ied`);
  const last = word.at(-1) ?? '';
  const prev = word.at(-2) ?? '';
  if (last && VOWELS.has(prev) && !VOWELS.has(last)) {
    forms.add(`${word}${last}ed`);
    forms.add(`${word}${last}ing`);
  }
  return forms;
}

function matchesWord(titleWord: string, queryWord: string, inflectVerbs: boolean): boolean {
  const forms = inflectVerbs ? verbForms(queryWord) : nounForms(queryWord);
  return forms.has(titleWord);
}

function sameWord(a: string, b: string): boolean {
  return matchesWord(a, b, false) || matchesWord(b, a, false);
}

function isQueryToken(token: string, queryWords: readonly string[], inflectVerbs: boolean): boolean {
  return queryWords.some((word) => matchesWord(token, word, inflectVerbs));
}

function isListed(token: string, list: ReadonlySet<string>): boolean {
  if (list.has(token)) return true;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && list.has(token.slice(0, -1))) return true;
  return false;
}

function locateWords(
  titleTokens: readonly string[],
  wanted: readonly string[],
  inflectVerbs: boolean
): number[] | null {
  const used = new Set<number>();
  const positions: number[] = [];
  for (const word of wanted) {
    let found = -1;
    for (let i = 0; i < titleTokens.length; i++) {
      if (used.has(i)) continue;
      const token = titleTokens[i];
      if (token && matchesWord(token, word, inflectVerbs)) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    used.add(found);
    positions.push(found);
  }
  return positions;
}

function containsPhrase(titleTokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0) return false;
  for (let start = 0; start < titleTokens.length; start++) {
    const first = titleTokens[start];
    const phraseStart = phrase[0];
    if (!first || !phraseStart || !sameWord(first, phraseStart)) continue;
    let titleIndex = start + 1;
    let matched = 1;
    while (matched < phrase.length && titleIndex < titleTokens.length) {
      const token = titleTokens[titleIndex];
      const phraseWord = phrase[matched];
      if (!token || !phraseWord) break;
      if (sameWord(token, phraseWord)) {
        matched++;
        titleIndex++;
        continue;
      }
      if (STOP_WORDS.has(token)) {
        titleIndex++;
        continue;
      }
      break;
    }
    if (matched === phrase.length) return true;
  }
  return false;
}

function phraseWithinQuery(phrase: readonly string[], queryWords: readonly string[]): boolean {
  return phrase.every((phraseWord) => queryWords.some((queryWord) => sameWord(phraseWord, queryWord)));
}
