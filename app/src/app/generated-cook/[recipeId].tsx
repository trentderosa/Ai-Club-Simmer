/**
 * Cook mode for a free-form generated recipe. Same stepper as path slots.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from '../../components/button';
import { CookSteps } from '../../components/cook-steps';
import { ErrorState, LoadingState } from '../../components/states';
import { useErrorAction } from '../../state/use-error-action';
import { useGeneratedRecipe } from '../../state/use-generated-recipe';
import { color } from '../../theme/tokens';

function param(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default function GeneratedCookMode() {
  const recipeId = param(useLocalSearchParams<{ recipeId: string }>().recipeId);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const data = useGeneratedRecipe(recipeId);
  const onError = useErrorAction(data.reload);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/today'));

  if (data.status !== 'ready') {
    return (
      <SafeAreaView style={styles.fill}>
        <View style={[styles.top, { paddingTop: insets.top ? 4 : 4 }]}>
          <IconButton icon="x" label="Close cook mode" onPress={close} />
        </View>
        {data.status === 'error' ? <ErrorState error={data.error} onAction={onError} /> : <LoadingState title="Getting your station ready…" />}
      </SafeAreaView>
    );
  }

  return (
    <CookSteps
      recipe={data.data.recipe}
      videos={data.data.videos}
      onClose={close}
      onDone={() => router.replace({ pathname: '/generated-check-in/[recipeId]', params: { recipeId: data.data.generated_recipe_id } })}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.sheet },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 16, paddingTop: 4, minHeight: 48 },
});
