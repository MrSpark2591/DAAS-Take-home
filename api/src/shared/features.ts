/**
 * The feature-switch catalogue.
 *
 * Same shape as permissions, and for the same reason: the code is what checks a
 * flag, so the catalogue lives in code and only the per-tenant *setting* is
 * data. A flag the application never reads is dead weight; a flag the
 * application reads but nobody has defined is a typo that silently evaluates to
 * "off".
 *
 * Flags are **off unless a tenant has switched them on**. A new feature is
 * therefore dark for everyone until someone deliberately enables it, which is
 * the right default for anything not every customer has paid for or is ready to
 * see.
 *
 * Note what a feature switch is *not*: it is not authorisation. Permissions
 * answer "may this user do it"; a feature answers "does this tenant have it at
 * all". A user with `stock:read` in a tenant without `stock.view` still cannot
 * see stock, and the message says so -- because the fix is a conversation with
 * their account manager, not a permission grant.
 */

export const FEATURES = {
  /** Shows on-hand stock: the nav entry, the page, and the API behind it. */
  STOCK_VIEW: 'stock.view',
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export const FEATURE_DESCRIPTIONS: Record<Feature, string> = {
  [FEATURES.STOCK_VIEW]: 'Show on-hand stock levels',
};

export const ALL_FEATURES = Object.values(FEATURES) as Feature[];

export function isFeature(value: unknown): value is Feature {
  return typeof value === 'string' && (ALL_FEATURES as string[]).includes(value);
}
