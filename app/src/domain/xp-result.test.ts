import { formatXpGain, toXpView } from './xp-result';

describe('toXpView', () => {
  it('shows the full amount on a first completion', () => {
    const v = toXpView({ status: 'awarded', xp_awarded: 143, is_first_completion: true, capped: false }, 143);
    expect(v).toEqual({ kind: 'first', amount: 143, note: null });
    expect(formatXpGain(v)).toBe('+143');
  });

  it('explains an uncapped repeat', () => {
    const v = toXpView({ status: 'awarded', xp_awarded: 72, is_first_completion: false, capped: false }, 143);
    expect(v.kind).toBe('repeat');
    expect(formatXpGain(v)).toBe('+72');
  });

  it('says a capped repeat earned 0 XP', () => {
    const v = toXpView({ status: 'awarded', xp_awarded: 0, is_first_completion: false, capped: true }, 143);
    expect(v).toMatchObject({ kind: 'repeat', amount: 0, capped: true });
    expect(v.note).toMatch(/0 XP/);
  });

  it('says a partly capped repeat earned less than usual', () => {
    const v = toXpView({ status: 'awarded', xp_awarded: 28, is_first_completion: false, capped: true }, 143);
    expect(v.note).toMatch(/28 XP instead of the usual 72/);
  });

  it('never shows a number when XP failed or was skipped', () => {
    const failed = toXpView({ status: 'failed' }, 143);
    expect(failed.kind).toBe('pending');
    expect(failed.note).toMatch(/check-in is saved/i);
    expect(formatXpGain(failed)).toBeNull();
    const skipped = toXpView({ status: 'skipped' });
    expect(skipped.kind).toBe('unavailable');
    expect(formatXpGain(skipped)).toBeNull();
  });
});
