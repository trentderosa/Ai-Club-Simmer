/**
 * Onboarding (F1), steps 2-4 of 4 (step 1 is the account). Saves to
 * `profiles` with the columns that exist today: goals, experience_level,
 * equipment, budget, days_per_week, minutes_per_session. The diet question
 * from the mockup is left out because there's no column for it yet.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ProfileInput } from '../api';
import { Button, IconButton } from '../components/button';
import { Chip, Chips, OptionRow } from '../components/choice';
import { gutter, Screen } from '../components/layout';
import { T } from '../components/text';
import { errorCopy } from '../domain/error-messages';
import { useSession } from '../state/session';
import { color, font, space } from '../theme/tokens';

const EXPERIENCE: { value: ProfileInput['experience_level']; title: string; subtitle: string }[] = [
  { value: 'never_cooked', title: 'Never, really', subtitle: 'Microwave, cereal, the occasional toast' },
  { value: 'a_little', title: 'A little', subtitle: 'Pasta, eggs, a box mix now and then' },
  { value: 'comfortable', title: 'I’m comfortable', subtitle: 'I follow recipes; I want to stop needing them' },
];
const GOALS = ['Cook 3 dinners a week', 'Spend less on takeout', 'Eat healthier', 'Cook for friends', 'Meal prep'];
/** Stored lowercase, as in docs/CLIENT_API.md. */
const EQUIPMENT = ['stove', 'oven', 'microwave', 'pan', 'pot', 'sheet pan', 'knife', 'cutting board', 'rice cooker', 'blender'];
const BUDGET: { value: ProfileInput['budget']; title: string; subtitle: string }[] = [
  { value: 'low', title: 'Keep it cheap', subtitle: 'Pantry staples, store brands' },
  { value: 'medium', title: 'Somewhere in the middle', subtitle: 'A few fresh things each week' },
  { value: 'high', title: 'Not a big worry', subtitle: 'Happy to buy what the recipe asks for' },
];
const MINUTES = [15, 20, 30, 45, 60];

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function Onboarding() {
  const { backend, requireSession, refreshProfile, signOut } = useSession();
  const [step, setStep] = useState<2 | 3 | 4>(2);
  const [experience, setExperience] = useState<ProfileInput['experience_level'] | null>(null);
  const [goals, setGoals] = useState<string[]>([]);
  const [equipment, setEquipment] = useState<string[]>(['stove', 'pan', 'pot', 'knife', 'cutting board']);
  const [budget, setBudget] = useState<ProfileInput['budget'] | null>(null);
  const [days, setDays] = useState(3);
  const [minutes, setMinutes] = useState(30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const canContinue = step === 2 ? experience !== null : step === 3 ? equipment.length > 0 && budget !== null : true;

  async function save() {
    if (!experience || !budget) return;
    setSaving(true);
    setError(null);
    try {
      const session = requireSession();
      await backend.saveOnboarding(session.userId, {
        goals: goals.join('; '),
        experience_level: experience,
        equipment,
        budget,
        days_per_week: days,
        minutes_per_session: minutes,
      });
      await refreshProfile(); // flips status to ready; the root guard moves on to Today
    } catch (e) {
      setError(errorCopy(e).body);
      setSaving(false);
    }
  }

  const next = () => (step === 4 ? void save() : setStep((step + 1) as 3 | 4));

  return (
    <Screen
      footer={
        <Button label={step === 4 ? 'Build my path' : 'Continue'} kind="ink" onPress={next} disabled={!canContinue} loading={saving} style={{ flex: 1 }} />
      }
    >
      <View style={styles.top}>
        {step > 2 ? (
          <IconButton icon="back" label="Back" onPress={() => setStep((step - 1) as 2 | 3)} />
        ) : (
          <View style={{ width: 40 }} />
        )}
        <View style={styles.bar} accessibilityLabel={`Step ${step} of 4`}>
          {[1, 2, 3, 4].map((i) => (
            <View key={i} style={[styles.barSeg, i <= step && styles.barOn]} />
          ))}
        </View>
        <T variant="caption" style={styles.stepLabel}>
          {step} of 4
        </T>
      </View>

      {step === 2 ? (
        <>
          <Intro over="About you" title={['Let’s start where ', 'you', ' are.']} body="Everyone gets the same ten dishes. This changes how we write them for you." />
          <Question title="How much have you cooked?">
            {EXPERIENCE.map((o, i) => (
              <OptionRow key={o.value} first={i === 0} title={o.title} subtitle={o.subtitle} selected={experience === o.value} onPress={() => setExperience(o.value)} />
            ))}
          </Question>
          <Question title="What do you want out of this?" aside="Pick any">
            <Chips>
              {GOALS.map((g) => (
                <Chip key={g} label={g} selected={goals.includes(g)} onPress={() => toggle(goals, setGoals, g)} />
              ))}
            </Chips>
          </Question>
          <T variant="caption" style={[gutter, { marginTop: 24 }]}>
            Next: your kitchen (equipment and budget), then your week.
          </T>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Intro over="Your kitchen" title={['What are we ', 'working', ' with?']} body="Recipes only ask for tools you have, and stay inside your budget." />
          <Question title="What do you have?" aside="Pick all that apply">
            <Chips>
              {EQUIPMENT.map((e) => (
                <Chip key={e} label={cap(e)} selected={equipment.includes(e)} onPress={() => toggle(equipment, setEquipment, e)} />
              ))}
            </Chips>
            {equipment.length === 0 ? (
              <T variant="caption" style={{ marginTop: 8, color: color.tomatoDeep }}>
                Pick at least one.
              </T>
            ) : null}
          </Question>
          <Question title="How much do you want to spend?">
            {BUDGET.map((o, i) => (
              <OptionRow key={o.value} first={i === 0} title={o.title} subtitle={o.subtitle} selected={budget === o.value} onPress={() => setBudget(o.value)} />
            ))}
          </Question>
        </>
      ) : null}

      {step === 4 ? (
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
              {MINUTES.map((m) => (
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

      <Button kind="quiet" label="Sign out" onPress={() => void signOut()} style={{ marginTop: 28 }} />
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
