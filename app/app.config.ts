import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * app.json stays the source of everything. The only thing added here is the
 * web base path, used when the site is served under a subpath (GitHub Pages
 * project site). It is set only when EXPO_BASE_URL is set, so local dev, Expo
 * Go and the root export are unchanged.
 */
export function validateBaseUrl(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.length < 2 || value.endsWith('/') || /[\s:?#]/.test(value)) {
    throw new Error('EXPO_BASE_URL must be a path like /Ai-Club-Simmer (starts with /, no trailing slash, no scheme).');
  }
  return value;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const raw = process.env.EXPO_BASE_URL;
  const base = raw ? validateBaseUrl(raw) : undefined;
  return {
    ...config,
    name: config.name ?? 'Simmer',
    slug: config.slug ?? 'simmer',
    ...(base ? { experiments: { ...config.experiments, baseUrl: base } } : {}),
  };
};
