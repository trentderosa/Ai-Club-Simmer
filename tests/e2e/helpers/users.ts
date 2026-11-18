import { randomBytes } from 'node:crypto';
import { adminDeleteUser, authSignUp, expectOk, rest, type Session } from './supabase.js';

export interface E2eUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export const ONBOARDING = {
  goals: 'Cook 3 dinners a week',
  experience_level: 'never_cooked',
  equipment: ['stove', 'pan', 'pot', 'knife', 'cutting board'],
  budget: 'low',
  days_per_week: 3,
  minutes_per_session: 30,
  onboarding_completed: true,
} as const;

export function randomEmail(): string {
  return `e2e-${process.env.E2E_RUN_ID ?? 'x'}-${randomBytes(6).toString('hex')}@simmer.invalid`;
}

/** Creates fresh users through the public sign-up endpoint and removes them afterwards. */
export class Cast {
  private readonly created: E2eUser[] = [];

  async newUser(opts: { onboard?: boolean } = {}): Promise<E2eUser> {
    const email = randomEmail();
    const password = `E2e-${randomBytes(12).toString('hex')}`;
    const res = await authSignUp(email, password);
    const session = expectOk(res, 'sign-up') as Session;
    if (!session.access_token) {
      throw new Error('sign-up returned no session (are email confirmations off locally?)');
    }
    const user: E2eUser = {
      id: session.user.id,
      email,
      password,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    };
    this.created.push(user);
    if (opts.onboard !== false) {
      await onboard(user);
    }
    return user;
  }

  /**
   * Deletes every created user. A 404 means the user is already gone and
   * counts as success; any other failure is collected and thrown after all
   * deletes were tried, naming the count and the HTTP statuses (no keys).
   */
  async cleanup(): Promise<void> {
    const failures: number[] = [];
    for (const u of this.created.splice(0)) {
      const res = await adminDeleteUser(u.id);
      if (res.status >= 300 && res.status !== 404) failures.push(res.status);
    }
    if (failures.length > 0) {
      throw new Error(
        `e2e cleanup: could not delete ${failures.length} test user(s) (HTTP ${[...new Set(failures)].join(', ')})`
      );
    }
  }
}

/** The app's onboarding call: upsert into the user's own profiles row. */
export async function onboard(user: E2eUser, overrides: Record<string, unknown> = {}): Promise<void> {
  const res = await rest(user.accessToken, 'profiles?on_conflict=id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: { id: user.id, ...ONBOARDING, ...overrides },
  });
  expectOk(res, 'onboarding upsert');
}
