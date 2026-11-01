"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface GithubQuery<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Ask again (same key). */
  retry: () => void;
}

/**
 * One GitHub read the pickers depend on: runs `fn` when `key` changes (after `delay` ms, so typing
 * doesn't fire a request per key), aborts the one before, and drops an answer that arrives after
 * the key moved on. `key` null: nothing to ask (data cleared). `keep`: show the last answer while
 * the next one loads (a repository list being searched), instead of clearing it.
 */
export function useGithubQuery<T>(key: string | null, fn: (signal: AbortSignal) => Promise<T>, opts: { delay?: number; keep?: boolean } = {}): GithubQuery<T> {
  const { delay = 0, keep = false } = opts;
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ key: string | null; data: T | null; error: unknown; loading: boolean }>({ key: null, data: null, error: null, loading: false });

  useEffect(() => {
    if (key === null) {
      setState({ key: null, data: null, error: null, loading: false });
      return;
    }
    const ac = new AbortController();
    setState((s) => ({ key, data: keep || s.key === key ? s.data : null, error: null, loading: true }));
    const t = window.setTimeout(() => {
      fnRef.current(ac.signal)
        .then((data) => { if (!ac.signal.aborted) setState({ key, data, error: null, loading: false }); })
        .catch((error: unknown) => { if (!ac.signal.aborted) setState({ key, data: null, error, loading: false }); });
    }, delay);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [key, nonce, delay, keep]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, retry };
}

export default useGithubQuery;
