import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultEnvPath, loadEnvFile, parseEnvFile } from './load-env.js';

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

function writeTempEnv(contents: string): string {
  const file = path.join(os.tmpdir(), `simmer-env-${process.pid}-${Date.now()}-${Math.random()}.env`);
  fs.writeFileSync(file, contents, 'utf8');
  createdFiles.push(file);
  return file;
}

describe('parseEnvFile', () => {
  it('parses keys, skips comments and blank lines, and strips quotes', () => {
    const parsed = parseEnvFile(
      [
        '# comment',
        '',
        'PLAIN=hello',
        'QUOTED="spaced value"',
        "SINGLE='one'",
        'export EXPORTED=yes',
        'EMPTY=',
        'BAD LINE',
        '1INVALID=no',
      ].join('\n')
    );

    expect(parsed).toEqual({
      PLAIN: 'hello',
      QUOTED: 'spaced value',
      SINGLE: 'one',
      EXPORTED: 'yes',
      EMPTY: '',
    });
  });
});

describe('loadEnvFile', () => {
  it('is a no-op when the file is missing', () => {
    const missing = path.join(os.tmpdir(), `simmer-env-missing-${process.pid}-${Date.now()}.env`);
    expect(loadEnvFile(missing)).toBe(false);
  });

  it('loads new variables and leaves already-set variables unchanged', () => {
    const keyKeep = `SIMMER_TEST_KEEP_${process.pid}`;
    const keyNew = `SIMMER_TEST_NEW_${process.pid}`;
    const previousKeep = process.env[keyKeep];
    const previousNew = process.env[keyNew];
    process.env[keyKeep] = 'from-process';
    delete process.env[keyNew];

    try {
      const file = writeTempEnv(`${keyKeep}=from-file\n${keyNew}=loaded\n`);
      expect(loadEnvFile(file)).toBe(true);
      expect(process.env[keyKeep]).toBe('from-process');
      expect(process.env[keyNew]).toBe('loaded');
    } finally {
      if (previousKeep === undefined) delete process.env[keyKeep];
      else process.env[keyKeep] = previousKeep;
      if (previousNew === undefined) delete process.env[keyNew];
      else process.env[keyNew] = previousNew;
    }
  });
});

describe('defaultEnvPath', () => {
  it('resolves to ai-server/.env regardless of the working directory', () => {
    const envPath = defaultEnvPath();
    expect(path.basename(envPath)).toBe('.env');
    expect(path.basename(path.dirname(envPath))).toBe('ai-server');
  });
});
