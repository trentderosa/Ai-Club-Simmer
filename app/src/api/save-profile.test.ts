import type { Backend } from './backend';
import { ApiError } from './errors';
import { saveProfileAndPersonalize } from './save-profile';

const input = { goals: '', experience_level: 'a_little' as const, equipment: ['stove'], budget: 'low' as const, days_per_week: 3, minutes_per_session: 30 };

function fake(personalize: () => Promise<unknown>, save: () => Promise<void> = async () => undefined, tasteSaved = true) {
  const saveOnboarding = jest.fn(async () => {
    await save();
    return { tasteSaved };
  });
  const personalizeMyPath = jest.fn(personalize);
  return { backend: { saveOnboarding, personalizeMyPath } as unknown as Backend, saveOnboarding, personalizeMyPath };
}

describe('saveProfileAndPersonalize', () => {
  it('saves, then personalizes', async () => {
    const f = fake(async () => []);
    await expect(saveProfileAndPersonalize(f.backend, 'u1', input)).resolves.toEqual({ personalized: true, tasteSaved: true });
    expect(f.saveOnboarding).toHaveBeenCalledWith('u1', input);
    expect(f.personalizeMyPath).toHaveBeenCalledTimes(1);
  });

  it('does not block when personalize fails (older database or network)', async () => {
    const missing = fake(async () => {
      throw new ApiError('server', 'Could not find the function public.personalize_my_path', 404, 'PGRST202');
    });
    await expect(saveProfileAndPersonalize(missing.backend, 'u1', input)).resolves.toEqual({ personalized: false, tasteSaved: true });
    const offline = fake(async () => {
      throw new ApiError('network', "Can't reach Supabase.");
    });
    await expect(saveProfileAndPersonalize(offline.backend, 'u1', input)).resolves.toEqual({ personalized: false, tasteSaved: true });
  });

  it('still fails when the profile save fails, and skips personalizing', async () => {
    const f = fake(async () => [], async () => {
      throw new ApiError('server', 'nope');
    });
    await expect(saveProfileAndPersonalize(f.backend, 'u1', input)).rejects.toMatchObject({ kind: 'server' });
    expect(f.personalizeMyPath).not.toHaveBeenCalled();
  });

  it('passes tasteSaved: false through so the UI can show a notice', async () => {
    const f = fake(async () => [], undefined, false);
    await expect(saveProfileAndPersonalize(f.backend, 'u1', input)).resolves.toEqual({ personalized: true, tasteSaved: false });
  });
});
