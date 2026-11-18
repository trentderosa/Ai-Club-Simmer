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
  return `e2e-${randomBytes(6).toString('hex')}@simmer.invalid`;
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

  async cleanup(): Promise<void> {
    for (const u of this.created.splice(0)) {
      const res = await adminDeleteUser(u.id);
      if (res.status >= 300) {
        console.warn(`cleanup: could not delete test user (HTTP ${res.status})`);
      }
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
