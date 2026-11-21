// Race-test harness: opens independent pg.Client connections and fires
// concurrent transactions in a single synchronous tick.
//
// Independent Clients, not a Pool: each connection must hold its own
// transaction, and a pool could reuse connections between callers.

import pg from 'pg';

// Opens n connected clients.
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

// Ends every client. Errors are swallowed so one failed client does not stop
// the rest from closing.
export async function endClients(clients: pg.Client[]): Promise<void> {
  await Promise.all(
    clients.map((c) =>
      c.end().catch(() => {
        // The client may already be closed after an error.
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

// Runs one round of concurrent transactions. Every client sends BEGIN first,
// then all attempts start in one synchronous .map() so their first
// statements go out in the same tick. Each attempt must COMMIT at once on
// success (the losers are blocked until it does) and ROLLBACK on failure.
// spreadMs is the gap between the first and last attempt start.
export async function fireTogether(
  clients: pg.Client[],
  attempt: (client: pg.Client) => Promise<AttemptOutcome>,
): Promise<RoundResult> {
  await Promise.all(clients.map((c) => c.query('BEGIN')));

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
