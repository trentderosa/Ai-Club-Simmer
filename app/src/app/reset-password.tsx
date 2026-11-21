/**
 * Set a new password after the recovery link (F1).
 * The recovery session stays on this screen until the password is saved.
 */
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { Button } from '../components/button';
import { Field } from '../components/choice';
import { gutter, Rule, Screen } from '../components/layout';
import { T } from '../components/text';
import { errorCopy } from '../domain/error-messages';
import { useSession } from '../state/session';
import { color, font, space } from '../theme/tokens';

export default function ResetPassword() {
  const { backend, session, recovery, finishPasswordReset, signOut, dismissRecoveryFailure } = useSession();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const longEnough = password.length >= 6 && confirm.length >= 6;
  const ownsThisSession = session ? backend.passwordResetOwns(session.userId) : false;

  async function save() {
    if (password !== confirm) {
      setMessage('Those passwords don’t match.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await backend.updatePassword(password);
      await finishPasswordReset();
    } catch (e) {
      setMessage(errorCopy(e).body);
    } finally {
      setBusy(false);
    }
  }

  if (recovery !== 'form' || !session) {
    const leave = !session || ownsThisSession ? signOut : dismissRecoveryFailure;
    return (
      <Screen
        footer={
          <Button label={!session || ownsThisSession ? 'Back to sign in' : 'Continue'} kind="ink" onPress={() => void leave()} style={{ flex: 1 }} />
        }
      >
        <View style={[gutter, styles.head]}>
          <T variant="overline">Simmer · Weeknight basics</T>
          <T variant="display" style={styles.title} accessibilityRole="header">
            That link{'\n'}didn’t work.
          </T>
          <T variant="small" style={{ marginTop: 12 }}>
            It has expired or was already used. Request a new one from the sign-in screen.
          </T>
        </View>
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        footer={
          <Button label="Save password" kind="ink" onPress={() => void save()} disabled={!longEnough} loading={busy} style={{ flex: 1 }} />
        }
      >
        <View style={[gutter, styles.head]}>
          <T variant="overline">Simmer · Weeknight basics</T>
          <T variant="display" style={styles.title} accessibilityRole="header">
            Choose a new{'\n'}
            <T variant="display" style={styles.ital}>
              password
            </T>
            .
          </T>
          <T variant="small" style={{ marginTop: 12 }}>
            Use at least 6 characters. You’ll be signed in with it right after.
          </T>
        </View>

        <Rule strong style={styles.rule} />

        <View style={gutter}>
          <T variant="h3">Set your password</T>
          <Field
            label="New password"
            hint="At least 6 characters"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="new-password"
            textContentType="newPassword"
          />
          <Field
            label="Confirm password"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoComplete="new-password"
            textContentType="newPassword"
            onSubmitEditing={() => longEnough && void save()}
          />
          {message ? (
            <T variant="small" style={[styles.message, { color: color.safety }]} accessibilityLiveRegion="polite">
              {message}
            </T>
          ) : null}
          <Button kind="quiet" label="Back to sign in" onPress={() => void signOut()} style={{ marginTop: space.s4 }} />
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
});
