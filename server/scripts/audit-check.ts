// Runs `npm audit` and applies the D-027 rules, skipping advisories listed in
// audit-exceptions.json. The audit CI job has no install step, so this file
// uses only Node's built-in modules and runs with `node` directly (Node 24
// strips the types).
//
//   node scripts/audit-check.ts production   any finding in production dependencies fails
//   node scripts/audit-check.ts all          any high or critical finding fails
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Mode = 'production' | 'all';

export type AuditException = {
  id: string;
  package: string;
  reason: string;
  expires: string; // YYYY-MM-DD, the last day the exception holds
};

type Advisory = { id: string; package: string; severity: string };

// Returns the reasons the audit fails. An empty list means it passes.
export function checkAudit(
  report: unknown,
  exceptions: AuditException[],
  mode: Mode,
  today: string,
): string[] {
  const advisories = readAdvisories(report);
  if (advisories === null) {
    // npm prints an error object instead of a report when the audit itself
    // fails (for example no network). That must never count as a pass.
    return ['npm audit did not return a report: ' + JSON.stringify(report)];
  }

  const problems: string[] = [];
  const listed = new Set(exceptions.map((exception) => exception.id));
  const blocking = mode === 'production' ? null : new Set(['high', 'critical']);

  for (const advisory of advisories) {
    if (blocking !== null && !blocking.has(advisory.severity)) continue;
    if (listed.has(advisory.id)) continue;
    problems.push(
      `New advisory ${advisory.id} (${advisory.severity}) in ${advisory.package}`,
    );
  }

  for (const exception of exceptions) {
    if (exception.expires < today) {
      problems.push(
        `Exception ${exception.id} expired on ${exception.expires}: review it`,
      );
    }
    // Only the full audit sees every advisory, so only it can tell that an
    // exception is no longer needed.
    if (mode === 'all' && !advisories.some((a) => a.id === exception.id)) {
      problems.push(
        `Exception ${exception.id} no longer matches any finding: remove it`,
      );
    }
  }
  return problems;
}

// Collects one entry per advisory from npm's report (format version 2).
// Packages that are only affected through a dependency list that dependency's
// name instead of an advisory, so they are skipped here.
function readAdvisories(report: unknown): Advisory[] | null {
  if (typeof report !== 'object' || report === null) return null;
  const { auditReportVersion, vulnerabilities } = report as {
    auditReportVersion?: unknown;
    vulnerabilities?: unknown;
  };
  if (auditReportVersion !== 2) return null;
  if (typeof vulnerabilities !== 'object' || vulnerabilities === null) {
    return null;
  }

  const found = new Map<string, Advisory>();
  for (const entry of Object.values(vulnerabilities)) {
    const via: unknown[] = Array.isArray(entry?.via) ? entry.via : [];
    for (const source of via) {
      if (typeof source !== 'object' || source === null) continue;
      const { url, name, severity } = source as Record<string, unknown>;
      if (typeof url !== 'string') continue;
      const id = url.slice(url.lastIndexOf('/') + 1);
      found.set(id, {
        id,
        package: String(name),
        severity: String(severity),
      });
    }
  }
  return [...found.values()];
}

function main(): void {
  const mode = process.argv[2];
  if (mode !== 'production' && mode !== 'all') {
    console.error('Usage: node scripts/audit-check.ts production|all');
    process.exit(2);
  }

  const exceptions = JSON.parse(
    readFileSync(new URL('../audit-exceptions.json', import.meta.url), 'utf8'),
  ) as AuditException[];

  // shell: true so `npm` also resolves to npm.cmd on Windows. The command is
  // fixed text, never user input.
  const command =
    mode === 'production' ? 'npm audit --omit=dev --json' : 'npm audit --json';
  const result = spawnSync(command, {
    cwd: new URL('..', import.meta.url), // server/, wherever it is run from
    shell: true,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = result.stdout;
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const exception of exceptions) {
    console.log(
      `Accepted until ${exception.expires}: ${exception.id} in ${exception.package}`,
    );
  }
  const problems = checkAudit(report, exceptions, mode, today);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`Audit (${mode}) passed: no advisory outside the exceptions.`);
}

if (import.meta.main) main();
