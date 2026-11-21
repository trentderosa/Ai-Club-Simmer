import { act, useEffect } from 'react';
import TestRenderer from 'react-test-renderer';

import { ApiError } from '../api/errors';
import { useDishPhotos, type DishPhotoLookup } from './use-dish-photos';

const mockDishPhotos = jest.fn();
const mockSessionValue = {
  backend: {
    dishPhotos: (names: string[], token: string) => mockDishPhotos(names, token) as Promise<Record<string, null>>,
  },
  session: { accessToken: 'tok' },
};

jest.mock('./session', () => ({
  useSession: () => mockSessionValue,
}));

const resultRef: { current: DishPhotoLookup | null } = { current: null };

function Probe({ names }: { names: string[] }) {
  const value = useDishPhotos(names);
  useEffect(() => {
    resultRef.current = value;
  });
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined;

async function mount(names: string[] = ['Eggs']) {
  await act(async () => {
    renderer = TestRenderer.create(<Probe names={names} />);
  });
  if (!resultRef.current) throw new Error('hook did not render');
  return resultRef.current;
}

async function unmount() {
  const current = renderer;
  renderer = undefined;
  if (!current) return;
  await act(async () => {
    current.unmount();
  });
}

describe('useDishPhotos outage', () => {
  afterEach(async () => {
    await unmount();
    mockDishPhotos.mockReset();
  });

  it('sets outage on a 503 and leaves it null for a 500 or a bad response', async () => {
    const unavailable = new ApiError('unavailable', 'Request failed (503).', 503);
    mockDishPhotos.mockRejectedValueOnce(unavailable);
    const down = await mount();
    expect(down.outage).toBe(unavailable);
    expect(down.photos).toEqual({});
    await unmount();

    mockDishPhotos.mockRejectedValueOnce(new ApiError('server', 'Internal server error', 500));
    const server = await mount();
    expect(server.outage).toBeNull();
    await unmount();

    mockDishPhotos.mockRejectedValueOnce(new ApiError('bad_response', 'Unexpected response from the AI server.'));
    const bad = await mount();
    expect(bad.outage).toBeNull();
  });

  it('reloads the photo lookup when retry is pressed', async () => {
    mockDishPhotos.mockRejectedValueOnce(new ApiError('unavailable', 'Request failed (503).', 503));
    mockDishPhotos.mockResolvedValueOnce({ eggs: null });
    const first = await mount();
    expect(first.outage).toBeInstanceOf(ApiError);
    expect(mockDishPhotos).toHaveBeenCalledTimes(1);
    expect(mockDishPhotos).toHaveBeenCalledWith(['eggs'], 'tok');

    await act(async () => {
      resultRef.current?.retry();
    });

    expect(mockDishPhotos).toHaveBeenCalledTimes(2);
    expect(resultRef.current?.outage).toBeNull();
    expect(resultRef.current?.photos).toEqual({ eggs: null });
  });
});
