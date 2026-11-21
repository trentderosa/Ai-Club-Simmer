/**
 * Loading, error and empty states. Every screen uses these so the three
 * states look the same everywhere.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { errorCopy, type ErrorAction } from '../domain/error-messages';
import { color, space } from '../theme/tokens';
import { Button } from './button';
import { Icon } from './icon';
import { T } from './text';

export function LoadingState({ title = 'Loading…', body, slowBody }: { title?: string; body?: string; slowBody?: string }) {
  // Recipe generation can take up to a minute; reassure after a few seconds.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!slowBody) return;
    const t = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(t);
  }, [slowBody]);
  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <ActivityIndicator color={color.tomato} />
      <T variant="h3" style={styles.title}>
        {title}
      </T>
      {body ? (
        <T variant="small" style={styles.body}>
          {slow && slowBody ? slowBody : body}
        </T>
      ) : null}
    </View>
  );
}

export function ErrorState({
  error,
  onAction,
  secondary,
}: {
  error: unknown;
  /** Called with the error's suggested action (retry, sign_in, onboarding, back). */
  onAction: (action: ErrorAction) => void;
  secondary?: { label: string; onPress: () => void };
}) {
  const copy = errorCopy(error);
  const label = { retry: 'Try again', sign_in: 'Sign in', onboarding: 'Finish setup', back: 'Back to my path' }[copy.action];
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <Icon name="alert" color={color.tomatoDeep} size={28} />
      <T variant="h2" style={styles.title}>
        {copy.title}
      </T>
      <T variant="small" style={styles.body}>
        {copy.body}
      </T>
      <Button label={label} kind="ink" onPress={() => onAction(copy.action)} style={styles.btn} />
      {secondary ? <Button label={secondary.label} kind="quiet" onPress={secondary.onPress} style={styles.btnQuiet} /> : null}
    </View>
  );
}

export function EmptyState({ title, body, action, compact }: { title: string; body: string; action?: { label: string; onPress: () => void }; compact?: boolean }) {
  return (
    <View style={[styles.wrap, compact && styles.compact]}>
      <Icon name="pot" color={color.butter} size={28} />
      <T variant="h2" style={styles.title}>
        {title}
      </T>
      <T variant="small" style={styles.body}>
        {body}
      </T>
      {action ? <Button label={action.label} kind="ink" onPress={action.onPress} style={styles.btn} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 320, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.gutter, paddingVertical: space.s8 },
  compact: { minHeight: 0, flexGrow: 0, paddingVertical: space.s6 },
  title: { marginTop: space.s4, textAlign: 'center' },
  body: { marginTop: space.s2, textAlign: 'center', maxWidth: 320 },
  btn: { marginTop: space.s6, alignSelf: 'stretch' },
  btnQuiet: { marginTop: space.s2, alignSelf: 'stretch' },
});
