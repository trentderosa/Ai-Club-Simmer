/**
 * Design tokens for UI Direction A ("editorial kitchen").
 *
 * Copied from the proposal's design-tokens.md. Keep these in sync with the
 * mockups; screens should read every color, size and font from here instead of
 * hard-coding values.
 *
 * Color rules: one accent (tomato) per screen, and it marks the next action.
 * Herb only means "done". Butter only means "the coach or a hint".
 */
export const theme = {
  color: {
    paper: '#F7F2E8', paperDeep: '#EFE6D3', sheet: '#FFFDF8',
    ink: '#1F1B16', ink2: '#575046', ink3: '#8B8274', rule: '#DED4C2', ruleSoft: '#EAE2D3',
    tomato: '#C8402B', tomatoDeep: '#9E2F1E', tomatoWash: '#F5DDD4',
    herb: '#4C6A3A', herbWash: '#E2E8D3', butter: '#E3AE3C', butterWash: '#F7E9C2',
    safety: '#A3261A', safetyWash: '#FBE9E4',
    // Not in the token table, but used by the mockup CSS:
    butterInk: '#8A6514', // "Coach's note" overline on butterWash
    lockedRing: '#BFB4A0', // dashed ring on locked path nodes
    lockedText: '#AFA593',
    pathFuture: '#C9BEAA', // dotted connector between locked nodes
    onAccent: '#FFF8F2', // text on tomato
  },
  /**
   * Static font cuts from @expo-google-fonts (one file per weight). React
   * Native can't drive variable axes, so every weight is a fixed file.
   */
  font: {
    display: 'Fraunces_500Medium', displayLight: 'Fraunces_300Light', displayRegular: 'Fraunces_400Regular',
    displaySemi: 'Fraunces_600SemiBold', displayItalic: 'Fraunces_400Regular_Italic',
    body: 'SourceSans3_400Regular', bodySemi: 'SourceSans3_600SemiBold', bodyBold: 'SourceSans3_700Bold',
  },
  type: {
    display: { size: 40, line: 44, tracking: -0.6 }, h1: { size: 32, line: 36, tracking: -0.3 },
    h2: { size: 24, line: 30 }, h3: { size: 19, line: 24 }, cookStep: { size: 31, line: 39 },
    stepNumber: { size: 64, line: 56 }, xpHero: { size: 72, line: 72 },
    body: { size: 17, line: 25 }, small: { size: 15, line: 21 }, caption: { size: 13, line: 18 },
    overline: { size: 12, line: 16, tracking: 1.7 }, byline: { size: 12, line: 16, tracking: 1.2 },
    button: { size: 17, line: 22 }, tab: { size: 11, line: 14 },
  },
  space: { s1: 4, s2: 8, s3: 12, s4: 16, s5: 20, s6: 24, s8: 32, s10: 40, s14: 56, gutter: 24 },
  radius: { sm: 6, md: 10, lg: 16, pill: 999 },
  /** Minimum hit target; cook-mode controls are larger (72). */
  hit: 44,
} as const;

export type Theme = typeof theme;
export const { color, font, type, space, radius } = theme;
