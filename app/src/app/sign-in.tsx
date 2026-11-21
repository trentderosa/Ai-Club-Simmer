/**
 * Sign in / create account (F1). Plain Supabase email + password.
 * A new account goes on to onboarding automatically (root guard).
 */
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { Button } from '../components/button';
import { Field } from '../components/choice';
import { gutter, Rule, Screen } from '../components/layout';
import { T } from '../components/text';
import { errorCopy } from '../domain/error-messages';
import { useSession } from '../state/session';
import { color, font, space } from '../theme/tokens';

type Mode = 'sign_in' | 'sign_up';

export default function SignIn() {
  const { backend } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('sign_up');
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  const emailOk = /.+@.+\..+/.test(email.trim());
  const canSubmit = emailOk && password.length >= 6 && (mode === 'sign_in' || firstName.trim().length > 0);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'sign_in') {
        await backend.signIn(email.trim(), password);
      } else {
        const { signedIn } = await backend.signUp(email.trim(), password, firstName);
        if (!signedIn) {
          setMode('sign_in');
          setMessage({ tone: 'info', text: 'Check your email to confirm your account, then sign in.' });
        }
      }
    } catch (e) {
      const copy = errorCopy(e);
      const raw = e instanceof Error ? e.message : '';
      setMessage({ tone: 'error', text: mode === 'sign_in' && raw ? raw : copy.body });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        footer={
          <Button
            label={mode === 'sign_up' ? 'Create account' : 'Sign in'}
            kind="ink"
            onPress={() => void submit()}
            disabled={!canSubmit}
            loading={busy}
            style={{ flex: 1 }}
          />
        }
      >
        <View style={[gutter, styles.head]}>
          <T variant="overline">Simmer · Weeknight basics</T>
          <T variant="display" style={styles.title} accessibilityRole="header">
            Ten dinners,{'\n'}
            <T variant="display" style={styles.ital}>
              one
            </T>{' '}
            at a time.
          </T>
          <T variant="small" style={{ marginTop: 12 }}>
            A short path of real weeknight dishes. Each one teaches a technique, and your coach rewrites the next recipe from how the last one went.
          </T>
        </View>

        <Rule strong style={styles.rule} />

        <View style={gutter}>
          <T variant="h3">{mode === 'sign_up' ? 'Make an account' : 'Welcome back'}</T>
          {mode === 'sign_up' ? (
            <Field label="First name" hint="So your coach knows what to call you" value={firstName} onChangeText={setFirstName} autoComplete="given-name" textContentType="givenName" returnKeyType="next" />
          ) : null}
          <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" />
          <Field
            label="Password"
            hint={mode === 'sign_up' ? 'At least 6 characters' : undefined}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete={mode === 'sign_up' ? 'new-password' : 'current-password'}
            textContentType={mode === 'sign_up' ? 'newPassword' : 'password'}
            onSubmitEditing={() => canSubmit && void submit()}
          />
          {message ? (
            <T variant="small" style={[styles.message, message.tone === 'error' && { color: color.safety }]} accessibilityLiveRegion="polite">
              {message.text}
            </T>
          ) : null}
          <Button
            kind="quiet"
            label={mode === 'sign_up' ? 'I already have an account' : 'New here? Make an account'}
            onPress={() => {
              setMode(mode === 'sign_up' ? 'sign_in' : 'sign_up');
              setMessage(null);
            }}
            style={{ marginTop: space.s4 }}
          />
          {mode === 'sign_in' ? (
            <Button kind="quiet" label="Forgot your password?" onPress={() => router.push('/forgot-password' as Href)} />
          ) : null}
          {backend.label === 'mock' ? (
            <T variant="caption" style={styles.mock}>
              Mock mode: any email works. Signing in loads a demo cook three dishes in; making an account starts fresh.
            </T>
          ) : null}
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  head: { paddingTop: space.s10 },
  title: { marginTop: 10 },
  ital: { fontFamily: font.displayItalic },
  rule: { marginHorizontal: space.gutter, marginTop: 28, marginBottom: 22 },
  message: { marginTop: 14 },
  mock: { marginTop: 8, textAlign: 'center' },
});
