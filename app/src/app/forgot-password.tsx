/**
 * Request a password-reset email (F1). Signed out only.
 * Full mock mode shows the same confirmation and says it is practice mode.
 */
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { Button } from '../components/button';
import { Field } from '../components/choice';
import { gutter, Rule, Screen } from '../components/layout';
import { T } from '../components/text';
import { errorCopy } from '../domain/error-messages';
import { isPasswordResetEmail, PASSWORD_RESET_PRACTICE_COPY, PASSWORD_RESET_SENT_COPY } from '../domain/password-reset';
import { useSession } from '../state/session';
import { color, font, space } from '../theme/tokens';

export default function ForgotPassword() {
  const { backend } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const emailOk = isPasswordResetEmail(email);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      await backend.requestPasswordReset(email.trim());
      setSent(true);
    } catch (e) {
      setMessage(errorCopy(e).body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        footer={
          sent ? (
            <Button label="Back to sign in" kind="ink" onPress={() => router.replace('/sign-in' as Href)} style={{ flex: 1 }} />
          ) : (
            <Button
              label={backend.label === 'mock' ? 'Continue' : 'Send reset link'}
              kind="ink"
              onPress={() => void submit()}
              disabled={!emailOk}
              loading={busy}
              style={{ flex: 1 }}
            />
          )
        }
      >
        <View style={[gutter, styles.head]}>
          <T variant="overline">Simmer · Weeknight basics</T>
          <T variant="display" style={styles.title} accessibilityRole="header">
            Forgot your{'\n'}
            <T variant="display" style={styles.ital}>
              password
            </T>
            ?
          </T>
          <T variant="small" style={{ marginTop: 12 }}>
            {backend.label === 'mock'
              ? 'Enter an email to see the confirmation. Practice mode does not send email.'
              : 'Enter the email on your account. We’ll send a link to choose a new one.'}
          </T>
        </View>

        <Rule strong style={styles.rule} />

        <View style={gutter}>
          {sent ? (
            <>
              <T variant="h3">Check your email</T>
              <T variant="small" style={styles.message} accessibilityLiveRegion="polite">
                {PASSWORD_RESET_SENT_COPY}
              </T>
              {backend.label === 'mock' ? (
                <T variant="caption" style={styles.mock}>
                  {PASSWORD_RESET_PRACTICE_COPY}
                </T>
              ) : null}
            </>
          ) : (
            <>
              <T variant="h3">Reset your password</T>
              <Field
                label="Email"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                onSubmitEditing={() => emailOk && void submit()}
              />
              {message ? (
                <T variant="small" style={[styles.message, { color: color.safety }]} accessibilityLiveRegion="polite">
                  {message}
                </T>
              ) : null}
            </>
          )}
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
