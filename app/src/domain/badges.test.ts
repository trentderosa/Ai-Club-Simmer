import { badgeCounts, badgeSealLabel } from './badges';

describe('badge shelf helpers', () => {
  it('labels completion, mastery and the path graduate the way the mockup does', () => {
    expect(badgeSealLabel({ kind: 'completion', sort_order: 4 })).toBe('04');
    expect(badgeSealLabel({ kind: 'mastery', sort_order: 10 })).toBe('M');
    expect(badgeSealLabel({ kind: 'path_milestone', sort_order: 100 })).toBe('10');
  });

  it('counts earned vs the catalog', () => {
    const badges = [
      { earned: true },
      { earned: true },
      { earned: false },
    ] as { earned: boolean }[];
    expect(badgeCounts(badges as never)).toEqual({ earned: 2, total: 3 });
  });
});
