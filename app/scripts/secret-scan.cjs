/**
 * Shared detection for server-only Supabase credentials. Used by
 * check-secrets.mjs (source and built output) and its jest test.
 * Hits never include the matched text, only a location and a kind.
 */
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');

const NAME = /service[_\s-]?role|serviceRole/i;
const JWT = /eyJ[\w-]{10,}\.([\w-]{10,})\.[\w-]{10,}/g;
const SECRET_KEY = /\bsb_secret_[\w-]{8,}/;

function jwtRole(payload) {
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role;
  } catch {
    return undefined;
  }
}

/** Kinds of problem found in one line of text. */
function scanLine(line, { allowName = false } = {}) {
  const kinds = [];
  if (!allowName && NAME.test(line)) kinds.push('mentions the service role');
  if (SECRET_KEY.test(line)) kinds.push('looks like a Supabase secret key');
  for (const m of line.matchAll(JWT)) {
    if (jwtRole(m[1]) === 'service_role') kinds.push('JWT with role service_role');
  }
  return kinds;
}

/**
 * Walk `dir` and return hit strings like "path:line: kind".
 * Options: root (paths are shown relative to it), skipDirs, allow (relative
 * paths allowed to name the service role), text (file name filter).
 */
function scanDir(dir, { root = dir, skipDirs = new Set(), allow = new Set(), text } = {}) {
  const hits = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const rel = relative(root, full);
      if (statSync(full).isDirectory()) {
        if (!skipDirs.has(name)) walk(full);
        continue;
      }
      if (text && !text.test(name)) continue;
      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const kind of scanLine(line, { allowName: allow.has(rel) })) {
            hits.push(`${rel}:${i + 1}: ${kind}`);
          }
        });
    }
  };
  walk(dir);
  return hits;
}

module.exports = { scanLine, scanDir };
