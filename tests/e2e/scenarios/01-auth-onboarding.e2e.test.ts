/** F1: sign-up, sign-in, onboarding profile, token refresh, sign-out. */
import { afterAll, describe, expect, it } from 'vitest';
import { ai } from '../helpers/ai.js';
import { authRefresh, authSignIn, authSignOut, authSignUp, rest } from '../helpers/supabase.js';
import { Cast, ONBOARDING, onboard, randomEmail } from '../helpers/users.js';

const cast = new Cast();
afterAll(() => cast.cleanup());

describe('F1 sign-up, onboarding, sign-in, refresh, sign-out', () => {
  let user: Awaited<ReturnType<Cast['newUser']>>;

  it('signs up through the public endpoint and gets a session', async () => {
    user = await cast.newUser({ onboard: false });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.accessToken.split('.')).toHaveLength(3);
    expect(user.refreshToken.length).toBeGreaterThan(5);
  });

  it('has no profile row before onboarding', async () => {
    const res = await rest(user.accessToken, 'profiles?select=*');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('AI server refuses to generate before onboarding (404)', async () => {
    const res = await ai('/api/recipes/generate/1', { token: user.accessToken });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toMatch(/onboarding/i);
  });

  it('upserts onboarding into the own profiles row and re-reads it', async () => {
    await onboard(user);
    const res = await rest(user.accessToken, 'profiles?select=*');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: user.id, ...ONBOARDING });
  });

  it('lets the user edit the profile (second upsert updates the same row)', async () => {
    await onboard(user, { minutes_per_session: 45, days_per_week: 5 });
    const res = await rest(user.accessToken, 'profiles?select=minutes_per_session,days_per_week,onboarding_completed');
    expect(res.body).toEqual([{ minutes_per_session: 45, days_per_week: 5, onboarding_completed: true }]);
  });

  it('rejects invalid onboarding values (CHECK constraints)', async () => {
    for (const bad of [
      { experience_level: 'expert' },
      { budget: 'free' },
      { days_per_week: 9 },
      { minutes_per_session: 0 },
    ]) {
      const res = await rest(user.accessToken, 'profiles?on_conflict=id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates',
        body: { id: user.id, ...ONBOARDING, ...bad },
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('signs in with the password, and rejects a wrong password', async () => {
    const ok = await authSignIn(user.email, user.password);
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(user.id);
    const bad = await authSignIn(user.email, `${user.password}x`);
    expect(bad.status).toBe(400);
    expect(bad.body.access_token).toBeUndefined();
  });

  it('rejects a weak password and a malformed email at sign-up', async () => {
    const weak = await authSignUp(randomEmail(), '123');
    expect(weak.status).toBeGreaterThanOrEqual(400);
    expect(weak.status).toBeLessThan(500);
    const badEmail = await authSignUp('not-an-email', 'E2e-longenoughpassword1');
    expect(badEmail.status).toBeGreaterThanOrEqual(400);
    expect(badEmail.status).toBeLessThan(500);
  });

  it('refresh token returns a working new session', async () => {
    const signedIn = await authSignIn(user.email, user.password);
    const refreshed = await authRefresh(signedIn.body.refresh_token);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();
    expect(refreshed.body.user.id).toBe(user.id);
    const me = await rest(refreshed.body.access_token, 'profiles?select=id');
    expect(me.body).toEqual([{ id: user.id }]);
  });

  it('after sign-out the refresh token no longer works', async () => {
    const signedIn = await authSignIn(user.email, user.password);
    const out = await authSignOut(signedIn.body.access_token);
    expect(out.status).toBe(204);
    const refreshed = await authRefresh(signedIn.body.refresh_token);
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
    expect(refreshed.body.access_token).toBeUndefined();
  });
});
