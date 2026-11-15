import { missingConfig, parseMockMode, parseMockXpStatus, type AppConfig } from './config';

describe('config', () => {
  it('parses the mock mode flag', () => {
    expect(parseMockMode('1')).toBe('all');
    expect(parseMockMode('true')).toBe('all');
    expect(parseMockMode('ai')).toBe('ai');
    expect(parseMockMode('0')).toBe('off');
    expect(parseMockMode(undefined)).toBe('off');
    expect(parseMockXpStatus('failed')).toBe('failed');
    expect(parseMockXpStatus('nope')).toBe('awarded');
  });

  it('only requires what the mode needs', () => {
    const empty: AppConfig = { supabaseUrl: '', supabaseAnonKey: '', aiServerUrl: '', mockMode: 'all', mockXpStatus: 'awarded' };
    expect(missingConfig(empty)).toEqual([]);
    expect(missingConfig({ ...empty, mockMode: 'ai' })).toEqual(['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']);
    expect(missingConfig({ ...empty, mockMode: 'off' })).toHaveLength(3);
  });
});
