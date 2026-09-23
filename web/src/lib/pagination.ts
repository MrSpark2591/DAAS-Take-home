'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Cursor pagination state for a list screen.
 *
 * Cursors only walk forward, so "previous" is served by remembering the cursor
 * that opened each page rather than by asking the server to walk backwards.
 * That is the trade keyset pagination makes: no arbitrary page jumps, but every
 * page costs the same regardless of depth.
 */
export function useCursorPagination(pageSize: number) {
  // Index 0 is the first page, which has no cursor.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const after = cursors[pageIndex] ?? null;

  const next = useCallback((endCursor: string | null | undefined) => {
    if (!endCursor) return;
    setCursors((previous) => {
      // Truncate before appending: paging forward after going back must not
      // leave a stale cursor for a page that is about to be replaced.
      const kept = previous.slice(0, pageIndexRef.current + 1);
      return [...kept, endCursor];
    });
    setPageIndex((index) => index + 1);
  }, []);

  const previous = useCallback(() => {
    setPageIndex((index) => Math.max(0, index - 1));
  }, []);

  /** Call when a filter changes: the old cursors point into a different result set. */
  const reset = useCallback(() => {
    setCursors([null]);
    setPageIndex(0);
  }, []);

  // `next` needs the current index without taking it as a dependency, which
  // would rebuild the callback on every page change.
  const pageIndexRef = useRef(pageIndex);
  useEffect(() => {
    pageIndexRef.current = pageIndex;
  }, [pageIndex]);

  const range = useMemo(
    () => ({ from: pageIndex * pageSize + 1, to: (pageIndex + 1) * pageSize }),
    [pageIndex, pageSize],
  );

  return { after, pageIndex, next, previous, reset, range, hasPrevious: pageIndex > 0 };
}

/**
 * Debounces a value. Search boxes send a request per keystroke otherwise, which
 * is wasted work and makes the list flicker between partial matches.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
