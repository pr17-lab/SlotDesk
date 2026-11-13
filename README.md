# SlotDesk

A multi-tenant appointment booking API. Businesses (organizations) have staff and, later, bookable resources such as a person or a room. The two things it is built to get right are:

- **No double booking**, even when many people book the same slot at the same moment. The database enforces it.
- **No data leaking between organizations.** Every organization route checks membership, and every query is scoped to the organization.

[![CI](https://github.com/pr17-lab/SlotDesk/actions/workflows/ci.yml/badge.svg)](https://github.com/pr17-lab/SlotDesk/actions/workflows/ci.yml)

## Status

This is a work in progress. What exists and is tested today:

- Sign-up, sign-in and sessions (email and password, using Better Auth).
- Organizations and members, with an owner and staff role, and a tenant check on every organization route.
- The booking tables, including a database rule that makes overlapping confirmed bookings impossible, and tests that prove it under 30 concurrent connections.
- The API runs on a free Render instance with a Neon database.

Not built yet: the booking routes, services and availability, and the React client. See [DESIGN.md](DESIGN.md) for how the pieces fit and why.

**Live API:** `https://slotdesk-wfgi.onrender.com/api/health`. It runs on a free instance that sleeps after 15 minutes without requests, so the first request can take about 30 seconds.

## Tech stack

Node 24, TypeScript (strict), Express 5, PostgreSQL 17, `pg` with hand-written SQL, `node-pg-migrate`, Better Auth, Zod, pino, Vitest and Supertest, ESLint and Prettier, GitHub Actions.

## API

Every route is under `/api`. IDs are strings in JSON.

| Method and path | Who can call it | What it does |
|---|---|---|
| `GET /api/health` | anyone | Returns `{ "status": "ok" }` |
| `/api/auth/*` | anyone | Sign-up, sign-in, sign-out and session routes handled by Better Auth (for example `POST /api/auth/sign-up/email`) |
| `POST /api/orgs` | signed in | Create an organization; you become its owner (201) |
| `GET /api/orgs` | signed in | List your organizations and your role in each |
| `GET /api/orgs/:orgId` | members | `{ id, name, role }` |
| `GET /api/orgs/:orgId/members` | members | List members |
| `POST /api/orgs/:orgId/members` | owner | Add an existing user by email as staff (201; 404 unknown email; 409 already a member) |
| `DELETE /api/orgs/:orgId/members/:userId` | owner | Remove a staff member (204; 409 for the owner) |

A person who is not a member of an organization gets 404, the same answer as for an organization that does not exist. Requests that change data under `/api/orgs` must send an `Origin` header that matches `BETTER_AUTH_URL`.

## Run it locally

You need [Git](https://git-scm.com/), [Node.js](https://nodejs.org/) 24 (the repository pins the major version in `server/.nvmrc`) and [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or any Docker with Compose). Start Docker Desktop before step 3.

The commands below are for PowerShell on Windows. On macOS or Linux, use `cp` instead of `Copy-Item`; everything else is the same.

**1. Get the code.**

```powershell
git clone https://github.com/pr17-lab/SlotDesk.git
cd SlotDesk
```

**2. Create the two settings files from the examples.** The example database values work unchanged on a local machine.

```powershell
Copy-Item .env.example .env
Copy-Item server\.env.example server\.env
```

`.env` (project root) is read only by Docker Compose. `server\.env` is read by the app and the tests.

**3. Start PostgreSQL.**

```powershell
docker compose up -d
docker compose ps
```

Right after `up -d` the status says `health: starting`. Run `docker compose ps` again every few seconds until it shows `healthy` for `db`, with `0.0.0.0:5432->5432` under ports. The first start downloads the PostgreSQL image, which can take a few minutes, and also creates a second database, `slotdesk_test`, for the tests.

Docker Compose names the container and the data volume after the folder you cloned into (in lowercase). If you already have another copy of this project in a folder with the same name, the two copies share one database, and `docker compose down -v` in either one deletes it. Clone into a folder with a different name to keep them apart.

**4. Install the dependencies.**

```powershell
cd server
npm ci
```

`npm ci` may report moderate vulnerabilities. They are in development tools only; the production dependencies have none (CI checks this). Do not run `npm audit fix`, which would change the locked versions.

**5. Set the auth secret.** The app refuses to start without one. Generate a secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Open `.env` in the `server` folder (the folder you are in now) and paste the output after `BETTER_AUTH_SECRET=` (no spaces, no quotes). Never commit this file; git ignores it.

**6. Create the tables.**

```powershell
npm run migrate:up
```

**7. Start the server and check it.**

```powershell
npm run dev
```

Leave it running. In a second terminal (any folder):

```powershell
curl.exe http://localhost:3000/api/health
```

You should see `{"status":"ok"}`. (In PowerShell, use `curl.exe`, not `curl`, which is a different command.) Stop the server with Ctrl+C in the first terminal.

### Run the checks

From the `server` folder:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
npm run test:db
```

- `npm test` runs the unit tests and needs no database.
- `npm run test:db` runs the database tests against `slotdesk_test`. It deletes and re-creates the tables in that database on every run and refuses to run against any database whose name does not end in `_test`. The 30-connection booking race tests are part of it. Some tests kill database connections on purpose, so error lines in its output (for example `Idle database client error`) are expected; what matters is the final summary.

### If something fails

| What you see | Likely cause | Fix |
|---|---|---|
| `ECONNREFUSED` when running migrations, the server or tests | The database is not running, or the port in a URL does not match the port Docker publishes | Run `docker compose ps`. See "If port 5432 is already in use" below |
| `password authentication failed for user "slotdesk"` | An old Docker data volume kept an earlier password. PostgreSQL reads the password only when it first creates the volume | Reset the local database: `docker compose down -v`, then `docker compose up -d` (this deletes the local data) |
| The server exits at start, mentioning `BETTER_AUTH_SECRET` | The secret is missing or shorter than 32 characters | Repeat step 5 |
| `npm warn EBADENGINE` from `npm ci`, or odd errors from the tools | Node is not version 24 | Install Node 24 and run `npm ci` again |

### If port 5432 is already in use

Another PostgreSQL on your machine may already use 5432. Pick another port, for example 5433, and change exactly these three lines so they agree:

- `POSTGRES_PORT=5433` in `.env`
- `DATABASE_URL=postgresql://slotdesk:changeme@localhost:5433/slotdesk` in `server\.env`
- `TEST_DATABASE_URL=postgresql://slotdesk:changeme@localhost:5433/slotdesk_test` in `server\.env`

Then run `docker compose down -v` and `docker compose up -d` again.

## Project layout

```
server/
  src/
    app.ts, server.ts      the Express app, and the file that starts it
    auth.ts                Better Auth settings
    password.ts            password hashing (scrypt)
    config.ts              environment settings checked with Zod
    db.ts                  the PostgreSQL connection pool
    middleware/            origin, session, membership and role checks; errors
    routes/                health, organizations, members
    data/                  the SQL (one file per kind of data)
  migrations/              SQL migration files
  test/                    unit tests; test/db holds the database tests
docker-compose.yml         local PostgreSQL 17
.github/workflows/ci.yml   CI: checks, tests and a dependency audit
```

## More

- [DESIGN.md](DESIGN.md): the design decisions, and the reasons for them.
- [LICENSE](LICENSE): MIT.
