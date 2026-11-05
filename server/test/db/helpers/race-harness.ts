// Race-test harness: opens independent pg.Client connections and fires
// concurrent transactions in a single synchronous tick.
//
// Why independent Clients, not a Pool: each connection must hold its own
// transaction independently. A pool would let pg reuse connections across
// concurrent callers, breaking the isolation needed for the race.

import pg from 'pg';

// Open N independent Client connections to the given URL and return them.
// Every client is already connected when this resolves.
export async function openClients(
  url: string,
  n: number,
): Promise<pg.Client[]> {
  const clients = Array.from(
    { length: n },
    () => new pg.Client({ connectionString: url }),
  );
  await Promise.all(clients.map((c) => c.connect()));
  return clients;
}

// End all clients. Errors are swallowed so a failed client does not prevent
// the rest from closing -- always call this in a finally block.
export async function endClients(clients: pg.Client[]): Promise<void> {
  await Promise.all(
    clients.map((c) =>
      c.end().catch(() => {
        // Intentionally ignore: client may already be closed after an error.
      }),
    ),
  );
}

// The result of one attempt.
// result: 'committed' if the transaction committed; 'rejected-by-check' if the
// attempt function decided not to insert; or the Postgres error code (e.g.
// '23P01', '40P01') if the database rejected the statement.
// constraint: the value of err.constraint from the DatabaseError, or null when
// there was no database error or the error carried no constraint name.
export type AttemptOutcome = {
  result: 'committed' | 'rejected-by-check' | (string & {});
  constraint: string | null;
};

// The return value of fireTogether for one round.
// outcomes: one AttemptOutcome per client.
// spreadMs: the gap in milliseconds between the earliest and latest attempt
// start times in this round. A large spread means attempts did not fire
// simultaneously -- the race harness may not be working.
export type RoundResult = {
  outcomes: AttemptOutcome[];
  spreadMs: number;
};

// Run one round of concurrent transactions.
//
// Steps:
//   1. Send BEGIN on every client and wait for all to acknowledge. This
//      places all transactions at the same starting point before any
//      attempt-specific statement is sent.
//   2. Record a start timestamp (performance.now()) for each attempt and
//      start every attempt function in the same synchronous .map() call so
//      their first statements hit the wire in the same event-loop tick.
//      This maximises the chance the database sees them as truly concurrent.
//   3. Each attempt function must COMMIT on success (immediately, without
//      waiting for other clients -- losers are blocked until the winner
//      commits, so the winner must not stall). On failure it must ROLLBACK.
//   4. Collect results and compute spreadMs (latest start - earliest start).
export async function fireTogether(
  clients: pg.Client[],
  attempt: (client: pg.Client) => Promise<AttemptOutcome>,
): Promise<RoundResult> {
  // Step 1: BEGIN on all clients, wait for all acknowledgements.
  await Promise.all(clients.map((c) => c.query('BEGIN')));

  // Step 2: record start times and fire all attempts in one synchronous
  // .map() so every first statement is queued to its socket before the
  // event loop yields.
  const startTimes: number[] = [];
  const promises = clients.map((c) => {
    startTimes.push(performance.now());
    return attempt(c);
  });

  const outcomes = await Promise.all(promises);

  const earliest = Math.min(...startTimes);
  const latest = Math.max(...startTimes);
  const spreadMs = latest - earliest;

  return { outcomes, spreadMs };
}
