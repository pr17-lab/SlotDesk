# SlotDesk

A multi-tenant appointment booking app: an API and a React client. Businesses (organizations) have staff and, later, bookable resources such as a person or a room. The two things it is built to get right are:

- **No double booking**, even when many people book the same slot at the same moment. The database enforces it.
- **No data leaking between organizations.** Every organization route checks membership, and every query is scoped to the organization.

[![CI](https://github.com/pr17-lab/SlotDesk/actions/workflows/ci.yml/badge.svg)](https://github.com/pr17-lab/SlotDesk/actions/workflows/ci.yml)

## Status

This is a work in progress. What exists and is tested today:

- Sign-up, sign-in and sessions (email and password, using Better Auth).
- Organizations and members, with an owner and staff role, and a tenant check on every organization route.
- Resources (create, list, view, rename), with time zones checked.
- Services (create, list, view, update), each with a duration of 5 to 480 minutes.
- Working hours per resource (a weekly timetable in the resource's time zone, replaced as a whole week).
- Availability: the free start times for a service on a resource, in UTC, with daylight saving changes handled.
- Booking a guest customer into a slot (owner or staff), accepted only for a start the availability route would offer.
- Listing a resource's bookings by local date, viewing one booking, and cancelling a booking (owner or staff).
- The booking tables, including a database rule that makes overlapping confirmed bookings impossible, and tests that prove it under 30 concurrent connections and under 10 simultaneous requests to the booking route.
- The API runs on a free Render instance with a Neon database, and serves the React client from the same address.

The React client so far has sign up, sign in and sign out; the booking screens come next. See [DESIGN.md](DESIGN.md) for how the pieces fit and why.

**Live app:** `https://slotdesk-wfgi.onrender.com` (the API health check is `/api/health`). It runs on a free instance that sleeps after 15 minutes without requests, so the first request can take about 30 seconds.

## Tech stack

Node 24, TypeScript (strict), Express 5, React 19 with React Router, Vite, Tailwind CSS, PostgreSQL 17, `pg` with hand-written SQL, `node-pg-migrate`, Better Auth, Zod, `temporal-polyfill` (time zone checks), pino, Vitest, Supertest and Testing Library, ESLint and Prettier, GitHub Actions.

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
| `GET /api/orgs/:orgId/resources` | members | List the organization's resources |
| `POST /api/orgs/:orgId/resources` | owner | Create a resource from `{ name, timeZone }` (201; 400 for a bad name or an invalid IANA time zone such as `Mars/Base` or `+05:30`) |
| `GET /api/orgs/:orgId/resources/:resourceId` | members | `{ id, name, timeZone }` (404 if not found) |
| `PATCH /api/orgs/:orgId/resources/:resourceId` | owner | Rename only. The time zone is fixed at creation, so a body with `timeZone` is a 400 (404 if not found) |
| `GET /api/orgs/:orgId/services` | members | List the organization's services |
| `POST /api/orgs/:orgId/services` | owner | Create a service from `{ name, durationMinutes }` (201; 400 for a bad name or a duration that is not 5 to 480 minutes in steps of 5) |
| `GET /api/orgs/:orgId/services/:serviceId` | members | `{ id, name, durationMinutes }` (404 if not found) |
| `PATCH /api/orgs/:orgId/services/:serviceId` | owner | Change `name`, `durationMinutes` or both (400 for an empty body or an unknown field; 404 if not found) |
| `GET /api/orgs/:orgId/resources/:resourceId/working-hours` | members | `{ windows: [{ weekday, startMinute, endMinute }] }`, sorted by weekday and start (404 if the resource is not found) |
| `PUT /api/orgs/:orgId/resources/:resourceId/working-hours` | owner | Replace the whole week with `{ windows }`: weekday 1 is Monday; minutes since local midnight in the resource's time zone, so 540 is 09:00; windows on one day may touch but not overlap; at most 70; `[]` closes the resource (400 for a bad or overlapping window; 404 if the resource is not found) |
| `POST /api/orgs/:orgId/sample-data` | owner | For the demo: create one resource ("Consultation room") in `{ timeZone }`, one 30-minute service and Monday to Friday 09:00 to 17:00 hours, all or nothing (201 with `{ resource, service, windows }`; 400 for a bad time zone or an unknown field; 409 if the organization already has any resource or service) |
| `GET /api/orgs/:orgId/resources/:resourceId/availability?serviceId=&from=&to=` | members | `{ timeZone, slots: [{ startsAt, endsAt }] }` in UTC: start times every 15 minutes inside the working hours where the service fits and no confirmed booking overlaps; `from` and `to` are local dates (`YYYY-MM-DD`) in the resource's time zone, both included, at most 14 days; past start times are left out. A hint, not a promise: a slot can be taken by the time it is booked (400 for a bad query; 404 if the resource or service is not found) |
| `POST /api/orgs/:orgId/bookings` | members | Book `{ resourceId, serviceId, startsAt, customerName, customerEmail }` for a guest customer (201 with the booking). `startsAt` is an instant with an offset or `Z`, for example `2099-01-05T09:00:00+05:30`; it is accepted only if the availability route would offer exactly that start, and the server sets the end from the service's duration. 400 for a bad body or a start that is not offered; 404 if the resource or service is not found; 409 if a confirmed booking overlaps |
| `GET /api/orgs/:orgId/bookings?resourceId=&from=&to=` | members | The resource's bookings that start on the local dates `from` to `to` (`YYYY-MM-DD` in the resource's time zone, both included, at most 14 days), confirmed and cancelled, each with its `status`, oldest first (400 for a bad query; 404 if the resource is not found) |
| `GET /api/orgs/:orgId/bookings/:bookingId` | members | View one booking (404 if not found) |
| `POST /api/orgs/:orgId/bookings/:bookingId/cancel` | members | Cancel a booking (200 with the booking, `status` now `cancelled`). Cancelling it again returns the same 200. The slot is free again; there is no un-cancel (404 if not found) |

A person who is not a member of an organization gets 404, the same answer as for an organization that does not exist. Requests that change data under `/api/orgs` must send an `Origin` header that matches `BETTER_AUTH_URL`. Each client address may make 100 requests that change data and 600 requests of any kind to `/api/orgs` in 15 minutes; beyond that the answer is 429 with a `Retry-After` header. `WRITE_RATE_LIMIT` and `REQUEST_RATE_LIMIT` change the two numbers.

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

**4. Install the dependencies.** The server and the client are separate npm packages.

```powershell
cd client
npm ci
cd ..\server
npm ci
```

`npm ci` may report vulnerabilities in development and test tools. CI fails on any finding in the production dependencies and on any high or critical finding anywhere, unless the advisory is listed with a reason and an expiry date in `server/audit-exceptions.json` (checked by `server/scripts/audit-check.ts`). Do not run `npm audit fix`, which would change the locked versions.

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

You should see `{"status":"ok"}`. (In PowerShell, use `curl.exe`, not `curl`, which is a different command.)

**8. Start the client.** In another terminal, from the project folder:

```powershell
cd client
npm run dev
```

Open `http://localhost:5173`. Vite passes every `/api` request on to the server, so the browser sees one address. That is why `BETTER_AUTH_URL` in `server\.env` is `http://localhost:5173`: requests that change data must come from that origin. A `curl.exe` call straight to port 3000 that changes data needs `-H "Origin: http://localhost:5173"`. Stop each with Ctrl+C.

To try the built app the way Render runs it: `npm run build` in `client`, `npm run build` in `server`, set `BETTER_AUTH_URL=http://localhost:3000` in `server\.env`, then `npm start` in `server` and open `http://localhost:3000`. Use `localhost`, not your network address: the security headers ask browsers to load files over https, which fails on a plain http network address.

### Run the checks

From the `client` folder:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

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
- `npm run test:db` runs the database tests against `slotdesk_test`. It deletes and re-creates the tables in that database on every run and refuses to run against any database whose name does not end in `_test`. The booking race tests (30 database connections, and 10 simultaneous HTTP requests) are part of it. Some tests kill database connections on purpose, so error lines in its output (for example `Idle database client error`) are expected; what matters is the final summary.

### If something fails

| What you see | Likely cause | Fix |
|---|---|---|
| `ECONNREFUSED` when running migrations, the server or tests | The database is not running, or the port in a URL does not match the port Docker publishes | Run `docker compose ps`. See "If port 5432 is already in use" below |
| `password authentication failed for user "slotdesk"` | An old Docker data volume kept an earlier password. PostgreSQL reads the password only when it first creates the volume | Reset the local database: `docker compose down -v`, then `docker compose up -d` (this deletes the local data) |
| The server exits at start, mentioning `BETTER_AUTH_SECRET` | The secret is missing or shorter than 32 characters | Repeat step 5 |
| `npm warn EBADENGINE` from `npm ci`, or odd errors from the tools | Node is not version 24 | Install Node 24 and run `npm ci` again |
| 403 when the client changes data | `BETTER_AUTH_URL` does not match the address in the browser | Use `http://localhost:5173` with `npm run dev`, or `http://localhost:3000` with the built app, and restart the server |

### If port 5432 is already in use

Another PostgreSQL on your machine may already use 5432. Pick another port, for example 5433, and change exactly these three lines so they agree:

- `POSTGRES_PORT=5433` in `.env`
- `DATABASE_URL=postgresql://slotdesk:changeme@localhost:5433/slotdesk` in `server\.env`
- `TEST_DATABASE_URL=postgresql://slotdesk:changeme@localhost:5433/slotdesk_test` in `server\.env`

Then run `docker compose down -v` and `docker compose up -d` again.

## Project layout

```
client/
  src/
    main.tsx, routes.tsx   start-up and the list of pages (React Router)
    api.ts                 calls to our API, with a clear message for each error
    pages/                 one file per page
  test/                    Testing Library tests
server/
  src/
    app.ts, server.ts      the Express app, and the file that starts it
    auth.ts                Better Auth settings
    password.ts            password hashing (scrypt)
    availability.ts        time zone checks, local time to UTC, free slots
    config.ts              environment settings checked with Zod
    db.ts                  the PostgreSQL connection pool
    middleware/            origin, session, membership and role checks; errors
    routes/                health, organizations, members, resources, services, working hours, availability, bookings
    data/                  the SQL (one file per kind of data)
  migrations/              SQL migration files
  scripts/audit-check.ts   the CI dependency audit, with exceptions in audit-exceptions.json
  test/                    unit tests; test/db holds the database tests
docker-compose.yml         local PostgreSQL 17
.github/workflows/ci.yml   CI: checks, tests and a dependency audit
```

## More

- [DESIGN.md](DESIGN.md): the design decisions, and the reasons for them.
- [LICENSE](LICENSE): MIT.
