/**
 * Jest stand-in for expo-crypto. The package's own native mock leaves
 * randomUUID() empty, and this implementation avoids globalThis.crypto.randomUUID
 * so tests can prove the helper does not depend on that Node-only API.
 */
let seq = 0;

export function randomUUID(): string {
  seq += 1;
  const id = seq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${id}`;
}
