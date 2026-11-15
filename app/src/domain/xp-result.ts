/**
 * Turns the check-in response's `xp` field into what the session-complete
 * screen shows. Honest by design: when XP didn't land (`failed`) or isn't set
 * up (`skipped`), there's no number at all, only what actually happened.
 */
import type { CheckInXp } from '../api/schemas';

export type XpView =
  | { kind: 'first'; amount: number; note: null }
  | { kind: 'repeat'; amount: number; capped: boolean; note: string }
  | { kind: 'pending'; note: string }
  | { kind: 'unavailable'; note: string };

/** `slotXp` is the slot's first-completion XP, used to explain repeats. */
export function toXpView(xp: CheckInXp, slotXp?: number): XpView {
  switch (xp.status) {
    case 'awarded': {
      if (xp.is_first_completion) return { kind: 'first', amount: xp.xp_awarded, note: null };
      if (!xp.capped) return { kind: 'repeat', amount: xp.xp_awarded, capped: false, note: 'Repeats earn half the usual XP.' };
      if (xp.xp_awarded === 0) {
        return { kind: 'repeat', amount: 0, capped: true, note: 'You’ve hit this week’s repeat cap (100 XP), so this repeat earned 0 XP. It still counts as practice.' };
      }
      const usual = slotXp ? ` instead of the usual ${Math.round(slotXp / 2)}` : '';
      return { kind: 'repeat', amount: xp.xp_awarded, capped: true, note: `This repeat reached the weekly repeat cap (100 XP), so it earned ${xp.xp_awarded} XP${usual}.` };
    }
    case 'failed':
      return { kind: 'pending', note: 'Your check-in is saved. The XP for it is still on its way and will show on your path once it lands.' };
    case 'skipped':
      return { kind: 'unavailable', note: 'Your check-in is saved. XP isn’t switched on for this server (dev mode), so nothing was awarded.' };
  }
}

/** "+143". Only for views that have an amount. */
export function formatXpGain(view: XpView): string | null {
  return view.kind === 'first' || view.kind === 'repeat' ? `+${view.amount}` : null;
}
