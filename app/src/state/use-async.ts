/**
 * Minimal data loader: runs `load` on mount (and when `deps` change) and
 * exposes loading / error / data plus `reload`. Results from a superseded run
 * are dropped. While reloading, the previous `data` stays available so screens
 * can keep showing it.
 */
import { useCallback, useEffect, useState } from 'react';

export type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'error'; data: T | null; error: unknown }
  | { status: 'ready'; data: T; error: null };

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading', data: null, error: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    load().then(
      (data) => current && setState({ status: 'ready', data, error: null }),
      (error: unknown) => current && setState((s) => ({ status: 'error', data: s.data, error })),
    );
    return () => {
      current = false;
    };
    // `load` is intentionally not a dependency: callers pass an inline function and list its inputs in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);

  const reload = useCallback(() => {
    setState((s) => ({ status: 'loading', data: s.data, error: null }));
    setVersion((v) => v + 1);
  }, []);

  return { ...state, reload };
}
