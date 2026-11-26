import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findForbiddenTerm } from './diet-guard.js';
import { generateRecipe, buildPrompt, repairMasteryHideableSteps, type PathSlot } from './recipe-generator.js';
import { generateCookAnythingRecipe } from '../cook-anything/generator.js';
import type { OllamaClient } from './ollama-client.js';
import type { Recipe } from '../schemas/recipe.js';
import type { UserProfile } from '../schemas/user.js';
import { countedHiddenStepCount, MASTERY_MIN_HIDDEN_STEPS } from '../mastery/mask.js';

const slot: PathSlot = { id: 3, dishName: 'Tuscan White Bean Soup', techniqueFocus: 'Simmering' };
const finalSlot: PathSlot = { id: 10, dishName: 'Roast Chicken', techniqueFocus: 'Roasting', isFinal: true };
const vegetarian: UserProfile = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  experienceLevel: 'never_cooked',
  budget: 'low',
  equipment: ['stove', 'pot'],
  dietaryNeeds: ['vegetarian'],
};
const plain: UserProfile = { ...vegetarian, dietaryNeeds: undefined };

const step = (instruction: string, isSafetyStep = false): Recipe['steps'][number] => ({ instruction, isSafetyStep });
const recipe = (ingredients: string[], steps: Recipe['steps']): Recipe => ({
  title: 'Test',
  ingredients: ingredients.map((name) => ({ name, amount: '1 cup' })),
  timeEstimateMinutes: 30,
  steps,
});
const json = (r: Recipe): string => JSON.stringify(r);

function clientWith(responses: (string | Error)[]): OllamaClient & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const generate = vi.fn().mockImplementation((prompt: string) => {
    prompts.push(prompt);
    const r = responses[i++];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  });
  return { generate, prompts } as unknown as OllamaClient & { prompts: string[] };
}

async function run(
  client: OllamaClient,
  s: PathSlot,
  user: UserProfile
): ReturnType<typeof generateRecipe> {
  const p = generateRecipe(client, s, user);
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const veggieSoup = recipe(['white beans', 'vegetable broth', 'kale'], [
  step('Gather the beans, broth, and kale on the counter.'),
  step('Simmer the beans in the vegetable broth for 20 minutes.', true),
]);
const chickenBrothSoup = recipe(['white beans', 'chicken broth', 'kale'], veggieSoup.steps);

describe('diet guard in generateRecipe', () => {
  it('rejects chicken broth for a vegetarian, retries with a corrective hint, and accepts the clean attempt', async () => {
    const client = clientWith([json(chickenBrothSoup), json(veggieSoup)]);
    const result = await run(client, slot, vegetarian);
    expect(result.success).toBe(true);
    if (result.success) expect(result.recipe.ingredients.map((i) => i.name)).toContain('vegetable broth');
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[0]).not.toContain('CORRECTION');
    expect(client.prompts[1]).toContain('CORRECTION');
    expect(client.prompts[1]).toContain('"chicken"');
    expect(client.prompts[1]).toContain('vegetable broth');
    // The hint is for one attempt only.
    expect(console.warn).toHaveBeenCalledWith(
      'Recipe attempt rejected',
      expect.objectContaining({ reason: 'diet_violation', attempt: 1 })
    );
  });

  it('suggests soy sauce when a vegetarian recipe uses fish sauce', async () => {
    const fish = recipe(['cucumber', 'fish sauce'], [step('Toss the cucumber with the fish sauce in a bowl.')]);
    const ok = recipe(['cucumber', 'soy sauce'], [step('Toss the cucumber with the soy sauce in a bowl.')]);
    const client = clientWith([json(fish), json(ok)]);
    const result = await run(client, slot, vegetarian);
    expect(result.success).toBe(true);
    expect(client.prompts[1]).toContain('soy sauce');
  });

  it('never returns a diet-violating recipe: three violating attempts fail', async () => {
    const client = clientWith([json(chickenBrothSoup), json(chickenBrothSoup), json(chickenBrothSoup)]);
    const result = await run(client, slot, vegetarian);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('generation_failed');
      expect(result.error.message).toContain('diet_violation');
      expect(result.error.attempts).toBe(3);
    }
    expect(client.generate).toHaveBeenCalledTimes(3);
  });

  it('does not use a raw-protein-rinse fallback that also breaks the diet', async () => {
    const rinse = recipe(['white beans', 'chicken'], [step('Rinse the chicken under cold water.')]);
    const client = clientWith([json(rinse), json(rinse), json(rinse)]);
    const result = await run(client, slot, vegetarian);
    expect(result.success).toBe(false);
  });

  it('still uses the rinse fallback when the diet is fine (existing behavior)', async () => {
    const rinse = recipe(['white beans', 'kale'], [step('Rinse the kale.'), step('Wash the meat well.')]);
    const client = clientWith([json(rinse), json(rinse), json(rinse)]);
    const result = await run(client, slot, plain);
    expect(result.success).toBe(true);
  });

  it('ignores unknown dietary text and does nothing without dietary needs', async () => {
    const client = clientWith([json(chickenBrothSoup)]);
    expect((await run(client, slot, plain)).success).toBe(true);
    const client2 = clientWith([json(chickenBrothSoup)]);
    expect((await run(client2, slot, { ...vegetarian, dietaryNeeds: ['loves spicy food'] })).success).toBe(true);
  });

  it('adds the broth and soy sauce hint to the prompt for vegetarian and vegan only', () => {
    const hint = 'Use vegetable broth, and soy sauce or salt instead of fish sauce.';
    expect(buildPrompt(slot, vegetarian)).toContain(hint);
    expect(buildPrompt(slot, { ...vegetarian, dietaryNeeds: ['vegan'] })).toContain(hint);
    expect(buildPrompt(slot, { ...vegetarian, dietaryNeeds: ['gluten-free'] })).not.toContain(hint);
    expect(buildPrompt(slot, plain)).not.toContain(hint);
  });

  it('applies the same guard to cook anything recipes', async () => {
    const client = clientWith([json(chickenBrothSoup), json(veggieSoup)]);
    const p = generateCookAnythingRecipe(client, 'white bean soup', vegetarian);
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.success).toBe(true);
    expect(client.prompts[1]).toContain('CORRECTION');
  });
});

describe('doneness repair in generateRecipe', () => {
  const chops = recipe(['pork chops', 'olive oil'], [
    step('Season the pork chops with salt.'),
    step('Sear the pork chops in a hot pan for 4 minutes per side.', true),
    step('Serve with lemon.'),
  ]);

  it('inserts a safety doneness step instead of rejecting', async () => {
    const client = clientWith([json(chops)]);
    const result = await run(client, slot, plain);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.recipe.steps).toHaveLength(4);
      expect(result.recipe.steps[2].instruction).toContain('145°F');
      expect(result.recipe.steps[2].isSafetyStep).toBe(true);
    }
    expect(client.generate).toHaveBeenCalledTimes(1);
  });

  it('leaves a recipe with a doneness cue unchanged', async () => {
    const withCue = recipe(chops.ingredients.map((i) => i.name), [
      step('Sear the pork chops until a thermometer reads 145°F.', true),
    ]);
    const result = await run(clientWith([json(withCue)]), slot, plain);
    expect(result.success && result.recipe.steps).toHaveLength(1);
  });

  it('on slot 10 the inserted step is a safety step and the hidden count is unchanged', async () => {
    const steps = [
      step('Gather and measure all the ingredients on the counter.'),
      step('Mix the salt and pepper together in a small bowl.'),
      step('Stir the lemon juice and herbs together in a bowl.'),
      step('Sear the pork chops in a hot pan for 4 minutes per side.', true),
    ];
    const r = recipe(['pork chops', 'lemon', 'salt'], steps);
    const result = await run(clientWith([json(r)]), finalSlot, plain);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.recipe.steps).toHaveLength(5);
      expect(countedHiddenStepCount(result.recipe)).toBe(3);
      const inserted = result.recipe.steps.find((s) => s.instruction.includes('145°F'));
      expect(inserted?.isSafetyStep).toBe(true);
    }
  });
});

describe('slot 10 reliability', () => {
  // The model flagged every step as safety, as seen in the catalog sweep.
  const allFlagged = recipe(['chicken', 'salt', 'herbs'], [
    step('Gather and measure the salt, herbs, and chicken on the counter.', true),
    step('Mix the salt and herbs together in a small bowl.', true),
    step('Stir together the lemon juice and honey in a bowl.', true),
    step('Toss the salad greens with the herb mix in a large bowl.', true),
    step('Roast the chicken in the oven until a thermometer reads 165°F.', true),
    step('Serve.', true),
  ]);

  it('repairMasteryHideableSteps clears plain prep flags only, only as many as needed', () => {
    const { recipe: repaired, meetsMinimum } = repairMasteryHideableSteps(allFlagged);
    expect(meetsMinimum).toBe(true);
    expect(countedHiddenStepCount(repaired)).toBe(MASTERY_MIN_HIDDEN_STEPS);
    expect(repaired.steps[4].isSafetyStep).toBe(true);
    expect(repaired.steps[5].isSafetyStep).toBe(true);
    // The first prep step mentions chicken (raw protein), so it stays safety.
    expect(repaired.steps[0].isSafetyStep).toBe(true);
    expect(repaired.steps.map((s) => s.instruction)).toEqual(allFlagged.steps.map((s) => s.instruction));
  });

  it('never clears a heat, knife, rinse, pat-dry, or protein step, and never changes the minimum', () => {
    const risky = recipe(['chicken'], [
      step('Mix the seasoning, then heat the pan.', true),
      step('Gather the knife and the board and chop the onion.', true),
      step('Pat the chicken dry with paper towels.', true),
      step('Do not rinse the chicken before seasoning it.', true),
      step('Combine the beef and spices in a bowl.', true),
    ]);
    const { recipe: out, meetsMinimum } = repairMasteryHideableSteps(risky);
    expect(meetsMinimum).toBe(false);
    expect(out.steps.every((s) => s.isSafetyStep)).toBe(true);
    expect(MASTERY_MIN_HIDDEN_STEPS).toBe(3);
  });

  it('returns the same recipe when it already meets the minimum', () => {
    const ok = recipe(['salt'], [
      step('Gather the ingredients on the counter.'),
      step('Season the salt with pepper in a bowl.'),
      step('Mix the herbs and butter together in a bowl.'),
    ]);
    expect(repairMasteryHideableSteps(ok).recipe).toBe(ok);
  });

  it('generateRecipe accepts an all-flagged slot 10 recipe after repair, in one attempt', async () => {
    const client = clientWith([json(allFlagged)]);
    const result = await run(client, finalSlot, plain);
    expect(result.success).toBe(true);
    expect(client.generate).toHaveBeenCalledTimes(1);
    if (result.success) expect(countedHiddenStepCount(result.recipe)).toBeGreaterThanOrEqual(MASTERY_MIN_HIDDEN_STEPS);
  });

  it('retries with a hint when the repair cannot reach the minimum, naming the plain prep steps', async () => {
    const short = recipe(['chicken', 'salt'], [
      step('Gather and measure the salt and herbs on the counter.', true),
      step('Mix the salt and herbs together in a small bowl.', true),
      step('Roast the chicken in the oven for one hour.', true),
      step('Serve.', true),
    ]);
    const good = recipe(['chicken', 'salt'], [
      step('Gather and measure the salt and herbs on the counter.'),
      step('Mix the salt and herbs together in a small bowl.'),
      step('Stir the lemon juice and honey together in a bowl.'),
      step('Roast the chicken in the oven for one hour.', true),
    ]);
    const client = clientWith([json(short), json(good)]);
    const result = await run(client, finalSlot, plain);
    expect(result.success).toBe(true);
    expect(client.generate).toHaveBeenCalledTimes(2);
    expect(client.prompts[1]).toContain('CORRECTION');
    expect(client.prompts[1]).toContain('only 2 steps with isSafetyStep false');
    expect(client.prompts[1]).toContain('Keep every heat, knife, raw meat, and hot oil step flagged true');
  });

  it('still fails after 3 attempts when the recipe cannot reach the minimum', async () => {
    const hot = recipe(['chicken'], [
      step('Heat the oven.', true),
      step('Roast the chicken in a pan.', true),
      step('Serve.', true),
    ]);
    const client = clientWith([json(hot), json(hot), json(hot)]);
    const result = await run(client, finalSlot, plain);
    expect(result.success).toBe(false);
    expect(client.generate).toHaveBeenCalledTimes(3);
  });
});

describe('repairMasteryHideableSteps: strict allowlist', () => {
  const hotStep = 'Heat the pan over medium heat for two minutes.';
  const withFlagged = (text: string): Recipe =>
    recipe(['x'], [step(text, true), ...Array.from({ length: 6 }, () => step(hotStep, true))]);

  const mustStayFlagged = [
 'Season the chicken thighs with salt and pepper on both sides.',
 'Season the thighs with salt, pepper, and paprika on both sides.',
 'Season the steaks generously with salt and pepper on both sides.',
 'Season the pork chops with salt and pepper on both sides.',
 'Season the chops with salt and pepper on both sides well.',
 'Toss the prawns with garlic and lime juice in a bowl.',
 'Toss the scallops with salt and lemon zest in a bowl.',
 'Combine the marinade with the drumsticks in a zip-top bag.',
 'Toss the wings with the spice rub in a large bowl.',
 'Mix the raw ground beef with the breadcrumbs and spices.',
 'Mix the ground veal with breadcrumbs and spices in a bowl.',
 'Mix the ground turkey with breadcrumbs and spices in a bowl.',
 'Season the tuna fillets with salt and pepper on both sides.',
 'Season the cod fillets with salt and pepper on both sides.',
 'Season the patties with salt and pepper on both sides.',
 'Mix the raw patties ingredients together with your hands.',
 'Rest the roast for ten minutes before slicing.',
 'Let the brisket rest for ten minutes on the board.',
 'Rest the steak for five minutes on a cutting board.',
 'Toss the potatoes with oil, salt, and pepper.',
 'Combine the hot rice with vinegar and sugar.',
 'Whisk the gravy in the saucepan over medium until it thickens, about 5 minutes.',
 'Stir together the sauce in the pot over medium-high until thick.',
 'Toss the noodles in the wok over high for two minutes until coated.',
 'Combine everything in the Instant Pot and seal the lid.',
 'Combine everything in the Instant Pot and pressure on high for 8 minutes.',
 'Mix the batter on the griddle until bubbles form.',
 'Combine the soup ingredients in a blender and blend until smooth.',
 'Whisk the yolks and sugar together in a bowl until pale.',
 'Combine the sugar and water in a saucepan.',
 'Mix the lye solution carefully with gloves on.',
 'Combine the caramel ingredients in a saucepan and stir until amber.',
 'Season the lamb shoulder with salt and rosemary.',
 'Season the ribs with the dry rub on all sides.',
 'Toss the shrimp with chili flakes in a bowl.',
 'Arrange the crab legs on a platter with lemon wedges.',
 'Mix the venison with the seasoning in a bowl.',
 'Measure the flour, sugar, and baking soda into a bowl.',
 'Fold the warm custard into the whipped mixture.',
 'Spread the mixture into the hot dish and smooth the top.',
 'Season the hen with salt and herbs all over.',
 'Rub the spice mix all over the pork shoulder.',
 'Season the tenderloin with salt and pepper all over.',
 'Season the roast with salt and pepper all over.',
 'Place the turkey breast in a dish and season well.',
 'Toss the calamari rings with flour and salt in a bowl.',
 'Mix the sauce in the microwave-safe bowl and heat.',
 'Stir together the glaze and brush it over the ham.',
 'Stir together the glaze on medium-low for 3 minutes.',
 'Whisk the dressing and pour over the scalding noodles.',
 'Season the fillets with salt and pepper on both sides.',
 'Mix the marinade and pour it over the steak in a dish.',
 'Combine the ingredients in the food processor and pulse.',
 'Let the oysters rest on ice in a dish for serving.',
  'Combine the marinade with the drumsticks in a bowl.',
  'Season the thighs in a bowl.',
  'Toss the prawns in a bowl.',
  'Whisk the yolks and sugar in a bowl.',
  'Combine the caramel ingredients in a bowl and heat.',
  'Mix the lye solution in a jar.',
  'Whisk the sauce in a bowl until it thickens.',
  'Toss the noodles in a bowl over high heat.',
  ];
  it.each(mustStayFlagged)('keeps this step flagged: %s', (text) => {
    const { recipe: out } = repairMasteryHideableSteps(withFlagged(text));
    expect(out.steps[0].isSafetyStep).toBe(true);
  });

  const mayUnflag = [
    'Measure the spices into a small bowl.',
    'Whisk the lemon juice and herbs in a bowl.',
    'Combine the tofu with soy sauce and ginger in a bowl.',
    'Mix the salt, pepper, and paprika together in a small jar.',
    'Gather the spices on the counter.',
    'Measure out the salt and pepper.',
    'Toss the salad greens with the herb mix on a plate.',
    'Set out the plates and bowls for serving on a plate.',
    'Stir together the vinegar and sugar in a bowl.',
  ];
  it.each(mayUnflag)('may unflag this step: %s', (text) => {
    const { recipe: out } = repairMasteryHideableSteps(withFlagged(text));
    expect(out.steps[0].isSafetyStep).toBe(false);
  });

  it('a rest step does not qualify', () => {
    const { recipe: out } = repairMasteryHideableSteps(withFlagged('Let the dough rest in a bowl for ten minutes.'));
    expect(out.steps[0].isSafetyStep).toBe(true);
  });

  it('a step without a container only qualifies when it starts with gather or measure out', () => {
    expect(repairMasteryHideableSteps(withFlagged('Measure the salt and pepper.')).recipe.steps[0].isSafetyStep).toBe(true);
    expect(repairMasteryHideableSteps(withFlagged('Season the greens with the herb mix.')).recipe.steps[0].isSafetyStep).toBe(true);
  });
});

describe('repairMasteryHideableSteps: round 2 probes', () => {
  const withFlagged = (text: string): Recipe =>
    recipe(['x'], [step(text, true), ...Array.from({ length: 6 }, () => step('Heat the pan over medium heat for two minutes.', true))]);
  const mustStayFlagged = [
 'Combine the raw chicken with the marinade in a bowl.',
 'Season the fish in a bowl.',
 'Mix the marinade in a bowl and add the lamb.',
 'Toss the hot pasta in a bowl.',
 'Whisk the eggs in a bowl.',
 'Whisk the egg whites in a bowl to soft peaks.',
 'Set out a plate for the cooked chicken.',
 'Set out a plate for the cooked thighs.',
 'Combine the marinade and the drumstick in a bowl.',
 'Combine the mince with herbs in a bowl.',
 'Combine the turkey mince in a bowl.',
 'Mix the pork mince and spices in a bowl.',
 'Combine the chicken mince and spices in a bowl.',
 'Combine the veal in a bowl.',
 'Mix the ground chuck with spices in a bowl.',
 'Mix the sirloin strips with marinade in a bowl.',
 'Toss the flank strips with cornstarch in a bowl.',
 'Toss the tilapia with spices in a bowl.',
 'Mix the cubed lamb with yogurt in a bowl.',
 'Combine the beaten egg and milk in a bowl.',
 'Whisk the yolk into the mayo in a bowl.',
 'Combine the ahi with soy sauce in a bowl.',
 'Toss the shrimps with garlic in a bowl.',
 'Toss the langoustines in a bowl.',
 'Combine the chorizo and beans in a bowl.',
 'Mix the bird with herbs in a bowl.',
 'Toss the giblets in a bowl.',
 'Combine the minced meat in a bowl.',
 'Combine the meatball mixture in a bowl.',
 'Mix the kofta mixture in a bowl.',
 'Mix it all in a bowl with the raw protein.',
 'Season the chicken thighs on a plate.',
 'Season the goat on a plate.',
 'Gather the chicken, salt, and pepper.',
 'Gather the ingredients.',
 'Measure out the spices.',
 'Gather a knife and board.',
 'Combine the cured salmon in a bowl.',
 'Toss the oysters in a bowl.',
 'Combine the boiling water and gelatin in a bowl.',
 'Combine the scalding milk in a bowl.',
 'Mix the steaming milk and cocoa in a bowl.',
 'Combine the just-boiled water in a jar.',
 'Toss the duck legs in a bowl.',
 'Combine the venison in a bowl.',
 'Mix the bison in a bowl.',
 'Season the quail on a plate.',
 'Combine the tuna and mayo in a bowl.',
 'Season the meat mixture in a bowl.',
 'Mix the sausage meat in a bowl.',
 'Combine the crab meat in a bowl.',
 'Combine the crabmeat in a bowl.',
 'Combine the beef-and-pork blend in a bowl.',
 'Combine the uncooked chicken in a bowl.',
    'Mix the kebab meat in a bowl.',
    'Combine the chuck roast in a bowl.',
  ];
  it.each(mustStayFlagged)('keeps this step flagged: %s', (text) => {
    expect(repairMasteryHideableSteps(withFlagged(text)).recipe.steps[0].isSafetyStep).toBe(true);
  });
  it.each([
    'Toss the tofu in a bowl with soy sauce.',
    'Combine the salad greens in a bowl.',
    'Whisk the vinaigrette in a jar.',
  ])('may unflag: %s', (text) => {
    expect(repairMasteryHideableSteps(withFlagged(text)).recipe.steps[0].isSafetyStep).toBe(false);
  });
  it('known gap: a vague step that never names the protein can be unflagged', () => {
    expect(repairMasteryHideableSteps(withFlagged('Toss the pieces with salt in a bowl.')).recipe.steps[0].isSafetyStep).toBe(false);
  });
});

describe('diet guard: beef cuts and steak substitutes', () => {
  it.each(['ribeye', 'rib-eye steak', 'sirloin', 'chuck roast', 'ground chuck', 'flank steak', 'skirt steak', 'tri-tip', 'filet mignon', 'T-bone', 'porterhouse', 'strip steak', 'kofta', 'giblets'])(
    'vegetarian and no beef flag %s',
    (name) => {
      expect(findForbiddenTerm(name, 'vegetarian')).not.toBeNull();
    }
  );
  it.each(['ahi tuna', 'langoustines', 'crabmeat', 'crab cakes'])('vegetarian flags %s', (name) => {
    expect(findForbiddenTerm(name, 'vegetarian')).not.toBeNull();
  });
  it.each(['skirt', 'chuck wagon seasoning blend', 'crabapple jelly'])('does not flag %s', (name) => {
    expect(findForbiddenTerm(name, 'vegetarian')).toBeNull();
  });
  it.each(['mushroom steak', 'garlic mushroom steak', 'creamy mushroom steak', 'mushroom steak bites'])('flags %s', (name) => {
    expect(findForbiddenTerm(name, 'vegetarian')).toBe('steak');
  });
  it.each(['portobello steak', 'cauliflower steak', 'tofu steak', 'eggplant steak', 'seitan steak', 'tempeh steak tips'])('allows %s', (name) => {
    expect(findForbiddenTerm(name, 'vegetarian')).toBeNull();
  });
});
