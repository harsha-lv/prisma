# File manager

Express + Prisma 7, backed by Neon Postgres and a private Neon Object Storage
bucket named `uploads` (declared in `neon.ts`).

## Run

1. Install dependencies with `npm ci`.
2. Link to your Neon project/branch and run `neon env pull`.
   `.env.example` lists required variables; never commit real credentials.
3. Run `npx prisma migrate deploy` and `npx prisma generate`.
4. Set `SESSION_SECRET` and run `npm run dev`.

Multer accepts one non-empty PDF, PNG, JPEG, or UTF-8 TXT file, up to 4 MB
(leaving room for multipart headers below Vercel's 4.5 MB request limit).
Both root and folder uploads validate file contents before writing. File bytes
live in the private bucket; `Upload.storedName` holds the object key, with
metadata and ownership in Postgres. Downloads require the owner's session.
Signature checks are format checks, **not malware scanning**.

**Authentication remains development-only:** email-only sign-in allows anyone
to impersonate an email address. Sessions use signed, HTTP-only cookies with
server-checked expiration so they work across Vercel function instances.
Cookies contain only the user ID and expiration, not credentials.
Keep Vercel Authentication enabled on all deployments until real application
authentication is implemented.

## Vercel

`server.ts` exports the Express app; `npm run vercel-build` generates Prisma
Client during the build. Node 24 and the `cle1` region are configured.
Set the database/storage variables listed in `.env.example` and a random
`SESSION_SECRET` as Vercel production secrets. No secrets are committed.
Preview environments require separately provisioned database/storage variables.

## Checks

- `npm test`: validation unit tests and HTTP multipart rejection checks.
- `npm run typecheck`: TypeScript.
- `TEST_BASE_URL=http://localhost:3000 npm run test:neon`: checks a running
  server against its configured Neon branch. Uses existing demo accounts
  `test@prisma.io` and `intruder@prisma.io` (creates them if missing), and removes
  only the files/folder created by the check.

## Local-to-Neon migration

The local database and local files are not deleted.

1. Apply migrations to an **empty** target Neon database.
2. Set `LOCAL_DATABASE_URL` to the source connection string and run
   `npx tsx scripts/migrate-data-to-neon.ts`. IDs and relationships are preserved.
   This is a one-off migration, not a synchronizer; do not run against an
   unrelated populated database.
3. Run `npx tsx scripts/backfill-to-storage.ts`. Available local files are copied
   into the bucket and their metadata is repointed. Already-migrated object keys
   are skipped. Missing source files are reported, not fabricated or deleted.

Migration outcome: 3 users, 1 folder, 1 post, and 3 file records copied; 2 available
files copied and verified in storage. Legacy upload ID 1 had already lost its
local bytes before migration; its metadata is retained and download returns 404.
