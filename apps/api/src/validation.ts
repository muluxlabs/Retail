/**
 * Zod parsing helpers.
 *
 * These throw ZodError, which the error handler maps to 422 in one place.
 * Routes therefore never branch on validity - they either have a parsed
 * value of the right type, or the request already failed.
 */

import { z } from 'zod';

export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

export function parseQuery<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value ?? {});
}

export function parseParams<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value ?? {});
}

/**
 * A true/false query-string flag.
 *
 * NOT z.coerce.boolean(): that is Boolean(value), and Boolean('false') is
 * true - so ?includeInactive=false would switch the flag ON. A query string
 * only ever carries text, so name the accepted spellings.
 */
export const queryBool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');
