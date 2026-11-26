import type { Recipe } from '../schemas/recipe.js';

/**
 * Deterministic dietary check for generated recipes (PRD F3).
 *
 * The prompt asks the model to respect dietary needs, but small models still
 * return "fish sauce" for a vegetarian or "chicken broth" in a bean soup. This
 * module scans ingredient names and step text for words the requested needs
 * forbid. A hit is a failed attempt in the generation loop; the final fallback
 * never returns a recipe that fails this check.
 *
 * Design rules:
 * - Conservative on both sides. Word lists are limited to terms that clearly
 *   break the need. Each rule has an exception list so "coconut milk",
 *   "vegan butter", "peanut butter", "eggplant" and similar do not trip it.
 * - Only needs we recognise are enforced. Unknown free text (the field is free
 *   text) is ignored here; the prompt still shows it to the model.
 * - Matching uses word boundaries on lowercased text. Exceptions are blanked
 *   out first, then the forbidden words are searched.
 * - Everything reported back (terms, hints) comes from our own word lists, never
 *   from model text, so a hint is safe to append to the next prompt.
 */

export type DietRule =
  | 'vegetarian'
  | 'vegan'
  | 'no_pork'
  | 'no_beef'
  | 'no_poultry'
  | 'pescatarian'
  | 'no_fish'
  | 'no_shellfish'
  | 'dairy_free'
  | 'gluten_free'
  | 'nut_free'
  | 'egg_free'
  | 'no_mushrooms';

export interface DietViolation {
  rule: DietRule;
  /** The forbidden word that matched, lowercased. Always from our word lists. */
  term: string;
  where: 'ingredient' | 'step';
}

// ---------------------------------------------------------------------------
// Recognising needs
// ---------------------------------------------------------------------------

const RULE_PHRASES: Array<[DietRule, RegExp]> = [
  ['vegan', /\bvegan\b|\bplant[- ]based\b/],
  ['pescatarian', /\bpescatarian\b|\bpescetarian\b/],
  ['vegetarian', /\bvegetarian\b|\bveggie\b|\blacto[- ]?ovo\b/],
  ['no_pork', /\b(?:no|without|avoid)\s+pork\b|\bpork[- ]free\b/],
  ['no_beef', /\b(?:no|without|avoid)\s+beef\b|\bbeef[- ]free\b/],
  [
    'no_poultry',
    /\b(?:no|without|avoid)\s+(?:poultry|chicken|turkey)\b|\b(?:poultry|chicken)[- ]free\b/,
  ],
  ['no_fish', /\b(?:no|without|avoid)\s+(?:fish|seafood)\b|\bfish[- ]free\b|\bseafood[- ]free\b|\bfish allergy\b/],
  [
    'no_shellfish',
    /\b(?:no|without|avoid)\s+(?:shellfish|seafood)\b|\bshellfish[- ]free\b|\bseafood[- ]free\b|\bshellfish allergy\b|^\s*shellfish\s*$/,
  ],
  ['dairy_free', /\bdairy[- ]free\b|\bno dairy\b|\bnon[- ]dairy\b|\bwithout dairy\b|\bmilk allergy\b|\blactose\b/],
  ['gluten_free', /\bgluten[- ]free\b|\bno gluten\b|\bceliac\b|\bcoeliac\b|\bwithout gluten\b/],
  [
    'nut_free',
    /\bnut[- ]free\b|\bno nuts?\b|\bpeanut[- ]free\b|\btree nut\b|\bnut allerg\w*|\bpeanut allerg\w*|^\s*(?:tree\s+)?(?:nuts?|peanuts?)\s*$/,
  ],
  ['egg_free', /\begg[- ]free\b|\bno eggs?\b|\begg allerg\w*|\bwithout eggs?\b/],
  ['no_mushrooms', /\b(?:no|without|avoid)\s+mushrooms?\b|\bmushroom[- ]free\b/],
];

/** Known dietary needs found in the free-text list. Order follows RULE_PHRASES; unknown text is ignored. */
export function parseDietRules(needs: readonly string[] | undefined): DietRule[] {
  if (!needs) return [];
  const found = new Set<DietRule>();
  for (const raw of needs) {
    const text = normalizeText(raw).replace(/[_]+/g, ' ');
    for (const [rule, re] of RULE_PHRASES) {
      if (re.test(text)) found.add(rule);
    }
  }
  return RULE_PHRASES.map(([rule]) => rule).filter((rule) => found.has(rule));
}

/** Lowercase, strip diacritics ("crème fraîche" -> "creme fraiche") and apostrophes. */
function normalizeText(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’']/g, '');
}

// ---------------------------------------------------------------------------
// Word lists
// ---------------------------------------------------------------------------

/** Every animal protein word we know (meat, poultry, fish, shellfish, egg). Used by the slot 10 prep-step allowlist. */
export const ANIMAL_PROTEIN_WORDS_SOURCE = (): string => [POULTRY, PORK, BEEF, OTHER_MEAT, FISH, SHELLFISH, EGG].join('|');

const words = (list: string): string => `\\b(?:${list})\\b`;

// Broth and stock are not listed on their own: "vegetable broth" is fine. They
// only count when qualified by an animal word, and every animal word below is
// already forbidden, so "chicken broth" and "beef stock" match on chicken/beef.
const POULTRY = 'chicken|turkey|duck|goose|poultry|quail|cornish hen|schmaltz';
const PORK = 'pork|bacon|ham|prosciutto|pancetta|lard|chorizo|salami|pepperoni|hot ?dogs?|sausages?|guanciale|lardons?|kielbasa|andouille|bratwurst|mortadella|pastrami|spam';
const BEEF = 'beef|veal|brisket|oxtail|meatballs?|burgers?|jerky';
const OTHER_MEAT = 'lamb|mutton|goat|venison|bison|rabbit|steaks?|short ribs?|spare ribs?|meats?|liver|bone marrow|tallow|suet|gelatin|gelatine';
const FISH =
  'fish|salmon|tuna|cod|tilapia|trout|halibut|haddock|snapper|mackerel|sardines?|anchov(?:y|ies)|herring|swordfish|catfish|mahi|sea bass|bonito|katsuobushi|dashi|eel';
const SHELLFISH =
  'shrimps?|prawns?|crab|crabs|lobster|clams?|mussels?|oysters?|scallops?|squid|calamari|octopus|crawfish|crayfish';
const ANIMAL_SAUCES = 'fish sauce|oyster sauce|worcestershire|worcestershire sauce|shrimp paste|nuoc mam';
const DAIRY =
  'milk|buttermilk|butter|ghee|cheese|cream|half[- ]and[- ]half|yogh?urt|whey|casein|paneer|ricotta|mozzarella|parmesan|parmigiano|cheddar|feta|mascarpone|gouda|halloumi|brie|gruyere|creme fraiche|ice cream|custard|pecorino|cotija|queso|labneh|kefir';
const EGG = 'eggs?|yolks?|aioli|brioche|mayonnaise|mayo|meringue';
const HONEY = 'honey';

/**
 * Qualifiers that make an animal word safe, each scoped to its own category:
 * "vegan"/"plant-based" exempt anything animal, "vegetarian"/"meatless"/"veggie"
 * exempt only meat, fish, and shellfish, "dairy-free" only dairy, "egg-free"
 * only egg. The qualifier covers up to two following words, and never runs on
 * past "and", "or", "with", "plus", so "vegan butter or chicken" still flags
 * chicken and "veggie and beef" still flags beef. Only the category's own words
 * inside that phrase are exempt: "dairy-free chicken alfredo" still flags chicken.
 */
const NEXT_WORDS = String.raw`(?:\s+(?!(?:and|or|with|plus|in|on|over|for)\b)[\w-]+){1,2}`;
const qualifier = (prefixes: string, kinds: HintKind[]): Exception => ({
  re: new RegExp(String.raw`\b(?:${prefixes})${NEXT_WORDS}`, 'g'),
  kinds,
});
const MEAT_KINDS: HintKind[] = ['meat', 'fish', 'shellfish', 'sauce'];
const Q_ANIMAL_FREE = qualifier('vegan|plant[- ]based|faux|imitation|mock', [
  ...MEAT_KINDS,
  'dairy',
  'egg',
  'honey',
]);
const Q_MEATLESS = qualifier('vegetarian|meatless|meat[- ]free|veggie', MEAT_KINDS);
const Q_DAIRY_FREE = qualifier('dairy[- ]free|non[- ]?dairy', ['dairy']);
const Q_EGG_FREE = qualifier('egg[- ]free|eggless', ['egg']);
const MEAT_QUALIFIERS: Exception[] = [Q_ANIMAL_FREE, Q_MEATLESS];

/** Explicit meat substitutes: "tofu bacon", "jackfruit chicken", "seitan sausage", "beyond meat". "coconut chicken" and "vegetable beef soup" are real meat. */
const PLANT_MEAT =
  /\b(?:tofu|tempeh|seitan|jackfruit|beyond|impossible)\s+(?:bacon|sausages?|jerky|steaks?|chicken|beef|crab|ham|meat|meatballs?|burgers?|patt(?:y|ies)|nuggets|ribs)\b|\b(?:coconut|eggplant|carrot)\s+bacon\b|\bmushroom\s+(?:bacon|jerky)\b/g;
const MEAT_THERMOMETER = /\bmeat thermometers?\b/g;
// "goat cheese" is dairy, not goat meat (vegan still flags the cheese). Lookahead keeps the cheese word.
const GOAT_DAIRY = /\bgoat(?=\s+(?:cheese|milk|yogh?urt|butter))/g;

/** Non-animal "milk", "butter" and friends, and non-dairy words that contain a dairy word. */
const PLANT_DAIRY =
  /\b(?:coconut|almond|oat|soy|soya|rice|cashew|hemp|pea|nut|peanut|sunflower|cocoa|cacao|apple|seed|shea|macadamia|hazelnut|pistachio|flax|chia|tahini|sesame)\s+(?:milk|butter|cream|yogh?urt|cheese)\b|\bbutter\s+(?:beans?|lettuce|squash|nuts?|leaf)\b|\bcream of (?:tartar|coconut)\b|\bcreamed coconut\b|\bcoconut\s+(?:custard)\b/g;

const PLANT_EGG = /\b(?:flax|chia)\s+eggs?\b|\beggs?\s+(?:replacer|substitute|replacement|alternative)\b/g;

const OYSTER_MUSHROOM = /\boyster\s+mushrooms?\b/g;
const PLANT_DASHI = /\b(?:kombu|shiitake|vegetable|vegan)\s+dashi\b/g;
// Fish steak, cauliflower steak: not red meat. "steak" alone stays forbidden for vegetarians.
const NON_MEAT_STEAK =
  /(?<=\b(?:salmon|tuna|fish|swordfish|halibut)\s)steaks?\b|\b(?:cauliflower|tofu|portobello|mushroom|eggplant|seitan|tempeh)\s+steaks?\b/g;

type Exception = RegExp | { re: RegExp; kinds: HintKind[] };

interface RuleDef {
  /** Forbidden word patterns, each paired with the hint category it belongs to. */
  forbidden: Array<{ re: RegExp; kind: HintKind }>;
  /** Text matching these is blanked out before searching. */
  exceptions: Exception[];
  label: string;
}

type HintKind = 'meat' | 'fish' | 'shellfish' | 'sauce' | 'dairy' | 'egg' | 'honey' | 'gluten' | 'nut' | 'mushroom';

const KIND_WORDS: Record<HintKind, string> = {
  meat: [POULTRY, PORK, BEEF, OTHER_MEAT].join('|'),
  fish: FISH,
  shellfish: SHELLFISH,
  sauce: ANIMAL_SAUCES,
  dairy: DAIRY,
  egg: EGG,
  honey: HONEY,
  gluten: 'flour',
  nut: 'nuts?',
  mushroom: 'mushrooms?',
};

const f = (list: string, kind: HintKind): { re: RegExp; kind: HintKind } => ({ re: new RegExp(words(list), 'g'), kind });

const MEAT_FORBIDDEN = [
  f(ANIMAL_SAUCES, 'sauce'),
  f(POULTRY, 'meat'),
  f(PORK, 'meat'),
  f(BEEF, 'meat'),
  f(OTHER_MEAT, 'meat'),
  f(FISH, 'fish'),
  f(SHELLFISH, 'shellfish'),
];
const DAIRY_FORBIDDEN = [f(DAIRY, 'dairy')];
const MEAT_EXCEPTIONS: Exception[] = [
  ...MEAT_QUALIFIERS,
  PLANT_MEAT,
  OYSTER_MUSHROOM,
  PLANT_DASHI,
  NON_MEAT_STEAK,
  MEAT_THERMOMETER,
  GOAT_DAIRY,
];
const DAIRY_EXCEPTIONS: Exception[] = [Q_ANIMAL_FREE, Q_DAIRY_FREE, PLANT_DAIRY];

// "gluten-free", "rice noodles", and similar are blanked before the gluten words are searched.
const GLUTEN_FREE_ANY = new RegExp(String.raw`\bgluten[- ]free${NEXT_WORDS}`, 'g');
const GLUTEN_FREE_FLOUR =
  /\b(?:rice|almond|coconut|corn|chickpea|gluten[- ]free|tapioca|potato|oat|buckwheat|cassava|sorghum|teff|besan|gram|arrowroot|quinoa|millet|banana|cashew|lentil|pea)\s+flour\b/g;
const GLUTEN_FREE_PASTA =
  /\b(?:gluten[- ]free|rice|chickpea|lentil|quinoa|corn|bean)\s+(?:pasta|spaghetti|penne|macaroni|fettuccine|linguine|noodles?|lasagna|orzo)\b/g;
const GLUTEN_FREE_NOODLES =
  /\b(?:glass|cellophane|bean thread|shirataki|sweet potato|rice)\s+(?:vermicelli|noodles?)\b/g;
const GLUTEN_FREE_SOY = /\b(?:tamari|gluten[- ]free soy sauce|coconut aminos)\b/g;
const CORN_TORTILLA = /\b(?:corn|rice)\s+tortillas?\b/g;

/**
 * Gluten words kept short on purpose: wheat flour and its common products.
 * Tortillas only count when the name says flour or wheat ("flour tortillas"),
 * and oats are left alone (usually fine; cross-contamination is not detectable here).
 */
const GLUTEN_WORDS =
  'flour|bread|breadcrumbs?|panko|croutons?|pasta|spaghetti|penne|macaroni|fettuccine|linguine|lasagna|lasagne|orzo|noodles?|ramen|udon|soy sauce|couscous|barley|bulgur|farro|semolina|seitan|rye|wheat|pita|naan|bagels?|flour tortillas?';

const RULES: Record<DietRule, RuleDef> = {
  vegetarian: {
    forbidden: MEAT_FORBIDDEN,
    exceptions: MEAT_EXCEPTIONS,
    label: 'vegetarian',
  },
  vegan: {
    forbidden: [...MEAT_FORBIDDEN, ...DAIRY_FORBIDDEN, f(EGG, 'egg'), f(HONEY, 'honey')],
    exceptions: [...MEAT_EXCEPTIONS, Q_DAIRY_FREE, Q_EGG_FREE, PLANT_DAIRY, PLANT_EGG],
    label: 'vegan',
  },
  no_pork: {
    forbidden: [f(PORK, 'meat')],
    exceptions: [
      ...MEAT_QUALIFIERS,
      PLANT_MEAT,
      /\b(?:turkey|beef|chicken|lamb)\s+(?:bacon|sausages?|ham|hot ?dogs?|pepperoni|salami|chorizo)\b/g,
    ],
    label: 'no pork',
  },
  no_beef: {
    forbidden: [f('beef|veal|brisket|oxtail|beef broth|beef stock', 'meat')],
    exceptions: [...MEAT_QUALIFIERS, PLANT_MEAT, MEAT_THERMOMETER],
    label: 'no beef',
  },
  no_poultry: {
    forbidden: [f(POULTRY, 'meat')],
    exceptions: [...MEAT_QUALIFIERS, PLANT_MEAT],
    label: 'no poultry or chicken',
  },
  pescatarian: {
    forbidden: [f(POULTRY, 'meat'), f(PORK, 'meat'), f(BEEF, 'meat'), f(OTHER_MEAT, 'meat')],
    exceptions: [...MEAT_QUALIFIERS, PLANT_MEAT, NON_MEAT_STEAK, MEAT_THERMOMETER, GOAT_DAIRY],
    label: 'pescatarian (no meat or poultry)',
  },
  no_fish: {
    forbidden: [f('fish sauce|worcestershire|worcestershire sauce', 'sauce'), f(FISH, 'fish')],
    exceptions: [...MEAT_QUALIFIERS, PLANT_DASHI],
    label: 'no fish',
  },
  no_shellfish: {
    forbidden: [f('oyster sauce|shrimp paste', 'sauce'), f(SHELLFISH, 'shellfish')],
    exceptions: [...MEAT_QUALIFIERS, OYSTER_MUSHROOM],
    label: 'no shellfish',
  },
  dairy_free: {
    forbidden: DAIRY_FORBIDDEN,
    exceptions: DAIRY_EXCEPTIONS,
    label: 'dairy-free',
  },
  gluten_free: {
    forbidden: [f(GLUTEN_WORDS, 'gluten')],
    exceptions: [
      GLUTEN_FREE_ANY,
      GLUTEN_FREE_FLOUR,
      GLUTEN_FREE_PASTA,
      GLUTEN_FREE_NOODLES,
      GLUTEN_FREE_SOY,
      CORN_TORTILLA,
    ],
    label: 'gluten-free',
  },
  nut_free: {
    forbidden: [
      f('almonds?|walnuts?|pecans?|cashews?|pistachios?|hazelnuts?|peanuts?|macadamias?|pine nuts?|brazil nuts?|nuts?|nutella|marzipan', 'nut'),
    ],
    exceptions: [/\bnut[- ]free\b/g, /\b(?:nutmeg|nutritional)\b/g],
    label: 'nut-free',
  },
  egg_free: {
    forbidden: [f(EGG, 'egg')],
    exceptions: [Q_ANIMAL_FREE, Q_EGG_FREE, PLANT_EGG],
    label: 'egg-free',
  },
  no_mushrooms: {
    forbidden: [
      f('mushrooms?|shiitake|portobello|portabella|cremini|porcini|chanterelles?|enoki|morels?', 'mushroom'),
    ],
    exceptions: [/\bmushroom[- ]free\b/g],
    label: 'no mushrooms',
  },
};

/** Word-boundary scan of one string for one rule. Returns the first forbidden term, or null. */
export function findForbiddenTerm(text: string, rule: DietRule): string | null {
  const def = RULES[rule];
  let t = normalizeText(text);
  for (const exception of def.exceptions) {
    if (exception instanceof RegExp) {
      t = t.replace(new RegExp(exception.source, 'g'), ' ');
    } else {
      const own = new RegExp(words(exception.kinds.map((k) => KIND_WORDS[k]).join('|')), 'g');
      t = t.replace(new RegExp(exception.re.source, 'g'), (m) => m.replace(own, ' '));
    }
  }
  for (const { re } of def.forbidden) {
    const match = new RegExp(re.source, 'g').exec(t);
    if (match) return match[0];
  }
  return null;
}

/**
 * Violations in a recipe for the given rules: one entry per rule, ingredient
 * names first, then step instructions. Titles are not scanned (a "Chicken-Free
 * Chili" title would be a false positive, and the ingredients are the truth).
 */
export function findDietViolations(
  recipe: Pick<Recipe, 'ingredients' | 'steps'>,
  rules: readonly DietRule[]
): DietViolation[] {
  const violations: DietViolation[] = [];
  for (const rule of rules) {
    let found: DietViolation | null = null;
    for (const ingredient of recipe.ingredients) {
      const term = findForbiddenTerm(ingredient.name, rule);
      if (term) {
        found = { rule, term, where: 'ingredient' };
        break;
      }
    }
    if (!found) {
      for (const step of recipe.steps) {
        const term = findForbiddenTerm(step.instruction, rule);
        if (term) {
          found = { rule, term, where: 'step' };
          break;
        }
      }
    }
    if (found) violations.push(found);
  }
  return violations;
}

const SUBSTITUTION_BY_KIND: Record<HintKind, string> = {
  meat: 'Use beans, lentils, chickpeas, tofu, or mushrooms for protein, and vegetable broth instead of meat broth.',
  fish: 'Use soy sauce, salt, or miso instead of fish sauce or fish, and vegetable broth instead of fish stock.',
  shellfish: 'Leave out shellfish and shellfish sauces; use soy sauce or salt for flavor.',
  sauce: 'Use soy sauce or salt instead of fish sauce, oyster sauce, or Worcestershire sauce.',
  dairy: 'Use olive oil or a plant-based milk, butter, or cheese instead of dairy.',
  egg: 'Leave out eggs and mayonnaise, or use a plant-based substitute.',
  honey: 'Use maple syrup or sugar instead of honey.',
  gluten: 'Use gluten-free ingredients (rice, corn, or gluten-free flour, pasta, and bread, and tamari instead of soy sauce).',
  nut: 'Leave out all nuts and nut butters; use seeds or leave the ingredient out.',
  mushroom: 'Leave out mushrooms; use another vegetable.',
};

/** Rule to the hint category for its matched term (looked up by re-matching, so it stays on our lists). */
function hintKindFor(violation: DietViolation): HintKind {
  for (const { re, kind } of RULES[violation.rule].forbidden) {
    if (new RegExp(`^(?:${re.source})$`).test(violation.term)) return kind;
  }
  return 'meat';
}

/**
 * Short corrective note appended to the next attempt's prompt. Built only from
 * our own word lists and labels, so no model text is echoed back.
 */
export function dietCorrectiveHint(violations: readonly DietViolation[]): string {
  const parts = violations.map(
    (v) =>
      `The last recipe used "${v.term}", which breaks the ${RULES[v.rule].label} dietary need. ${SUBSTITUTION_BY_KIND[hintKindFor(v)]}`
  );
  return `CORRECTION: ${parts.join(' ')} Write the whole recipe again with no forbidden ingredients, in both the ingredients list and the steps.`;
}

/** One-line prompt hint for vegetarian and vegan diners. Empty for other needs. */
export function dietPromptHint(rules: readonly DietRule[]): string {
  return rules.includes('vegetarian') || rules.includes('vegan')
    ? 'Use vegetable broth, and soy sauce or salt instead of fish sauce.'
    : '';
}
