import { validateBaseUrl } from '../../app.config';

/* eslint-disable @typescript-eslint/no-require-imports */
// No @types/node in this app, so the few Node modules are typed by hand.
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs') as {
  mkdtempSync: (prefix: string) => string;
  mkdirSync: (path: string) => void;
  rmSync: (path: string, opts: { recursive: boolean; force: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { tmpdir } = require('node:os') as { tmpdir: () => string };
const { join } = require('node:path') as { join: (...parts: string[]) => string };
const { Buffer: NodeBuffer } = require('node:buffer') as {
  Buffer: { from: (s: string) => { toString: (enc: string) => string } };
};
const { scanDir, scanLine } = require('../../scripts/secret-scan.cjs') as {
  scanDir: (dir: string, opts?: { text?: RegExp }) => string[];
  scanLine: (line: string) => string[];
};

// Fake values, assembled so this file does not trip the source guards.
const ROLE = 'service' + '_role';
const b64 = (o: object) => NodeBuffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${b64({ role, iss: 'fake' })}.fakesignature123`;
const secretKey = 'sb' + '_secret_' + 'FAKEFAKEFAKE1234';

describe('scanLine', () => {
  it('flags the privileged role name', () => {
    expect(scanLine(`const k = "${ROLE}"`)).toEqual([expect.stringContaining('mentions')]);
    expect(scanLine('service' + 'RoleKey')).toEqual([expect.stringContaining('mentions')]);
  });
  it('flags a privileged JWT but not an anon JWT', () => {
    expect(scanLine(`x=${jwt(ROLE)}`)).toEqual([expect.stringContaining('JWT')]);
    expect(scanLine(`x=${jwt('anon')}`)).toEqual([]);
  });
  it('flags sb_secret_ keys', () => {
    expect(scanLine(secretKey)).toEqual(['looks like a Supabase secret key']);
  });
  it('is quiet on normal code', () => {
    expect(scanLine('const url = "https://example.invalid"')).toEqual([]);
  });
});

describe('scanDir', () => {
  it('reports paths and kinds without the matched value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'simmer-scan-'));
    try {
      mkdirSync(join(dir, '_expo'));
      writeFileSync(join(dir, '_expo', 'bundle.js'), `ok\nvar a="${secretKey}";\n`);
      writeFileSync(join(dir, 'clean.html'), '<html></html>');
      const hits = scanDir(dir, { text: /\.(js|html)$/ });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('bundle.js:2');
      expect(hits.join('\n')).not.toContain('FAKEFAKE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validateBaseUrl', () => {
  it('accepts a subpath', () => {
    expect(validateBaseUrl('/Ai-Club-Simmer')).toBe('/Ai-Club-Simmer');
  });
  it.each(['Ai-Club-Simmer', '/Ai-Club-Simmer/', '/', '//evil.invalid', 'https://x.invalid/a', '/a b'])(
    'rejects %s',
    (v) => {
      expect(() => validateBaseUrl(v)).toThrow(/EXPO_BASE_URL/);
    },
  );
});
