/**
 * Cook anything: type a dish name, get a generated recipe fitted to the
 * user's kitchen, then enter the existing recipe / cook / check-in flow.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { isApiError } from '../api';
import { Button, IconButton } from '../components/button';
import { Field } from '../components/choice';
import { gutter, Screen, TopBar } from '../components/layout';
import { ErrorState, LoadingState } from '../components/states';
import { T } from '../components/text';
import { COOK_ANYTHING_MAX_DISH_LENGTH, clientDishError } from '../domain/dish-name';
import { useFlowCache } from '../state/flow-cache';
import { useSession } from '../state/session';
import { useErrorAction } from '../state/use-error-action';
import { color, radius, space } from '../theme/tokens';

export default function CookAnything() {
  const router = useRouter();
  const { backend, requireSession, signOut } = useSession();
  const cache = useFlowCache();
  const [dish, setDish] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const retry = () => { setError(null); void submit(); };
  const onError = useErrorAction(retry);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/today'));

  const validation = clientDishError(dish);

  async function submit() {
    if (validation) return;
    setSaving(true);
    setError(null);
    try {
      const session = requireSession();
      const recipe = await backend.cookAnything(dish, session.accessToken);
      cache.setGenerated(recipe.generated_recipe_id, recipe);
      router.replace({ pathname: '/generated/[recipeId]', params: { recipeId: recipe.generated_recipe_id } });
    } catch (e) {
      if (isApiError(e) && e.kind === 'unauthorized') {
        void signOut();
        return;
      }
      setError(e);
      setSaving(false);
    }
  }

  if (saving) {
    return (
      <Screen>
        <TopBar left={<IconButton icon="back" label="Back" onPress={back} />} title="Cook anything" />
        <LoadingState
          title="Writing your recipe…"
          body="Your coach is fitting this dish to your kitchen and budget. The first time can take up to a minute."
          slowBody="Still going. The local model is slow on the first try; after this, the recipe loads instantly."
        />
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <TopBar left={<IconButton icon="back" label="Back" onPress={back} />} title="Cook anything" />
        <ErrorState error={error} onAction={onError} secondary={{ label: 'Try a different dish', onPress: () => setError(null) }} />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen footer={<Button label="Get a recipe" onPress={() => void submit()} disabled={!!validation} style={{ flex: 1 }} />}>
        <TopBar left={<IconButton icon="back" label="Back" onPress={back} />} title="Cook anything" />
        <View style={[gutter, { marginTop: 6 }]}>
          <T variant="h1" accessibilityRole="header">
            What do you want to cook?
          </T>
          <T variant="small" style={{ marginTop: 8 }}>
            Type a dish. Your coach will write a recipe for your kitchen. Repeat dishes reuse the first recipe, so the XP stays the same.
          </T>
          <Field
            label="Dish"
            value={dish}
            onChangeText={setDish}
            placeholder="Pad thai"
            autoCapitalize="sentences"
            autoCorrect
            returnKeyType="go"
            maxLength={COOK_ANYTHING_MAX_DISH_LENGTH}
            onSubmitEditing={() => {
              if (!validation) void submit();
            }}
          />
          <T variant="caption" style={{ marginTop: 8, textAlign: 'right' }}>
            {dish.trim().length}/{COOK_ANYTHING_MAX_DISH_LENGTH}
          </T>
          {dish.length > 0 && validation ? (
            <View style={styles.error} accessibilityRole="alert">
              <T variant="small" style={{ color: color.safety }}>
                {validation}
              </T>
            </View>
          ) : null}
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  error: { marginTop: space.s4, padding: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: color.safety, backgroundColor: color.safetyWash },
});
