/**
 * Domain errors to HTTP, in one place only.
 *
 * HANDOFF section 8 is explicit that this mapping lives at the edge and
 * nowhere else. Route handlers throw domain errors and never think about
 * status codes; this plugin turns them into responses.
 *
 * The status codes are chosen so a client can act on them without parsing
 * prose, and the machine-readable `code` is always the domain's own, so the
 * offline POS and the web app branch on the same identifier.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DomainError } from '@retail-ops/domain';
import { ZodError } from 'zod';

const STATUS_BY_CODE: Record<string, number> = {
  // We do not know who you are.
  NOT_AUTHENTICATED: 401,
  // We know who you are, and your role does not allow this.
  NOT_PERMITTED: 403,
  // A seeded or reset password must be replaced before the system is usable.
  PASSWORD_CHANGE_REQUIRED: 403,
  // The stock guard fired. Not the caller's fault, not a validation error:
  // it is a conflict with the current state of the ledger.
  NEGATIVE_STOCK_BLOCKED: 409,
  // Scanned something not in the master. Genuinely absent.
  UNLISTED_BARCODE: 404,
  // Someone tried to mutate history. The method is not allowed, ever.
  LEDGER_IMMUTABLE: 405,
  // Master data that would reintroduce a known defect.
  INVALID_MASTER_DATA: 422,
  // Merged during cleanse; it keeps its history but accepts no movements.
  PRODUCT_MERGED: 409,
  INVALID_MOVEMENT: 422,
  UNKNOWN_MOVEMENT: 404,
};

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
}

export function statusForDomainError(error: DomainError): number {
  return STATUS_BY_CODE[error.code] ?? 400;
}

/**
 * Postgres error codes we can explain better than "internal error".
 * Chiefly the append-only trigger, which raises when anything tries to
 * UPDATE or DELETE the ledger.
 */
function translatePostgres(error: { code?: string; message?: string }): {
  status: number;
  body: ErrorBody;
} | null {
  const message = error.message ?? '';
  if (message.includes('append-only')) {
    return {
      status: 405,
      body: {
        error: {
          code: 'LEDGER_IMMUTABLE',
          message:
            'The stock ledger is append-only. Post a reversing movement instead.',
        },
      },
    };
  }
  switch (error.code) {
    case '23505': // unique_violation
      return {
        status: 409,
        body: { error: { code: 'DUPLICATE', message: 'That record already exists.' } },
      };
    case '23503': // foreign_key_violation
      return {
        status: 422,
        body: {
          error: { code: 'UNKNOWN_REFERENCE', message: 'A referenced record does not exist.' },
        },
      };
    case '23514': // check_violation
      return {
        status: 422,
        body: {
          error: {
            code: 'CONSTRAINT_VIOLATION',
            message: `A database constraint rejected this write: ${message}`,
          },
        },
      };
    case '42P01': // undefined_table
    case '42703': // undefined_column
      // The single most common way to reach this in a fresh deployment: the
      // database is real and reachable, but `npm run db:migrate` was never
      // run against it. Migrations do not run automatically on Vercel - see
      // docs/01-deployment.md section 3. Surfaced as 503, not 500: the
      // service is not broken, it is not yet provisioned.
      return {
        status: 503,
        body: {
          error: {
            code: 'SCHEMA_NOT_MIGRATED',
            message:
              'The database is reachable but its schema is missing or out of date. ' +
              'Run `npm run db:migrate` against it, then `npm run db:seed`.',
          },
        },
      };
    default:
      return null;
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof DomainError) {
      const status = statusForDomainError(error);
      // A blocked sale is normal operation, not a server fault. Log at info so
      // the error log stays a place where real faults are visible.
      request.log.info({ code: error.code, detail: error.detail }, 'domain rule refused');
      return reply.status(status).send({
        error: { code: error.code, message: error.message, detail: error.detail },
      } satisfies ErrorBody);
    }

    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request did not match the expected shape.',
          detail: { issues: error.issues },
        },
      } satisfies ErrorBody);
    }

    if (typeof error === 'object' && error !== null) {
      const translated = translatePostgres(error as { code?: string; message?: string });
      if (translated !== null) {
        request.log.warn({ err: error }, 'database constraint rejected a write');
        return reply.status(translated.status).send(translated.body);
      }
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (typeof statusCode === 'number' && statusCode < 500) {
        return reply.status(statusCode).send({
          error: {
            code: (error as { code?: string }).code ?? 'BAD_REQUEST',
            message: (error as { message?: string }).message ?? 'Bad request',
          },
        } satisfies ErrorBody);
      }
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side.' },
    } satisfies ErrorBody);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    } satisfies ErrorBody),
  );
}
