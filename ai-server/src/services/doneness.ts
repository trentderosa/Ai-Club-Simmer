import type { Recipe } from '../schemas/recipe.js';

/**
 * Meat and seafood doneness repair (PRD F3 food safety).
 *
 * The prompt asks for doneness checks, but small models often skip them. When
 * the ingredients include ground beef or pork, a whole cut of pork, beef or
 * lamb, fish, or shrimp, and no step gives a doneness cue for it, one safety
 * step is inserted after the last step that cooks it. This repairs the recipe
 * instead of rejecting it, so it does not raise the failure rate.
 *
 * Plant-based meat ("vegan steak", "plant-based ground beef", "Beyond Beef")
 * and plant steaks ("cauliflower steak") are skipped. The repair is
 * idempotent: a step that already gives the cue, or the exact check it would
 * insert, means nothing is added, so running it twice adds nothing.
 *
 * Poultry (165°F) is not handled here: it stays prompt-driven plus the
 * existing poultry doneness flagging in recipe-generator.
 *
 * The inserted step is always a safety step (never hidden in a slot 10 mastery
 * cook) and so never changes the hideable-step count.
 */

type Category = 'ground' | 'whole' | 'fish' | 'shrimp';

interface CategoryDef {
  /** Ingredient names that put this category in the recipe. Capture group 0 is used in the step text. */
  ingredient: RegExp;
  /** Ingredient names that look like a match but need no cooking (canned, smoked, already cooked). */
  skip: RegExp;
  /** Words that tie a step to this protein. */
  stepWord: RegExp;
  /** Extra visual cues that count as a doneness cue for this protein (besides a thermometer or a stated temperature). */
  visualCue: RegExp | null;
  /** This protein's own target temperature. A step that names the protein and states it is a cue, even without "reaches" or next to an oil or oven temperature. */
  targetTemp: RegExp | null;
  instruction: (food: string) => string;
  whyItMatters: string;
}

const NO_COOK_NAME =
  /\b(?:canned|tinned|smoked|cured|lox|jarred|dried|paste|pre-?cooked|cooked|sauce|seasoning|rub)\b/i;
// Raw dishes are not cooked, so no doneness check is added.
const RAW_DISH_RE = /\b(?:sushi|sashimi|tartare|crudo|ceviche|carpaccio|poke\s+bowls?)\b/i;
// "tartare sauce" and "sushi-grade" do not make a dish raw; "poke" alone is also a verb ("poke the chops") and a cake.
const NOT_RAW_RE = /\btartar(?:e)?\s+sauce\b|\bsushi[- ]grade\b/gi;
const POKE_TITLE_RE = /\bpoke\b/i;
// Plant-based meat ("plant-based ground beef", "Beyond Beef", "Impossible burger", "vegan steak") needs no meat doneness check.
const MEATLESS_NAME_RE = /\b(?:vegan|plant[- ]based|meatless|vegetarian|veggie|beyond|impossible)\b/i;
// Plant steaks: "cauliflower steak", "portobello mushroom steaks", "cabbage steaks".
const PLANT_STEAK_SOURCE =
  '\\b(?:cauliflower|cabbage|celeriac|tofu|portobello|portabella|mushroom|eggplant|seitan|tempeh|jackfruit)(?:\\s+mushroom)?\\s+steaks?\\b';
const DEG = '\\s*(?:[°˚º]\\s*)?';

const CATEGORIES: Record<Category, CategoryDef> = {
  ground: {
    ingredient: /\bground\s+(?:beef|pork|lamb|veal)\b|\b(?:beef|pork|lamb|veal)\s+mince\b|\bhamburger meat\b/i,
    skip: NO_COOK_NAME,
    stepWord: /\bground\s+(?:beef|pork|lamb|veal)\b|\b(?:beef|pork|lamb|veal|meat|burgers?|patt(?:y|ies)|mince)\b/i,
    visualCue: null,
    targetTemp: new RegExp(`\\b(?:160${DEG}f|71${DEG}c)\\b`, 'i'),
    instruction: (food) =>
      `Check the ${food} for doneness: use a food thermometer and make sure it reaches 160°F (71°C) and no pink remains.`,
    whyItMatters: 'Ground meat can carry bacteria all the way through, so it must reach 160°F (71°C).',
  },
  whole: {
    ingredient:
      /\bpork\s+(?:chops?|loin|tenderloin|cutlets?)\b|\blamb\s+chops?\b|\b(?:steaks?|sirloin|ribeye|rib[- ]eye|filet mignon|beef tenderloin)\b/i,
    skip: new RegExp(`${NO_COOK_NAME.source}|\\b(?:salmon|tuna|fish|swordfish|halibut)\\s+steaks?\\b|${PLANT_STEAK_SOURCE}`, 'i'),
    stepWord: /\b(?:pork|beef|lamb|steaks?|chops?|loin|tenderloin|sirloin|ribeye|rib[- ]eye|filet|meat)\b/i,
    visualCue: null,
    targetTemp: new RegExp(`\\b(?:145${DEG}f|63${DEG}c)\\b`, 'i'),
    instruction: (food) =>
      `Check the ${food} for doneness: use a food thermometer and make sure the thickest part reaches 145°F (63°C), then let it rest for 3 minutes before serving.`,
    whyItMatters: 'Whole cuts are safe at 145°F (63°C), and resting keeps the juices in.',
  },
  fish: {
    ingredient:
      /\b(?:salmon|cod|tilapia|halibut|trout|haddock|snapper|mahi|ahi|(?:ahi\s+)?tuna\s+(?:steaks?|fillets?)|sea bass|swordfish|catfish|white fish|fish fillets?|fish)\b/i,
    skip: new RegExp(`${NO_COOK_NAME.source}|\\bfish\\s+(?:sauce|stock|broth)\\b|\\bsea\\s+salt\\b`, 'i'),
    stepWord: /\b(?:fish|salmon|tuna|ahi|cod|tilapia|halibut|trout|haddock|snapper|mahi|bass|swordfish|catfish|fillets?)\b/i,
    visualCue: /\bflak(?:e|es|ed|ing)\b/i,
    targetTemp: new RegExp(`\\b(?:145${DEG}f|63${DEG}c)\\b`, 'i'),
    instruction: (food) =>
      `Check the ${food} for doneness: the thickest part should reach 145°F (63°C) on a food thermometer, or the flesh should turn opaque and flake easily with a fork.`,
    whyItMatters: 'Fish is done at 145°F (63°C), or when it turns opaque and flakes easily.',
  },
  shrimp: {
    ingredient: /\b(?:shrimps?|prawns?)\b/i,
    skip: NO_COOK_NAME,
    stepWord: /\b(?:shrimps?|prawns?)\b/i,
    visualCue: /\bopaque\b/i,
    targetTemp: null,
    instruction: (food) =>
      `Check the ${food} for doneness: they should be pink and opaque all the way through, with no gray or see-through flesh left.`,
    whyItMatters: 'Shrimp turn pink and opaque when cooked; undercooked shrimp can make you sick.',
  },
};

const CATEGORY_ORDER: Category[] = ['ground', 'whole', 'fish', 'shrimp'];

const THERMOMETER_RE = /\bthermometers?\b|\binternal temp(?:erature)?\b/i;
// A temperature that belongs to the oil or the oven is not a doneness cue. "Sear the steak in oil
// until a thermometer reads 145°F" is a cue: the temperature is the food's.
const NOT_A_CUE_RE =
  /\b(?:heat|preheat|warm|bring)\w*\b[^.!?]{0,30}\b(?:oil|oven|fryer)\b[^.!?]{0,30}?\d{2,3}\s*[°˚º]?\s*[fc]\b|\b(?:oil|oven)\b[^.!?]{0,20}\b(?:reaches|at|to)\b[^.!?]{0,15}\d{2,3}\s*[°˚º]?\s*[fc]\b|\b(?:deep[- ]?fry|candy|oil)\s+thermometers?\b/i;
// "reaches 145°F", "registers 160 F": a stated target. A bare oven temperature ("heat oven to 400°F") is not one.
const TARGET_TEMP_RE =
  /\b(?:reach(?:es|ed)?|register(?:s|ed)?|hits?|hit|read(?:s|ing)?)\b[^.!?]{0,40}?\d{2,3}\s*(?:[°˚º]\s*)?[fc]\b/i;
const COOK_VERB_RE =
  /\b(?:cook|cooking|brown|browning|sear|searing|fry|frying|saute|sauté|sautee|bake|baking|roast|roasting|grill|grilling|broil|broiling|simmer|simmering|boil|boiling|poach|poaching|steam|steaming|pan[- ]?fry|add|heat)\b/i;
const SERVE_LEAD_RE = /^\s*(?:serve|serving|plate|plating|enjoy|garnish|garnishing)\b/i;
const MAX_STEPS = 30;

function ingredientMatch(recipe: Pick<Recipe, 'ingredients'>, def: CategoryDef): string | null {
  for (const ingredient of recipe.ingredients) {
    const name = ingredient.name;
    if (def.skip.test(name) || MEATLESS_NAME_RE.test(name)) continue;
    const match = def.ingredient.exec(name);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

function stepHasCue(instruction: string, def: CategoryDef): boolean {
  // A cue must name its protein and be about the food, not the oil or the oven.
  if (!def.stepWord.test(instruction)) return false;
  // The protein's own target ("cook the beef until 160°F") is a cue even next to an oil temperature.
  if (def.targetTemp !== null && def.targetTemp.test(instruction)) return true;
  if (NOT_A_CUE_RE.test(instruction)) return false;
  if (THERMOMETER_RE.test(instruction) || TARGET_TEMP_RE.test(instruction)) return true;
  return def.visualCue !== null && def.visualCue.test(instruction);
}

/**
 * Insert one safety step per protein category that has no doneness cue.
 * Returns the same recipe object when nothing needs inserting. If the result
 * would not fit the step limit, that insertion is skipped.
 */
export function ensureDonenessSteps<T extends Pick<Recipe, 'ingredients' | 'steps'> & { title?: string }>(
  recipe: T
): T {
  // Only the title and ingredient names decide: step text has verbs like "poke the chops".
  const rawText = [recipe.title ?? '', ...recipe.ingredients.map((i) => i.name)].map((t) => t.replace(NOT_RAW_RE, ' '));
  if (rawText.some((text) => RAW_DISH_RE.test(text))) return recipe;
  if (POKE_TITLE_RE.test(recipe.title ?? '')) return recipe;
  const present = CATEGORY_ORDER.flatMap((category) => {
    const food = ingredientMatch(recipe, CATEGORIES[category]);
    return food ? [{ category, food }] : [];
  });
  let steps = recipe.steps;

  for (const { category, food } of present) {
    const def = CATEGORIES[category];
    if (steps.length >= MAX_STEPS) break;
    // Idempotent: a cue for this protein (including a check this function inserted earlier) means no new step.
    const check = def.instruction(food).toLowerCase();
    if (steps.some((step) => step.instruction.trim().toLowerCase() === check || stepHasCue(step.instruction, def))) {
      continue;
    }

    let at = -1;
    steps.forEach((step, i) => {
      if (def.stepWord.test(step.instruction) && COOK_VERB_RE.test(step.instruction)) at = i;
    });
    let insertAt: number;
    if (at >= 0) insertAt = at + 1;
    else {
      const last = steps[steps.length - 1];
      insertAt = last && SERVE_LEAD_RE.test(last.instruction) ? steps.length - 1 : steps.length;
    }

    const inserted: Recipe['steps'][number] = {
      instruction: def.instruction(food),
      whyItMatters: def.whyItMatters,
      isSafetyStep: true,
    };
    steps = [...steps.slice(0, insertAt), inserted, ...steps.slice(insertAt)];
  }

  return steps === recipe.steps ? recipe : { ...recipe, steps };
}
