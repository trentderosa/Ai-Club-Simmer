export interface E2eEnv {
  apiUrl: string;
  anonKey: string;
  serviceKey: string;
  dbUrl: string;
  aiUrl: string;
}

/** Values are set by global-setup.ts. Never log this object. */
export function env(): E2eEnv {
  const e = process.env;
  if (!e.E2E_API_URL || !e.E2E_ANON_KEY || !e.E2E_SERVICE_KEY || !e.E2E_DB_URL || !e.E2E_AI_URL) {
    throw new Error('e2e environment not initialised (global-setup did not run)');
  }
  return {
    apiUrl: e.E2E_API_URL,
    anonKey: e.E2E_ANON_KEY,
    serviceKey: e.E2E_SERVICE_KEY,
    dbUrl: e.E2E_DB_URL,
    aiUrl: e.E2E_AI_URL,
  };
}
