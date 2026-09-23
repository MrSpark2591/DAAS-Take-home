import { readInt } from './env.js';
import { badInput } from './errors.js';

/**
 * Keyset (cursor) pagination.
 *
 * Not offset/limit. `OFFSET 5000` makes Postgres walk and discard 5000 rows on
 * every request, so the last page of a long list is the slowest — and a row
 * inserted while someone pages either shifts an item onto a page they have
 * already seen or hides one entirely. Keyset asks "give me the rows after this
 * one", which is a single index seek at any depth and is stable under inserts.
 *
 * The cost is that you cannot jump to "page 37": you can only walk forward from
 * where you are. That is the right trade for a list a person scrolls, and it is
 * why the UI offers next/previous rather than numbered pages.
 *
 * This is also why the schema uses UUIDv7 primary keys: they sort by creation
 * time, so `ORDER BY id DESC` is both a meaningful "newest first" and a usable
 * keyset column, with no extra index.
 */

/** Hard ceiling, so one caller cannot ask for the whole table. */
export const maxPageSize = () => readInt('MAX_PAGE_SIZE', 100);
export const defaultPageSize = () => readInt('DEFAULT_PAGE_SIZE', 20);

export interface PageArgs {
  first?: number | null;
  after?: string | null;
}

export interface ResolvedPage {
  /** Rows to fetch. Callers request `limit + 1` to detect a next page. */
  limit: number;
  /** Decoded cursor components, or null on the first page. */
  cursor: string[] | null;
}

export function resolvePageArgs(args: PageArgs): ResolvedPage {
  const requested = args.first ?? defaultPageSize();

  if (!Number.isInteger(requested) || requested < 1) {
    throw badInput('`first` must be a positive whole number.', { field: 'first' });
  }
  if (requested > maxPageSize()) {
    throw badInput(`\`first\` cannot exceed ${maxPageSize()}.`, { field: 'first' });
  }

  return { limit: requested, cursor: args.after ? decodeCursor(args.after) : null };
}

/**
 * Cursors are opaque on purpose. Clients that parse them end up depending on
 * the sort key, which then cannot change without breaking them.
 */
export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(['v1', ...parts]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badInput('Invalid pagination cursor.', { field: 'after' });
  }

  if (!Array.isArray(parsed) || parsed[0] !== 'v1' || parsed.length < 2) {
    throw badInput('Invalid pagination cursor.', { field: 'after' });
  }

  const parts = parsed.slice(1);
  if (!parts.every((part): part is string => typeof part === 'string')) {
    throw badInput('Invalid pagination cursor.', { field: 'after' });
  }
  return parts;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Trims the sentinel row and builds the page info.
 *
 * Fetching `limit + 1` and checking whether the extra row arrived is how
 * `hasNextPage` is answered without a second COUNT query.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => string,
): { nodes: T[]; pageInfo: PageInfo } {
  const hasNextPage = rows.length > limit;
  const nodes = hasNextPage ? rows.slice(0, limit) : rows;
  const last = nodes.at(-1);

  return {
    nodes,
    pageInfo: { hasNextPage, endCursor: last ? toCursor(last) : null },
  };
}
