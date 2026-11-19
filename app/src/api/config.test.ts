import { configFromEnv, missingConfig, pagesConfigProblems, parseMockMode, parseMockXpStatus, type AppConfig } from './config';

/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process') as {
  spawnSync: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined>; encoding: 'utf8' },
  ) => { status: number | null; stdout: string; stderr: string };
};
const { Buffer: NodeBuffer } = require('node:buffer') as {
  Buffer: { from: (s: string) => { toString: (enc: string) => string } };
};

const empty: AppConfig = { supabaseUrl: '', supabaseAnonKey: '', aiServerUrl: '', mockMode: 'all', mockXpStatus: 'awarded' };
const liveNames = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_AI_SERVER_URL'];
const publicLive: AppConfig = {
  supabaseUrl: 'https://abc.supabase.co',
  supabaseAnonKey: 'public-anon-key-sample',
  aiServerUrl: 'https://ai.example',
  mockMode: 'off',
  mockXpStatus: 'awarded',
};

describe('config', () => {
  it('parses the mock mode flag', () => {
    expect(parseMockMode('1')).toBe('all');
    expect(parseMockMode('true')).toBe('all');
    expect(parseMockMode(' TRUE ')).toBe('all');
    expect(parseMockMode('All')).toBe('all');
    expect(parseMockMode('ai')).toBe('ai');
    expect(parseMockMode('AI')).toBe('ai');
    expect(parseMockMode('0')).toBe('off');
    expect(parseMockMode(' 0 ')).toBe('off');
    expect(parseMockMode('')).toBe('off');
    expect(parseMockMode(undefined)).toBe('off');
    expect(parseMockXpStatus('failed')).toBe('failed');
    expect(parseMockXpStatus(' FAILED ')).toBe('failed');
    expect(parseMockXpStatus('nope')).toBe('awarded');
  });

  it('trims public values and strips a trailing slash from the AI server URL', () => {
    expect(
      configFromEnv({
        EXPO_PUBLIC_SUPABASE_URL: '  https://abc.supabase.co  ',
        EXPO_PUBLIC_SUPABASE_ANON_KEY: '  public-anon-key-sample  ',
        EXPO_PUBLIC_AI_SERVER_URL: 'https://ai.example///',
        EXPO_PUBLIC_MOCK_MODE: ' 0 ',
        EXPO_PUBLIC_MOCK_XP_STATUS: 'skipped',
      }),
    ).toEqual({
      supabaseUrl: 'https://abc.supabase.co',
      supabaseAnonKey: 'public-anon-key-sample',
      aiServerUrl: 'https://ai.example',
      mockMode: 'off',
      mockXpStatus: 'skipped',
    });
  });

  it('only requires what the mode needs', () => {
    expect(missingConfig(empty)).toEqual([]);
    expect(missingConfig({ ...empty, mockMode: 'ai' })).toEqual(['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']);
    expect(missingConfig({ ...empty, mockMode: 'off' })).toEqual(liveNames);
  });

  it('treats a blank, whitespace, or non-http URL as missing in live mode', () => {
    expect(missingConfig({ ...empty, mockMode: 'off', supabaseUrl: '   ', supabaseAnonKey: '   ', aiServerUrl: '   ' })).toEqual(liveNames);
    expect(missingConfig({ ...publicLive, supabaseUrl: 'notaurl', aiServerUrl: 'http://' })).toEqual([
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_AI_SERVER_URL',
    ]);
    expect(missingConfig({ ...publicLive, supabaseUrl: 'https://user:pw@abc.supabase.co' })).toEqual(['EXPO_PUBLIC_SUPABASE_URL']);
    expect(missingConfig({ ...publicLive, supabaseAnonKey: 'not a token' })).toEqual(['EXPO_PUBLIC_SUPABASE_ANON_KEY']);
    expect(missingConfig(publicLive)).toEqual([]);
    expect(missingConfig({ ...publicLive, aiServerUrl: 'http://127.0.0.1:3001' })).toEqual([]);
  });

  it('lets ai mode skip the AI server URL', () => {
    expect(missingConfig({ ...publicLive, mockMode: 'ai', aiServerUrl: '' })).toEqual([]);
    expect(missingConfig({ ...empty, mockMode: 'ai', supabaseUrl: 'https://abc.supabase.co' })).toEqual(['EXPO_PUBLIC_SUPABASE_ANON_KEY']);
  });

  it('rejects example placeholders and loopback hosts for the public site', () => {
    expect(pagesConfigProblems({ ...empty, supabaseUrl: 'notaurl' })).toEqual([]);
    expect(pagesConfigProblems(publicLive)).toEqual([]);
    expect(pagesConfigProblems({ ...publicLive, mockMode: 'ai', aiServerUrl: '' })).toEqual([]);
    expect(
      pagesConfigProblems({
        ...publicLive,
        supabaseUrl: 'https://your-project-ref.supabase.co',
        supabaseAnonKey: 'Your-Anon-Key',
        aiServerUrl: 'http://127.0.0.1:3001',
      }),
    ).toEqual(liveNames);
    expect(pagesConfigProblems({ ...publicLive, supabaseUrl: 'http://localhost:54321' })).toEqual(['EXPO_PUBLIC_SUPABASE_URL']);
    expect(pagesConfigProblems({ ...publicLive, aiServerUrl: 'http://127.0.0.2:3001' })).toEqual(['EXPO_PUBLIC_AI_SERVER_URL']);
    expect(pagesConfigProblems({ ...publicLive, aiServerUrl: 'http://[::1]:3001' })).toEqual(['EXPO_PUBLIC_AI_SERVER_URL']);
    expect(pagesConfigProblems({ ...publicLive, aiServerUrl: 'http://0.0.0.0:3001' })).toEqual(['EXPO_PUBLIC_AI_SERVER_URL']);
  });

  it('requires https for the public site and still allows http locally', () => {
    expect(missingConfig({ ...publicLive, supabaseUrl: 'http://abc.supabase.co', aiServerUrl: 'http://ai.example:3001' })).toEqual([]);
    expect(pagesConfigProblems({ ...publicLive, supabaseUrl: 'http://abc.supabase.co', aiServerUrl: 'http://ai.example:3001' })).toEqual([
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_AI_SERVER_URL',
    ]);
  });
});

function runPagesCheck(overrides: Record<string, string>) {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    EXPO_PUBLIC_MOCK_MODE: '',
    EXPO_PUBLIC_SUPABASE_URL: '',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: '',
    EXPO_PUBLIC_AI_SERVER_URL: '',
    EXPO_PUBLIC_MOCK_XP_STATUS: '',
    ...overrides,
  };
  return spawnSync(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', 'scripts/check-pages-config.mjs'],
    { cwd: process.cwd(), env, encoding: 'utf8' },
  );
}

describe('Pages config guard', () => {
  it('builds mock mode without a backend', () => {
    const result = runPagesCheck({ EXPO_PUBLIC_MOCK_MODE: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Mock mode');
  });

  it('fails live mode when a value is missing, without printing the value', () => {
    const missing = runPagesCheck({ EXPO_PUBLIC_MOCK_MODE: '0' });
    expect(missing.status).toBe(1);
    for (const name of liveNames) expect(missing.stderr).toContain(name);

    const bad = runPagesCheck({
      EXPO_PUBLIC_MOCK_MODE: '0',
      EXPO_PUBLIC_SUPABASE_URL: 'notaurl',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key-sample',
      EXPO_PUBLIC_AI_SERVER_URL: 'https://ai.example',
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('EXPO_PUBLIC_SUPABASE_URL');
    expect(`${bad.stdout}${bad.stderr}`).not.toContain('notaurl');
    expect(`${bad.stdout}${bad.stderr}`).not.toContain('public-anon-key-sample');
  });

  it('accepts a live build and does not print the public values', () => {
    const result = runPagesCheck({
      EXPO_PUBLIC_MOCK_MODE: '0',
      EXPO_PUBLIC_SUPABASE_URL: publicLive.supabaseUrl,
      EXPO_PUBLIC_SUPABASE_ANON_KEY: publicLive.supabaseAnonKey,
      EXPO_PUBLIC_AI_SERVER_URL: publicLive.aiServerUrl,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Live mode');
    expect(`${result.stdout}${result.stderr}`).not.toContain(publicLive.supabaseAnonKey);
    expect(`${result.stdout}${result.stderr}`).not.toContain(publicLive.supabaseUrl);
  });

  it('rejects a server-only key in the anon variable and does not print it', () => {
    const role = 'service' + '_role';
    const b64 = (value: object) => NodeBuffer.from(JSON.stringify(value)).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${b64({ role, iss: 'fake' })}.fakesignature123`;
    const result = runPagesCheck({
      EXPO_PUBLIC_MOCK_MODE: '0',
      EXPO_PUBLIC_SUPABASE_URL: publicLive.supabaseUrl,
      EXPO_PUBLIC_SUPABASE_ANON_KEY: token,
      EXPO_PUBLIC_AI_SERVER_URL: publicLive.aiServerUrl,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EXPO_PUBLIC_SUPABASE_ANON_KEY');
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(`${result.stdout}${result.stderr}`).not.toContain('fakesignature123');
  });
});
