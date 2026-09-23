import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';
import { readInt } from './env.js';

/**
 * Structured logging.
 *
 * JSON in production so a log shipper can index fields; pretty-printed in
 * development so a human can read it. One logger is created per process and
 * child loggers carry request-scoped context, which is what makes it possible
 * to follow a single request through the whole stack.
 */

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

/**
 * Anything that could carry a credential is redacted before it is written.
 *
 * This is the load-bearing part of the config: a bearer token or a password
 * that reaches a log file is a credential leak that survives log retention and
 * gets copied into every downstream system. Redaction is applied by path, so
 * adding a field to a log call cannot accidentally widen what is captured.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'password',
  '*.password',
  'variables.input.password',
  'accessToken',
  'refreshToken',
  '*.accessToken',
  '*.refreshToken',
  'tokenHash',
  'passwordHash',
  '*.passwordHash',
];

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isTest ? 'silent' : isProduction ? 'info' : 'debug'),
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  base: { service: 'daas-api' },
  // Seconds-since-epoch is the default; ISO is far easier to grep by eye and
  // is what most log backends expect anyway.
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Ship the level as a word rather than pino's numeric default.
    level: (label) => ({ level: label }),
  },
  transport:
    isProduction || isTest
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, ignore: 'pid,hostname,service', translateTime: 'HH:MM:ss.l' },
        },
});

/** How long a GraphQL operation may take before it is logged as slow. */
export const slowOperationMs = () => readInt('SLOW_OPERATION_MS', 500);

export interface RequestLogContext {
  requestId: string;
  userId?: string | null;
  ip?: string | null;
}

/**
 * A child logger bound to one request. Every line it writes carries the same
 * `requestId`, so a failure can be traced back through every log line that
 * request produced -- including ones written from deep inside a service.
 */
export function requestLogger(context: RequestLogContext): Logger {
  return logger.child(context);
}

/** Correlation id: reuses an inbound header when a proxy already set one. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  // Bounded, because this lands in every log line for the request.
  if (value && value.length <= 200) return value;
  return randomUUID();
}
