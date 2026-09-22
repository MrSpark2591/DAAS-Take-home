/**
 * Money crosses the wire as integer cents and is only ever turned into a
 * decimal for display. Nothing in the app does arithmetic on the formatted
 * string.
 */
const currency = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
});

export const formatCents = (cents: number): string => currency.format(cents / 100);

const dateTime = new Intl.DateTimeFormat('en-AU', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const formatDateTime = (iso: string): string => dateTime.format(new Date(iso));

const date = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium' });

export const formatDate = (iso: string): string => date.format(new Date(iso));
