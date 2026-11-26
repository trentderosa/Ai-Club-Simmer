import { act } from 'react';
import TestRenderer from 'react-test-renderer';

import type { Profile, ProfileInput } from '../api';
import { OnboardingForm } from './onboarding-form';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

type Node = TestRenderer.ReactTestInstance;

function textOf(node: Node): string {
  return node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

function setup(initial?: Profile) {
  const onSave = jest.fn<void, [ProfileInput]>();
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(initial ? <OnboardingForm mode="edit" initial={initial} onSave={onSave} /> : <OnboardingForm mode="create" onSave={onSave} />);
  });
  const all = () => r.root.findAll(() => true);
  const press = (label: string, role?: string) => {
    const hit = r.root.findAll((n) => typeof n.props.onPress === 'function' && (!role || n.props.accessibilityRole === role) && (role === 'checkbox' ? textOf(n) === label : textOf(n).startsWith(label)));
    if (!hit.length) throw new Error(`nothing to press for "${label}"`);
    if (hit.some((n) => n.props.disabled || n.props.accessibilityState?.disabled)) return; // like a disabled button
    act(() => hit[0].props.onPress());
  };
  const checked = (label: string) => {
    const hit = r.root.findAll((n) => n.props.accessibilityRole === 'checkbox' && textOf(n) === label);
    return hit[0]?.props.accessibilityState?.checked as boolean | undefined;
  };
  const stepLabel = () => all().find((n) => n.props.accessibilityLabel?.startsWith?.('Step '))?.props.accessibilityLabel as string;
  const hasText = (t: string) => JSON.stringify(r.toJSON()).includes(t);
  return { onSave, press, checked, stepLabel, hasText };
}

function toTastesStep(h: ReturnType<typeof setup>) {
  h.press('A little');
  h.press('Continue');
}

describe('OnboardingForm', () => {
  it('has five steps and the new tastes step comes after experience and goals', () => {
    const h = setup();
    expect(h.stepLabel()).toBe('Step 2 of 5');
    h.press('A little');
    h.press('Continue');
    expect(h.stepLabel()).toBe('Step 3 of 5');
    expect(h.hasText('We’ll pick dishes you’ll actually want to cook for each skill.')).toBe(true);
    h.press('Continue'); // all optional
    expect(h.stepLabel()).toBe('Step 4 of 5');
    h.press('Continue'); // kitchen: budget is required
    expect(h.stepLabel()).toBe('Step 4 of 5');
    h.press('Keep it cheap');
    h.press('Continue');
    expect(h.stepLabel()).toBe('Step 5 of 5');
    expect(h.hasText('Build my path')).toBe(true);
  });

  it('selects and deselects chips', () => {
    const h = setup();
    toTastesStep(h);
    expect(h.checked('Mexican')).toBe(false);
    h.press('Mexican', 'checkbox');
    expect(h.checked('Mexican')).toBe(true);
    h.press('Mexican', 'checkbox');
    expect(h.checked('Mexican')).toBe(false);
  });

  it('selecting Vegan also selects Vegetarian, and deselecting Vegetarian drops Vegan', () => {
    const h = setup();
    toTastesStep(h);
    h.press('Vegan', 'checkbox');
    expect(h.checked('Vegan')).toBe(true);
    expect(h.checked('Vegetarian')).toBe(true);
    h.press('Vegetarian', 'checkbox');
    expect(h.checked('Vegetarian')).toBe(false);
    expect(h.checked('Vegan')).toBe(false);
  });

  it('saves the taste answers as lowercase stored values', () => {
    const h = setup();
    toTastesStep(h);
    h.press('Middle Eastern', 'checkbox');
    h.press('Mexican', 'checkbox');
    h.press('Quick weeknight dinners', 'checkbox');
    h.press('Vegan', 'checkbox');
    h.press('Nut allergy', 'checkbox');
    h.press('Continue');
    h.press('Keep it cheap');
    h.press('Continue');
    h.press('Build my path');
    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(h.onSave.mock.calls[0][0]).toMatchObject({
      cuisines: ['middle_eastern', 'mexican'],
      meal_types: ['quick_weeknight'],
      dietary_needs: ['vegan', 'vegetarian', 'nut_free'],
    });
  });

  it('saves empty lists when the tastes step is skipped', () => {
    const h = setup();
    toTastesStep(h);
    h.press('Continue');
    h.press('Keep it cheap');
    h.press('Continue');
    h.press('Build my path');
    expect(h.onSave.mock.calls[0][0]).toMatchObject({ cuisines: [], meal_types: [], dietary_needs: [] });
  });

  describe('edit mode and the taste preload', () => {
    const stored: Profile = {
      id: 'u1',
      goals: null,
      experience_level: 'a_little',
      equipment: ['stove'],
      budget: 'low',
      days_per_week: 3,
      minutes_per_session: 30,
      onboarding_completed: true,
      cuisines: [],
      meal_types: [],
      dietary_needs: [],
      tasteLoaded: true,
    };

    function saveFromEdit(h: ReturnType<typeof setup>, touch?: () => void) {
      h.press('Continue'); // step 2 -> 3
      touch?.();
      h.press('Continue'); // -> 4
      h.press('Continue'); // -> 5
      h.press('Save changes');
      return h.onSave.mock.calls[0][0];
    }

    it('a normal load sends the taste fields', () => {
      expect(saveFromEdit(setup(stored)).includeTaste).toBe(true);
    });

    it('a stale preload (loaded without the taste columns) does not send them', () => {
      expect(saveFromEdit(setup({ ...stored, tasteLoaded: false })).includeTaste).toBe(false);
    });

    it('touching the taste step on a stale preload sends the answers the user chose', () => {
      const h = setup({ ...stored, tasteLoaded: false });
      const input = saveFromEdit(h, () => h.press('Vegan', 'checkbox'));
      expect(input.includeTaste).toBe(true);
      expect(input.dietary_needs).toEqual(['vegan', 'vegetarian']);
    });

    it('a new user always sends them', () => {
      const h = setup();
      toTastesStep(h);
      h.press('Continue');
      h.press('Keep it cheap');
      h.press('Continue');
      h.press('Build my path');
      expect(h.onSave.mock.calls[0][0].includeTaste).toBe(true);
    });
  });
});
