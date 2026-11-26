/**
 * The four onboarding steps (about you, what you like to eat, your kitchen,
 * your week). Used for first-time setup and for editing answers from the profile.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Cuisine, DietaryNeed, MealType, Profile, ProfileInput } from '../api';
import { Button, IconButton } from './button';
import { Chip, Chips, OptionRow } from './choice';
import { gutter, Screen } from './layout';
import { T } from './text';
import {
  BUDGET_OPTIONS,
  CUISINE_OPTIONS,
  DEFAULT_EQUIPMENT,
  DIETARY_OPTIONS,
  EQUIPMENT_OPTIONS,
  EXPERIENCE_OPTIONS,
  GOAL_OPTIONS,
  MEAL_TYPE_OPTIONS,
  MINUTES_OPTIONS,
  capEquipment,
  joinGoals,
  parseGoals,
  toggleDietary,
} from '../domain/profile-copy';
import { color, font, space } from '../theme/tokens';

export type OnboardingStep = 2 | 3 | 4 | 5;

export interface OnboardingFormProps {
  mode: 'create' | 'edit';
  initial?: Profile | null;
  saving?: boolean;
  error?: string | null;
  onSave: (input: ProfileInput) => void;
  onCancel?: () => void;
  onSignOut?: () => void;
}

export function valuesFromProfile(profile: Profile | null | undefined): {
  experience: ProfileInput['experience_level'] | null;
  goals: string[];
  equipment: string[];
  budget: ProfileInput['budget'] | null;
  days: number;
  minutes: number;
  cuisines: string[];
  mealTypes: string[];
  dietary: string[];
  tasteLoaded: boolean;
} {
  return {
    experience: profile?.experience_level ?? null,
    goals: parseGoals(profile?.goals),
    equipment: profile?.equipment && profile.equipment.length > 0 ? [...profile.equipment] : [...DEFAULT_EQUIPMENT],
    budget: profile?.budget ?? null,
    days: profile?.days_per_week ?? 3,
    minutes: profile?.minutes_per_session ?? 30,
    cuisines: [...(profile?.cuisines ?? [])],
    mealTypes: [...(profile?.meal_types ?? [])],
    dietary: [...(profile?.dietary_needs ?? [])],
    tasteLoaded: profile?.tasteLoaded ?? true,
  };
}

export function OnboardingForm({ mode, initial, saving, error, onSave, onCancel, onSignOut }: OnboardingFormProps) {
  const seed = valuesFromProfile(mode === 'edit' ? initial : null);
  const [step, setStep] = useState<OnboardingStep>(2);
  const [experience, setExperience] = useState<ProfileInput['experience_level'] | null>(seed.experience);
  const [goals, setGoals] = useState<string[]>(seed.goals);
  const [equipment, setEquipment] = useState<string[]>(seed.equipment);
  const [budget, setBudget] = useState<ProfileInput['budget'] | null>(seed.budget);
  const [days, setDays] = useState(seed.days);
  const [minutes, setMinutes] = useState(seed.minutes);
  const [cuisines, setCuisines] = useState<string[]>(seed.cuisines);
  const [mealTypes, setMealTypes] = useState<string[]>(seed.mealTypes);
  const [dietary, setDietary] = useState<string[]>(seed.dietary);
  // Chips that were preloaded without the user's stored answers must not overwrite them unless touched.
  const [tasteTouched, setTasteTouched] = useState(false);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const canContinue = step === 2 ? experience !== null : step === 4 ? equipment.length > 0 && budget !== null : true;

  function submit() {
    if (!experience || !budget) return;
    onSave({
      goals: joinGoals(goals),
      experience_level: experience,
      equipment,
      budget,
      days_per_week: days,
      minutes_per_session: minutes,
      cuisines: cuisines as Cuisine[],
      meal_types: mealTypes as MealType[],
      dietary_needs: dietary as DietaryNeed[],
      includeTaste: seed.tasteLoaded || tasteTouched,
    });
  }

  const next = () => (step === 5 ? submit() : setStep((step + 1) as OnboardingStep));
  const back = () => {
    if (step > 2) setStep((step - 1) as OnboardingStep);
    else onCancel?.();
  };
  const showBack = step > 2 || (mode === 'edit' && !!onCancel);

  return (
    <Screen
      footer={
        <Button
          label={step === 5 ? (mode === 'edit' ? 'Save changes' : 'Build my path') : 'Continue'}
          kind="ink"
          onPress={next}
          disabled={!canContinue}
          loading={saving}
          style={{ flex: 1 }}
        />
      }
    >
      <View style={styles.top}>
        {showBack ? <IconButton icon="back" label="Back" onPress={back} /> : <View style={{ width: 44 }} />}
        <View style={styles.bar} accessibilityLabel={`Step ${step} of 5`}>
          {[1, 2, 3, 4, 5].map((i) => (
            <View key={i} style={[styles.barSeg, i <= step && styles.barOn]} />
          ))}
        </View>
        <T variant="caption" style={styles.stepLabel}>
          {step} of 5
        </T>
      </View>

      {step === 2 ? (
        <>
          <Intro over="About you" title={['Let’s start where ', 'you', ' are.']} body="Everyone learns the same ten skills. This changes how we write them for you." />
          <Question title="How much have you cooked?">
            {EXPERIENCE_OPTIONS.map((o, i) => (
              <OptionRow key={o.value} first={i === 0} title={o.title} subtitle={o.subtitle} selected={experience === o.value} onPress={() => setExperience(o.value)} />
            ))}
          </Question>
          <Question title="What do you want out of this?" aside="Pick any">
            <Chips>
              {GOAL_OPTIONS.map((g) => (
                <Chip key={g} label={g} selected={goals.includes(g)} onPress={() => toggle(goals, setGoals, g)} />
              ))}
            </Chips>
          </Question>
          <T variant="caption" style={[gutter, { marginTop: 24 }]}>
            Next: what you like to eat, your kitchen, then your week.
          </T>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Intro over="Your tastes" title={['What do you like to ', 'eat', '?']} body="We’ll pick dishes you’ll actually want to cook for each skill." />
          <Question title="Cuisines you like" aside="Pick any">
            <Chips>
              {CUISINE_OPTIONS.map((o) => (
                <Chip key={o.value} label={o.label} selected={cuisines.includes(o.value)} onPress={() => { setTasteTouched(true); toggle(cuisines, setCuisines, o.value); }} />
              ))}
            </Chips>
          </Question>
          <Question title="What kind of meals?" aside="Pick any">
            <Chips>
              {MEAL_TYPE_OPTIONS.map((o) => (
                <Chip key={o.value} label={o.label} selected={mealTypes.includes(o.value)} onPress={() => { setTasteTouched(true); toggle(mealTypes, setMealTypes, o.value); }} />
              ))}
            </Chips>
          </Question>
          <Question title="Anything you don’t eat?" aside="Pick any">
            <Chips>
              {DIETARY_OPTIONS.map((o) => (
                <Chip key={o.value} label={o.label} selected={dietary.includes(o.value)} onPress={() => { setTasteTouched(true); setDietary(toggleDietary(dietary, o.value)); }} />
              ))}
            </Chips>
          </Question>
        </>
      ) : null}

      {step === 4 ? (
        <>
          <Intro over="Your kitchen" title={['What are we ', 'working', ' with?']} body="Recipes only ask for tools you have, and stay inside your budget." />
          <Question title="What do you have?" aside="Pick all that apply">
            <Chips>
              {EQUIPMENT_OPTIONS.map((e) => (
                <Chip key={e} label={capEquipment(e)} selected={equipment.includes(e)} onPress={() => toggle(equipment, setEquipment, e)} />
              ))}
            </Chips>
            {equipment.length === 0 ? (
              <T variant="caption" style={{ marginTop: 8, color: color.tomatoDeep }}>
                Pick at least one.
              </T>
            ) : null}
          </Question>
          <Question title="How much do you want to spend?">
            {BUDGET_OPTIONS.map((o, i) => (
              <OptionRow key={o.value} first={i === 0} title={o.title} subtitle={o.subtitle} selected={budget === o.value} onPress={() => setBudget(o.value)} />
            ))}
          </Question>
        </>
      ) : null}

      {step === 5 ? (
        <>
          <Intro over="Your week" title={['How often can you ', 'cook', '?']} body="We’ll suggest how many sessions a week fit, and roughly when you’ll reach the final roast chicken." />
          <Question title="Days a week" aside={`${days} ${days === 1 ? 'day' : 'days'}`}>
            <View style={styles.days}>
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <Chip key={d} label={String(d)} selected={days === d} onPress={() => setDays(d)} />
              ))}
            </View>
          </Question>
          <Question title="Time per session" aside="Minutes">
            <Chips>
              {MINUTES_OPTIONS.map((m) => (
                <Chip key={m} label={`${m} min`} selected={minutes === m} onPress={() => setMinutes(m)} />
              ))}
            </Chips>
          </Question>
          {error ? (
            <T variant="small" style={[gutter, { marginTop: 20, color: color.safety }]} accessibilityLiveRegion="polite">
              {error}
            </T>
          ) : null}
        </>
      ) : null}

      {onSignOut ? <Button kind="quiet" label="Sign out" onPress={onSignOut} style={{ marginTop: 28 }} /> : null}
      {mode === 'edit' && onCancel && step === 2 ? <Button kind="quiet" label="Cancel" onPress={onCancel} style={{ marginTop: 8 }} /> : null}
    </Screen>
  );
}

function Intro({ over, title, body }: { over: string; title: [string, string, string]; body: string }) {
  return (
    <View style={[gutter, { marginTop: 22 }]}>
      <T variant="overline">{over}</T>
      <T variant="h1" style={{ marginTop: 8 }} accessibilityRole="header">
        {title[0]}
        <T variant="h1" style={{ fontFamily: font.displayItalic }}>
          {title[1]}
        </T>
        {title[2]}
      </T>
      <T variant="small" style={{ marginTop: 10 }}>
        {body}
      </T>
    </View>
  );
}

function Question({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <View style={[gutter, { marginTop: 30 }]}>
      <View style={styles.qh}>
        <T variant="h3">{title}</T>
        {aside ? <T variant="caption">{aside}</T> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 8, paddingLeft: 14, paddingRight: space.gutter },
  bar: { flex: 1, flexDirection: 'row', gap: 6 },
  barSeg: { flex: 1, height: 3, borderRadius: 2, backgroundColor: color.rule },
  barOn: { backgroundColor: color.ink },
  stepLabel: { fontFamily: font.bodySemi },
  qh: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
