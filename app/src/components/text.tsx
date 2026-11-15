/**
 * Typography primitives. Every piece of text in the app goes through <T>, so
 * the type scale lives in one place (theme/tokens.ts).
 */
import { Text, type TextProps, type TextStyle } from 'react-native';

import { color, font, type } from '../theme/tokens';

export type TextVariant =
  | 'display' | 'h1' | 'h2' | 'h3' | 'cookStep' | 'stepNumber' | 'xpHero'
  | 'body' | 'bodySemi' | 'small' | 'caption' | 'overline' | 'byline' | 'button' | 'coach' | 'tab';

const variants: Record<TextVariant, TextStyle> = {
  display: { fontFamily: font.display, fontSize: type.display.size, lineHeight: type.display.line, letterSpacing: type.display.tracking, color: color.ink },
  h1: { fontFamily: font.display, fontSize: type.h1.size, lineHeight: type.h1.line, letterSpacing: type.h1.tracking, color: color.ink },
  h2: { fontFamily: font.display, fontSize: type.h2.size, lineHeight: type.h2.line, color: color.ink },
  h3: { fontFamily: font.displaySemi, fontSize: type.h3.size, lineHeight: type.h3.line, color: color.ink },
  // Spec says Fraunces 450; static cuts come in 400/500, so 400 is the closest fixed weight.
  cookStep: { fontFamily: font.displayRegular, fontSize: type.cookStep.size, lineHeight: type.cookStep.line, letterSpacing: -0.15, color: color.ink },
  stepNumber: { fontFamily: font.displayLight, fontSize: type.stepNumber.size, lineHeight: type.stepNumber.line + 12, color: color.tomato },
  xpHero: { fontFamily: font.displayRegular, fontSize: type.xpHero.size, lineHeight: type.xpHero.line + 8, color: color.tomato, fontVariant: ['tabular-nums'] },
  body: { fontFamily: font.body, fontSize: type.body.size, lineHeight: type.body.line, color: color.ink },
  bodySemi: { fontFamily: font.bodySemi, fontSize: type.body.size, lineHeight: type.body.line, color: color.ink },
  small: { fontFamily: font.body, fontSize: type.small.size, lineHeight: type.small.line, color: color.ink2 },
  caption: { fontFamily: font.body, fontSize: type.caption.size, lineHeight: type.caption.line, color: color.ink3 },
  overline: { fontFamily: font.bodyBold, fontSize: type.overline.size, lineHeight: type.overline.line, letterSpacing: type.overline.tracking, textTransform: 'uppercase', color: color.tomato },
  byline: { fontFamily: font.bodyBold, fontSize: type.byline.size, lineHeight: type.byline.line, letterSpacing: type.byline.tracking, textTransform: 'uppercase', color: color.ink2 },
  button: { fontFamily: font.bodySemi, fontSize: type.button.size, lineHeight: type.button.line, letterSpacing: 0.17 },
  // Italic Fraunces is for the coach's voice only.
  coach: { fontFamily: font.displayItalic, fontSize: 16, lineHeight: 23, color: color.ink2 },
  tab: { fontFamily: font.bodySemi, fontSize: type.tab.size, lineHeight: type.tab.line, letterSpacing: 0.44 },
};

export interface TProps extends TextProps {
  variant?: TextVariant;
  color?: keyof typeof color;
}

export function T({ variant = 'body', color: c, style, ...rest }: TProps) {
  return <Text {...rest} style={[variants[variant], c ? { color: color[c] } : null, style]} />;
}
