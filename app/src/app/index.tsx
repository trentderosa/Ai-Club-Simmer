import { StyleSheet, Text, View } from 'react-native';

// Placeholder home screen. Replaced by onboarding (F1) and the plan screen (F2).
export default function Home() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Simmer</Text>
      <Text style={styles.tagline}>Learn to cook, one dish at a time.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 36,
    fontWeight: '700',
    color: '#450084',
  },
  tagline: {
    marginTop: 8,
    fontSize: 16,
    color: '#555',
  },
});
