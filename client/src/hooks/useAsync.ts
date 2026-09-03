import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ApiError } from '../api/client.js';

/**
 * Data-fetching hook covering the states every data surface needs: loading,
 * success, error, and "still loading after an interaction".
 *
 * It keeps the previous payload while refreshing so tables do not flash back to
 * skeletons on every keystroke, and aborts the in-flight request when the
 * inputs change or the component unmounts.
 */

export type AsyncStatus = 'loading' | 'success' | 'error';

interface State<T> {
  status: AsyncStatus;
  data: T | undefined;
  error: ApiError | Error | null;
  /** True while the very first request is in flight (nothing to show yet). */
  isInitial: boolean;
  /** True while a later request is in flight (previous data still on screen). */
  isRefreshing: boolean;
  lastUpdated: number | null;
  token: number;
}

type Action<T> =
  | { type: 'start'; token: number }
  | { type: 'success'; token: number; data: T }
  | { type: 'error'; token: number; error: ApiError | Error }
  | { type: 'reset' };

function reduce<T>(state: State<T>, action: Action<T>): State<T> {
  switch (action.type) {
    case 'start':
      return {
        ...state,
        token: action.token,
        status: 'loading',
        isInitial: state.data === undefined,
        isRefreshing: state.data !== undefined,
        error: null,
      };
    case 'success':
      if (action.token !== state.token) return state;
      return {
        status: 'success',
        data: action.data,
        error: null,
        isInitial: false,
        isRefreshing: false,
        lastUpdated: Date.now(),
        token: state.token,
      };
    case 'error':
      if (action.token !== state.token) return state;
      return {
        status: 'error',
        data: state.data,
        error: action.error,
        isInitial: false,
        isRefreshing: false,
        lastUpdated: state.lastUpdated,
        token: state.token,
      };
    case 'reset':
      return {
        status: 'loading',
        data: undefined,
        error: null,
        isInitial: true,
        isRefreshing: false,
        lastUpdated: null,
        token: state.token,
      };
  }
}

export interface UseAsyncOptions {
  /** Skip the request until a required input exists. */
  enabled?: boolean;
}

export interface AsyncResource<T> {
  data: T | undefined;
  error: ApiError | Error | null;
  status: AsyncStatus;
  isLoading: boolean;
  isInitial: boolean;
  isRefreshing: boolean;
  lastUpdated: number | null;
  /** Re-run the request, keeping the current payload visible. */
  refresh: () => void;
  /** Drop the cached payload and refetch from scratch. */
  reset: () => void;
}

export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: UseAsyncOptions = {},
): AsyncResource<T> {
  const { enabled = true } = options;
  const [state, dispatch] = useReducer(reduce as (previous: State<T>, action: Action<T>) => State<T>, {
    status: 'loading',
    data: undefined,
    error: null,
    isInitial: true,
    isRefreshing: false,
    lastUpdated: null,
    token: 0,
  });
  const [reloadKey, setReloadKey] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const tokenRef = useRef(0);

  const run = useCallback(() => {
    tokenRef.current += 1;
    const token = tokenRef.current;
    dispatch({ type: 'start', token });

    const controller = new AbortController();
    loaderRef
      .current(controller.signal)
      .then((data) => dispatch({ type: 'success', token, data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: 'error', token, error: error instanceof Error ? error : new Error('Unexpected error.') });
      });

    return () => controller.abort();
  }, []);

  const depKey = JSON.stringify(deps);

  useEffect(() => {
    if (!enabled) return undefined;
    return run();
  }, [run, enabled, depKey, reloadKey]);

  const refresh = useCallback(() => {
    run();
  }, [run]);

  const reset = useCallback(() => {
    dispatch({ type: 'reset' });
    setReloadKey((key) => key + 1);
  }, []);

  return useMemo(
    () => ({
      data: state.data,
      error: state.error,
      status: state.status,
      isLoading: state.status === 'loading',
      isInitial: state.isInitial,
      isRefreshing: state.isRefreshing,
      lastUpdated: state.lastUpdated,
      refresh,
      reset,
    }),
    [state, refresh, reset],
  );
}

/** Debounce a rapidly changing value (search boxes) without adding a dependency. */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
