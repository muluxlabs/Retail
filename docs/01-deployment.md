# Deploying to Vercel + Neon

Target chosen by the client: everything on Vercel, Postgres on Neon.

This document is the runbook. It also records, honestly, the three places where
the serverless target constrains the design, so that whoever picks this up next
knows which limits are deliberate and which are worth revisiting.

---

## 1. What you need before starting

| Thing | Where | Notes |
|---|---|---|
| GitHub repo | `muluxlabs/Retail` | Already exists |
| Vercel account | vercel.com | Free tier is enough to evaluate |
| Neon account | neon.tech | Free tier is enough to evaluate |

You do **not** need Docker for production. Docker is only the local database.

---

## 2. Create the database

1. Create a Neon project. **Pick the region closest to Zimbabwe** — at time of
   writing that is `aws-eu-central-1` (Frankfurt) or `aws-ap-south-1` (Mumbai);
   check whether `af-south-1` (Cape Town) is offered, because it is by far the
   closest and will roughly halve round-trip time from Zimbabwe.
2. Copy **both** connection strings from the dashboard:
   - the **pooled** one, containing `-pooler` in the host
   - the **direct** one, without `-pooler`

You need both, and they are used for different things:

| String | Used by | Why |
|---|---|---|
| Pooled (`-pooler`) | The running API | Each serverless invocation opens its own connection. Without the pooler you exhaust Postgres connections under very light load. |
| Direct | Migrations only | `CREATE TYPE`, `CREATE TRIGGER` and the advisory locks used during migration do not behave reliably through a transaction-mode pooler. |

---

## 3. Apply the schema

Migrations do not run on Vercel — there is no deploy hook that can be trusted
to run exactly once. Run them from your machine against Neon, using the
**direct** string:

```bash
cd Retail
DATABASE_URL='postgres://…direct…/neondb?sslmode=require' npm run db:migrate
```

Expect:

```
  + 001_core.sql
  + 002_person_role_scope.sql
  + 003_auth.sql
```

Then seed the demonstration data and the administrator account. Choose the
admin password here; it is the one you hand out for feedback:

```bash
DATABASE_URL='postgres://…direct…/neondb?sslmode=require' \
ADMIN_PASSWORD='pick-something-long-here' \
npm run db:seed
```

It prints the sign-in details once. They are not recoverable afterwards —
only a scrypt hash is stored.

> For a real pilot with real staff, seed the schema but **not** the sample
> trading data. There is currently no `--schema-only` flag; say the word and
> it is a ten-minute addition.

---

## 4. Deploy

The repository already contains `api/index.ts` (the serverless entry that
wraps Fastify) and `vercel.json` (routing and build configuration).

1. In Vercel, **Add New → Project**, import `muluxlabs/Retail`.
2. Leave the framework preset as detected; `vercel.json` overrides what matters.
3. Add these environment variables, all for **Production** and **Preview**:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **pooled** Neon string |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `NODE_ENV` | `production` |

4. Deploy.

`NODE_ENV=production` matters more than it looks: it is what makes the session
cookie `Secure`. Without it the cookie is sent over plain HTTP.

Because the web app and the API are served from the same Vercel domain, the
session cookie is first-party and `VITE_API_URL` is not needed. If you later
split them onto separate domains, set `VITE_API_URL` on the frontend and
`CORS_ORIGINS` on the API, and change the cookie to `SameSite=None`.

---

## 5. First sign-in

1. Open the deployment URL.
2. Sign in as `admin@retailops.local` with the password you set in step 3.
3. You are forced to choose a new password before anything else loads. This is
   deliberate — a shared credential must not stay shared.
4. Create accounts for reviewers under **Staff → Add person**. Each gets a
   one-time password shown once on screen.

Give reviewers their own accounts rather than sharing the admin login. Every
action is attributed to a person in the audit log, and shared credentials
destroy that — which is the exact failure recorded in HANDOFF §2.6.

---

## 6. Where serverless constrains this build

Recorded plainly so nobody has to rediscover it.

**Cold starts.** An idle deployment takes roughly 1–3 seconds on the first
request while the function boots and connects. Subsequent requests are fast.
For a demonstration this is fine; for cashiers using it all day it is not, and
it is the main reason to revisit the hosting choice before go-live.

**Password hashing costs CPU.** scrypt at N=32768 takes 100–150ms per sign-in
and serverless CPU is slower than a dedicated instance. Sign-in will feel
slower than the rest of the app. Lowering the cost parameter would be the
wrong fix.

**No background work.** Three things on the roadmap need a process that runs
without an incoming HTTP request, and none of them can be built on this target
as configured:

- the nightly ledger-vs-count exception job (scope reconciliation §5)
- ZIMRA fiscal day open/close tracking (HANDOFF §3.1)
- offline POS sync reconciliation

Vercel Cron can cover the nightly job. Fiscalisation needs a persistent
process holding a device certificate and private key, and that is the point at
which this deployment target has to be reconsidered. It is a Release 1 legal
requirement, not an optional extra, so plan for it rather than discovering it.

**Connection limits.** Use the pooled string. If you see
`too many clients already`, that is the direct string in `DATABASE_URL`.

---

## 7. Local development is unchanged

```bash
npm run db:up        # Postgres 16 in Docker, host port 5433
npm run db:migrate
npm run db:seed
npm run dev:api      # localhost:3000
npm run dev:web      # localhost:5173
```

`npm run db:reset` drops and rebuilds everything. It refuses to run against
any host that is not local.

---

## 8. Before real staff data goes in

Not blockers for a feedback deployment. Blockers for production.

1. **POTRAZ notification.** Hosting outside Zimbabwe means personal data
   crosses a border, which must be notified in advance under the Cyber and
   Data Protection Act [Chapter 12:07]. This applies to Vercel and Neon
   wherever their regions are. See HANDOFF §3.2.
2. **VAT registration status.** Still unanswered. If the group is
   VAT-registered, a POS that cannot issue a fiscal receipt cannot legally
   trade, and ZIMRA FDMS onboarding is on the critical path.
3. **Backups.** Neon's free tier retention is short. Check it against how much
   history the business is willing to lose.
4. **Rate limiting.** Sign-in locks an account after 8 failed attempts, but
   there is no IP-level limit in front of it yet.
