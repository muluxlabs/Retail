/**
 * Zod parsing helpers.
 *
 * These throw ZodError, which the error handler maps to 422 in one place.
 * Routes therefore never branch on validity - they either have a parsed
 * value of the right type, or the request already failed.
 */

import type { z } from 'zod';

export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

export function parseQuery<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value ?? {});
}

export function parseParams<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value ?? {});
}
