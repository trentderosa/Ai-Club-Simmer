/**
 * Fake data for mock mode. Nothing here is real user data.
 *
 * The 10 slots, their order, technique focus, XP and cook minutes match
 * `path_slots` on main (PRD F7). Recipes and videos are hand-written
 * placeholders in the same shape the ai-server returns; the video ids are
 * made up and never fetched.
 */
import type { Badge, DishPhoto, Recipe, Videos } from '../schemas';

export interface SlotFixture {
  slot_id: number;
  slot_order: number;
  dish_name: string;
  technique_focus: string;
  xp_value: number;
  cook_minutes: number;
  is_final: boolean;
}

export const SLOTS: readonly SlotFixture[] = [
  { slot_id: 1, slot_order: 1, dish_name: 'Knife Basics Salad', technique_focus: 'Knife skills', xp_value: 102, cook_minutes: 20, is_final: false },
  { slot_id: 2, slot_order: 2, dish_name: 'Scrambled Eggs', technique_focus: 'Heat control', xp_value: 62, cook_minutes: 10, is_final: false },
  { slot_id: 3, slot_order: 3, dish_name: 'Pasta with Sauce', technique_focus: 'Boiling and timing', xp_value: 75, cook_minutes: 18, is_final: false },
  { slot_id: 4, slot_order: 4, dish_name: 'Stir-Fry Vegetables', technique_focus: 'High-heat sautéing', xp_value: 143, cook_minutes: 35, is_final: false },
  { slot_id: 5, slot_order: 5, dish_name: 'Grilled Cheese', technique_focus: 'Pan toasting', xp_value: 65, cook_minutes: 18, is_final: false },
  { slot_id: 6, slot_order: 6, dish_name: 'Rice Bowl', technique_focus: 'Rice cooking', xp_value: 105, cook_minutes: 25, is_final: false },
  { slot_id: 7, slot_order: 7, dish_name: 'Sheet Pan Vegetables', technique_focus: 'Roasting basics', xp_value: 137, cook_minutes: 38, is_final: false },
  { slot_id: 8, slot_order: 8, dish_name: 'Seared Chicken Breast', technique_focus: 'Protein searing', xp_value: 80, cook_minutes: 20, is_final: false },
  { slot_id: 9, slot_order: 9, dish_name: 'Simple Soup', technique_focus: 'Building flavor', xp_value: 148, cook_minutes: 40, is_final: false },
  { slot_id: 10, slot_order: 10, dish_name: 'Roast Chicken', technique_focus: 'Complete meal execution', xp_value: 181, cook_minutes: 80, is_final: true },
];

/**
 * FAKE stand-in for the curated dish catalog that personalize_my_path reads in
 * the real database. A few cuisines and slots only; other slots keep the
 * canonical dish. `chicken` dishes swap to `alt` for vegetarian, vegan or
 * no-poultry users. Technique focus and XP never change per user.
 */
export const MOCK_DISH_CATALOG: Record<string, Record<number, { name: string; chicken?: boolean; alt?: string }>> = {
  mexican: {
    1: { name: 'Pico de Gallo' },
    4: { name: 'Chicken Fajitas', chicken: true, alt: 'Veggie Fajitas' },
    6: { name: 'Burrito Bowl' },
  },
  italian: {
    1: { name: 'Caprese Salad' },
    4: { name: 'Garlic Shrimp and Peppers' },
    9: { name: 'Minestrone' },
  },
  japanese: {
    2: { name: 'Tamagoyaki' },
    6: { name: 'Teriyaki Chicken Rice Bowl', chicken: true, alt: 'Teriyaki Tofu Rice Bowl' },
    9: { name: 'Miso Soup' },
  },
};

/** The canonical slot-8 dish is chicken, so meatless users get this in mock mode. */
export const MOCK_MEATLESS_SLOT_DISHES: Record<number, string> = { 8: 'Seared Tofu Steaks' };

/** Signing in (not up) in mock mode lands on this user: 3 slots done, 239 XP. */
export const DEMO_USER = {
  email: 'demo@simmer.test',
  firstName: 'Jordan',
  completedSlots: 3,
  /** Slot 2 was cooked twice so the book can show a repeat count. */
  extraCooks: { 2: 1 } as Record<number, number>,
  /** Matches the Direction A profile mockup ("Cooking since Nov 2"). */
  createdAt: '2026-11-02T12:00:00.000Z',
  /**
   * First-completion dates for the demo book, newest last. Formatted in UTC
   * so they stay on the calendar day we intend.
   */
  addedAt: {
    1: '2026-11-08T12:00:00.000Z',
    2: '2026-11-10T12:00:00.000Z',
    3: '2026-11-12T12:00:00.000Z',
  } as Record<number, string>,
} as const;

/**
 * Mock-mode sign-in shortcut so F8 is reachable without cooking slots 1–9.
 * Sign in with this email (any password). The default demo user is unchanged.
 */
export const MASTERY_USER = {
  email: 'mastery@simmer.test',
  firstName: 'Riley',
  /** Slots 1–9 done; slot 10 (Roast Chicken) is current. */
  completedSlots: 9,
  extraCooks: {} as Record<number, number>,
  createdAt: '2026-10-15T12:00:00.000Z',
  addedAt: {
    1: '2026-10-18T12:00:00.000Z',
    2: '2026-10-20T12:00:00.000Z',
    3: '2026-10-22T12:00:00.000Z',
    4: '2026-10-25T12:00:00.000Z',
    5: '2026-10-27T12:00:00.000Z',
    6: '2026-10-29T12:00:00.000Z',
    7: '2026-11-02T12:00:00.000Z',
    8: '2026-11-05T12:00:00.000Z',
    9: '2026-11-08T12:00:00.000Z',
  } as Record<number, string>,
} as const;

/** First-completion XP for slots 1–9, the starting total for MASTERY_USER. */
export const MASTERY_USER_XP = 917;

/**
 * The 11-badge catalog from migration 20261115000000 (codes and names are
 * stable; Ian owns the display names).
 */
export const BADGES: readonly Omit<Badge, 'earned' | 'earned_at'>[] = [
  { code: 'complete_slot_1', name: 'Knife Basics Salad', description: 'Cooked Knife Basics Salad and checked in.', kind: 'completion', slot_id: 1, sort_order: 1 },
  { code: 'complete_slot_2', name: 'Scrambled Eggs', description: 'Cooked Scrambled Eggs and checked in.', kind: 'completion', slot_id: 2, sort_order: 2 },
  { code: 'complete_slot_3', name: 'Pasta with Sauce', description: 'Cooked Pasta with Sauce and checked in.', kind: 'completion', slot_id: 3, sort_order: 3 },
  { code: 'complete_slot_4', name: 'Stir-Fry Vegetables', description: 'Cooked Stir-Fry Vegetables and checked in.', kind: 'completion', slot_id: 4, sort_order: 4 },
  { code: 'complete_slot_5', name: 'Grilled Cheese', description: 'Cooked Grilled Cheese and checked in.', kind: 'completion', slot_id: 5, sort_order: 5 },
  { code: 'complete_slot_6', name: 'Rice Bowl', description: 'Cooked Rice Bowl and checked in.', kind: 'completion', slot_id: 6, sort_order: 6 },
  { code: 'complete_slot_7', name: 'Sheet Pan Vegetables', description: 'Cooked Sheet Pan Vegetables and checked in.', kind: 'completion', slot_id: 7, sort_order: 7 },
  { code: 'complete_slot_8', name: 'Seared Chicken Breast', description: 'Cooked Seared Chicken Breast and checked in.', kind: 'completion', slot_id: 8, sort_order: 8 },
  { code: 'complete_slot_9', name: 'Simple Soup', description: 'Cooked Simple Soup and checked in.', kind: 'completion', slot_id: 9, sort_order: 9 },
  { code: 'mastery', name: 'Roast Chicken Mastery', description: 'Passed the mastery challenge: cooked Roast Chicken with the steps hidden.', kind: 'mastery', slot_id: 10, sort_order: 10 },
  { code: 'path_weeknight_basics', name: 'Weeknight Basics Graduate', description: 'Finished all 10 recipes on the Weeknight basics path.', kind: 'path_milestone', slot_id: null, sort_order: 100 },
];

export const MOCK_COACH_NOTES: Record<number, string> = {
  4: 'Last time heat control was tricky with the eggs. Here you want it high the whole time, so get everything chopped before the pan goes on.',
  5: 'Your stir-fry moved fast. Grilled cheese is the opposite: medium-low and patient, so the cheese melts before the bread burns.',
};

const r = (
  title: string,
  timeEstimateMinutes: number,
  ingredients: [string, string][],
  steps: Recipe['steps'],
): Recipe => ({ title, timeEstimateMinutes, ingredients: ingredients.map(([amount, name]) => ({ amount, name })), steps });

export const RECIPES: Record<number, Recipe> = {
  1: r('Crunchy Knife Basics Salad', 20, [['1', 'cucumber'], ['1 pint', 'cherry tomatoes'], ['½', 'red onion'], ['1 head', 'romaine lettuce'], ['2 tbsp', 'olive oil'], ['1 tbsp', 'lemon juice'], ['1 pinch', 'salt']], [
    { instruction: 'Set a damp towel under your cutting board so it can’t slide.', isSafetyStep: true, whyItMatters: 'A board that moves is how most knife cuts happen.' },
    { instruction: 'Curl your fingertips into a claw and slice the cucumber into thin rounds.', isSafetyStep: true, techniqueName: 'Claw grip' },
    { instruction: 'With your knife, halve the cherry tomatoes and thinly slice the red onion. Keep the claw grip.', isSafetyStep: true, techniqueName: 'Slice an onion' },
    { instruction: 'Tear the romaine into bite-size pieces with your hands.', isSafetyStep: false },
    { instruction: 'Whisk the olive oil, lemon juice and salt, then toss everything together.', isSafetyStep: false, whyItMatters: 'Dress right before eating so the lettuce stays crisp.' },
  ]),
  2: r('Soft Scrambled Eggs', 10, [['3', 'eggs'], ['1 tbsp', 'butter'], ['1 pinch', 'salt'], ['1 tbsp', 'chives, chopped']], [
    { instruction: 'Whisk the eggs with a pinch of salt until no streaks are left.', isSafetyStep: false, techniqueName: 'Whisk eggs', whyItMatters: 'Salt early and the eggs stay tender.' },
    { instruction: 'Melt the butter in a nonstick pan over low heat for 1 minute.', isSafetyStep: true },
    { instruction: 'Pour in the eggs and stir slowly with a spatula for 3 minutes.', isSafetyStep: false, whyItMatters: 'Low heat makes small, soft curds.' },
    { instruction: 'Take the pan off the heat while the eggs still look a little wet, then top with chives.', isSafetyStep: false },
  ]),
  3: r('Weeknight Tomato Pasta', 18, [['8 oz', 'spaghetti'], ['1 can', 'crushed tomatoes'], ['2 cloves', 'garlic, sliced'], ['2 tbsp', 'olive oil'], ['1 tbsp', 'salt'], ['¼ cup', 'parmesan']], [
    { instruction: 'Bring a large pot of water to a boil and add the salt.', isSafetyStep: true },
    { instruction: 'Cook the spaghetti for 9 minutes, stirring once or twice.', isSafetyStep: false, techniqueName: 'Cook pasta al dente' },
    { instruction: 'Meanwhile, warm the olive oil and garlic in a pan over medium heat for 2 minutes.', isSafetyStep: false },
    { instruction: 'Add the crushed tomatoes and simmer for 5 minutes.', isSafetyStep: false },
    { instruction: 'Drain the pasta carefully, toss it in the sauce, and top with parmesan.', isSafetyStep: true, whyItMatters: 'Steam from a draining pot burns fast. Pour away from you.' },
  ]),
  4: r('Weeknight Vegetable Stir-Fry', 35, [['1 small head', 'broccoli, cut into florets'], ['1', 'red bell pepper, sliced'], ['1', 'carrot, thinly sliced'], ['½', 'yellow onion, sliced'], ['3 cloves', 'garlic, minced'], ['1 inch', 'ginger, grated'], ['3 tbsp', 'soy sauce'], ['1 tbsp', 'honey'], ['1 tbsp', 'rice vinegar'], ['1 tsp', 'cornstarch'], ['2 tbsp', 'neutral oil'], ['1 cup', 'rice, cooked'], ['2', 'scallions, sliced']], [
    { instruction: 'Slice the pepper, carrot and onion thin, and cut the broccoli into bite-size florets.', isSafetyStep: true, techniqueName: 'Slice a bell pepper', whyItMatters: 'Thin, even pieces cook at the same speed in a hot pan.' },
    { instruction: 'Whisk the soy sauce, honey, rice vinegar, cornstarch and ¼ cup water.', isSafetyStep: false, whyItMatters: 'Cornstarch is what turns thin sauce glossy in the last minute.' },
    { instruction: 'Heat the oil in a large pan over high heat for 1 minute, until it shimmers.', isSafetyStep: true, whyItMatters: 'Hot oil can spit. Keep your face back and add food away from you.' },
    { instruction: 'Add the carrot and broccoli. Toss every 30 seconds until bright green with a few brown spots, about 3 minutes.', isSafetyStep: false, techniqueName: 'Stir-fry vegetables', whyItMatters: 'Dense vegetables go in first. Give them room so they sear instead of steam.' },
    { instruction: 'Add the pepper and onion. In the last minute, stir in the garlic and ginger, about 2 minutes.', isSafetyStep: false, whyItMatters: 'Garlic burns in under a minute on high heat, so it goes in last.' },
    { instruction: 'Pour in the sauce and toss until glossy, about 1 minute. Serve over rice with scallions.', isSafetyStep: false },
  ]),
  5: r('Golden Grilled Cheese', 18, [['2 slices', 'bread'], ['2 slices', 'cheddar'], ['1 tbsp', 'butter, softened']], [
    { instruction: 'Butter one side of each slice of bread.', isSafetyStep: false },
    { instruction: 'Heat a pan over medium-low heat for 2 minutes.', isSafetyStep: true },
    { instruction: 'Build the sandwich butter-side out and cook for 4 minutes, until golden.', isSafetyStep: false, techniqueName: 'Pan toast a sandwich' },
    { instruction: 'Flip with a spatula and cook the other side for 3 minutes.', isSafetyStep: false, whyItMatters: 'Low heat gives the cheese time to melt.' },
  ]),
  6: r('Simple Rice Bowl', 25, [['1 cup', 'jasmine rice'], ['1½ cups', 'water'], ['1 can', 'black beans, rinsed'], ['1', 'avocado'], ['1 cup', 'corn'], ['1', 'lime'], ['1 pinch', 'salt']], [
    { instruction: 'Rinse the rice in a strainer until the water runs clear.', isSafetyStep: false, techniqueName: 'Rinse rice', whyItMatters: 'Rinsing washes off starch so the rice isn’t gummy.' },
    { instruction: 'Bring the rice, water and salt to a boil, then cover and simmer on low for 15 minutes.', isSafetyStep: true },
    { instruction: 'Take it off the heat and let it sit, covered, for 5 minutes.', isSafetyStep: false },
    { instruction: 'Warm the beans and corn, slice the avocado, and build the bowls with a squeeze of lime.', isSafetyStep: true },
  ]),
  7: r('Sheet Pan Vegetables', 38, [['2', 'sweet potatoes, cubed'], ['1 head', 'broccoli'], ['1', 'red onion'], ['3 tbsp', 'olive oil'], ['1 tsp', 'salt'], ['½ tsp', 'pepper']], [
    { instruction: 'Heat the oven to 425°F with a rack in the middle.', isSafetyStep: true },
    { instruction: 'Cut the sweet potatoes into 1-inch cubes and the onion into wedges.', isSafetyStep: true, techniqueName: 'Cube a sweet potato' },
    { instruction: 'Toss everything with oil, salt and pepper and spread it out on a sheet pan.', isSafetyStep: false, whyItMatters: 'Crowded vegetables steam. Leave space between pieces.' },
    { instruction: 'Roast for 25 minutes, flipping once halfway. Use oven mitts.', isSafetyStep: true },
  ]),
  8: r('Pan-Seared Chicken Breast', 20, [['2', 'chicken breasts'], ['1 tbsp', 'neutral oil'], ['1 tsp', 'salt'], ['½ tsp', 'pepper'], ['1 tbsp', 'butter']], [
    { instruction: 'Pat the chicken dry with paper towels (don’t rinse it), season both sides, then wash your hands and the board.', isSafetyStep: true, whyItMatters: 'Raw chicken spreads bacteria to anything it touches.' },
    { instruction: 'Heat the oil in a skillet over medium-high heat for 2 minutes.', isSafetyStep: true },
    { instruction: 'Sear the chicken without moving it for 6 minutes, until deep golden.', isSafetyStep: false, techniqueName: 'Sear chicken' },
    { instruction: 'Flip, add the butter, and cook about 5 minutes more, until a thermometer in the thickest part reads 165°F.', isSafetyStep: true, whyItMatters: '165°F is the safe temperature for chicken. Color alone can fool you.' },
    { instruction: 'Rest the chicken for 5 minutes so the juices settle.', isSafetyStep: false },
    { instruction: 'Slice it with a sharp knife on a clean board, not the one the raw chicken touched.', isSafetyStep: true },
  ]),
  9: r('Simple Vegetable Soup', 40, [['1', 'onion, diced'], ['2', 'carrots, diced'], ['2 stalks', 'celery, diced'], ['2 cloves', 'garlic'], ['4 cups', 'vegetable broth'], ['1 can', 'diced tomatoes'], ['2 tbsp', 'olive oil']], [
    { instruction: 'Dice the onion, carrots and celery the same size.', isSafetyStep: true, techniqueName: 'Dice an onion' },
    { instruction: 'Cook them in the oil over medium heat for 8 minutes, until soft.', isSafetyStep: false, whyItMatters: 'Softening the vegetables first builds the soup’s flavor.' },
    { instruction: 'Add the garlic for 1 minute, then the broth and tomatoes.', isSafetyStep: false },
    { instruction: 'Simmer for 20 minutes, then taste and add salt.', isSafetyStep: true },
  ]),
  10: r('Roast Chicken with Lemon', 80, [['1', 'whole chicken (4 lb)'], ['1', 'lemon'], ['1 head', 'garlic']], [
    { instruction: 'Heat the oven to 425°F with a rack in the middle.', isSafetyStep: true },
    { instruction: 'With a sharp knife, halve the lemon and the garlic head crosswise. Curl your fingertips into a claw.', isSafetyStep: true },
    { instruction: 'Pat the chicken dry with paper towels (don’t rinse it), then wash your hands and the board.', isSafetyStep: true, whyItMatters: 'Rinsing raw chicken splashes bacteria around the sink. Patting it dry is safer and browns better.' },
    { instruction: 'Rub with oil, then salt and pepper generously, inside and out.', isSafetyStep: false },
    { instruction: 'Tuck the lemon and garlic halves inside the chicken.', isSafetyStep: false },
    { instruction: 'Roast for about 60 minutes, until a thermometer in the thickest part of the thigh reads 165°F. Use oven mitts.', isSafetyStep: true, techniqueName: 'Check chicken temperature' },
    { instruction: 'Rest the chicken for 15 minutes so the juices settle.', isSafetyStep: false },
    { instruction: 'Carve with a sharp knife on a clean board, holding the bird steady with a fork.', isSafetyStep: true },
  ]),
};

/**
 * Fake technique videos. Deliberately partial (e.g. slot 4 has 2 of 3, slot
 * 10 has none) to exercise the "videos can be partial or {}" path.
 */
export const VIDEOS: Record<number, Videos> = {
  1: { 'Claw grip': { videoId: 'mockVideo01', title: 'The claw grip for safer slicing', channelTitle: 'Placeholder' } },
  2: { 'Whisk eggs': { videoId: 'mockVideo02', title: 'How to whisk eggs', channelTitle: 'Placeholder' } },
  3: { 'Cook pasta al dente': { videoId: 'mockVideo03', title: 'Cooking pasta al dente', channelTitle: 'Placeholder' } },
  4: {
    'Slice a bell pepper': { videoId: 'mockVideo04', title: 'How to slice a bell pepper', channelTitle: 'Placeholder' },
    'Stir-fry vegetables': { videoId: 'mockVideo05', title: 'How to stir-fry vegetables for beginners', channelTitle: 'Placeholder' },
  },
  5: { 'Pan toast a sandwich': { videoId: 'mockVideo06', title: 'Grilled cheese, low and slow', channelTitle: 'Placeholder' } },
  8: { 'Sear chicken': { videoId: 'mockVideo07', title: 'How to sear chicken breast', channelTitle: 'Placeholder' } },
};

export const MOCK_CHECK_IN_REPLIES: Record<'easy' | 'ok' | 'hard', { note: string; focus: string }> = {
  easy: { note: 'That went smoothly. Next time, try it with a little less looking at the recipe.', focus: 'cooking from memory' },
  ok: { note: 'Crisp vegetables mean your heat was right. Next time, add the garlic in the last minute so it toasts instead of burning.', focus: 'timing aromatics' },
  hard: { note: 'Rough nights happen. Next time, prep everything before the pan goes on, so the cooking part is just moving things around.', focus: 'prep before heat' },
};

/**
 * Canned cook-anything recipe used in mock mode for any typed dish.
 * Counts: 5 steps, 6 ingredients, 20 minutes.
 * XP = max(1, round((5*0.45 + 6*0.35 + 20*0.2)*10)) = 84.
 */
export const CANNED_COOK_ANYTHING_COUNTS = { steps: 5, ingredients: 6, minutes: 20 } as const;
export const CANNED_COOK_ANYTHING_XP = 84;

export function cannedCookAnythingRecipe(dishTitle: string): Recipe {
  return r(dishTitle, 20, [
    ['8 oz', 'pasta'],
    ['2 tbsp', 'butter'],
    ['3 cloves', 'garlic, sliced'],
    ['¼ cup', 'grated parmesan'],
    ['1 pinch', 'salt'],
    ['1 pinch', 'black pepper'],
  ], [
    { instruction: 'Bring a pot of salted water to a boil and cook the pasta for 9 minutes.', isSafetyStep: true, techniqueName: 'Cook pasta al dente', whyItMatters: 'Salty water seasons the pasta while it cooks.' },
    { instruction: 'Melt the butter in a pan over medium heat and cook the garlic for 1 minute, until it smells toasty.', isSafetyStep: true, whyItMatters: 'Garlic burns in under a minute, so keep the heat moderate and stay close.' },
    { instruction: 'Drain the pasta carefully and toss it in the garlic butter.', isSafetyStep: true },
    { instruction: 'Add the parmesan, salt and pepper, and toss until the sauce looks creamy.', isSafetyStep: false },
    { instruction: 'Taste, adjust the salt, and serve right away.', isSafetyStep: false },
  ]);
}

export const CANNED_COOK_ANYTHING_VIDEOS: Videos = {
  'Cook pasta al dente': { videoId: 'mockVideoCA1', title: 'Cooking pasta al dente', channelTitle: 'Placeholder' },
};

/** Placeholder "watch someone make it" rows. Mock mode does not open them. */
export const CANNED_DISH_VIDEOS = [
  { videoId: 'mockDishVid1', title: 'How to make it', channelTitle: 'Placeholder' },
];

/**
 * Canned Commons-shaped photo for mock Cook anything recipes. The URL is a
 * real upload.wikimedia.org path so the hero credit UI can be exercised;
 * unit tests never fetch it. The dish "invisible stew" returns no photo so
 * the board.jpg fallback can be checked.
 */
export const CANNED_COOK_ANYTHING_PHOTO: DishPhoto = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Good_Food_Display_-_NCI_Visuals_Online.jpg/1280px-Good_Food_Display_-_NCI_Visuals_Online.jpg',
  credit: {
    author: 'National Cancer Institute',
    license: 'Public domain',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Good_Food_Display_-_NCI_Visuals_Online.jpg',
  },
};

export const MOCK_DISH_WITHOUT_PHOTO = 'invisible stew';

export function cannedCookAnythingPhoto(normalizedDishName: string): DishPhoto | null {
  return normalizedDishName === MOCK_DISH_WITHOUT_PHOTO ? null : CANNED_COOK_ANYTHING_PHOTO;
}
