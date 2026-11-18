import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkAudit, type AuditException } from '../scripts/audit-check.js';

const PICOMATCH = 'GHSA-fc5q-39xc-vjpf';

const exceptions: AuditException[] = [
  {
    id: PICOMATCH,
    package: 'picomatch',
    reason: 'test',
    expires: '2026-12-01',
  },
];

// The shape npm audit --json prints (report format 2), cut down to what the
// check reads. `vite` is only affected through picomatch, so its `via` is a
// package name, not an advisory.
function report(
  ...advisories: { id: string; name: string; severity: string }[]
): object {
  const vulnerabilities: Record<string, object> = {
    vite: { name: 'vite', severity: 'high', via: ['picomatch'] },
  };
  for (const advisory of advisories) {
    vulnerabilities[advisory.name] = {
      name: advisory.name,
      severity: advisory.severity,
      via: [
        {
          name: advisory.name,
          severity: advisory.severity,
          url: `https://github.com/advisories/${advisory.id}`,
        },
      ],
    };
  }
  return { auditReportVersion: 2, vulnerabilities };
}

const picomatch = { id: PICOMATCH, name: 'picomatch', severity: 'high' };
const newModerate = { id: 'GHSA-new1', name: 'left-pad', severity: 'moderate' };
const newHigh = { id: 'GHSA-new2', name: 'left-pad', severity: 'high' };

describe('Audit exceptions check', () => {
  it('passes when the only findings are listed exceptions', () => {
    for (const mode of ['production', 'all'] as const) {
      expect(
        checkAudit(report(picomatch), exceptions, mode, '2026-11-18'),
      ).toEqual([]);
    }
  });

  it('fails production on a new advisory of any severity', () => {
    expect(
      checkAudit(
        report(picomatch, newModerate),
        exceptions,
        'production',
        '2026-11-18',
      ),
    ).toEqual(['New advisory GHSA-new1 (moderate) in left-pad']);
  });

  it('fails all on a new high advisory but not on a new moderate one', () => {
    expect(
      checkAudit(
        report(picomatch, newModerate),
        exceptions,
        'all',
        '2026-11-18',
      ),
    ).toEqual([]);
    expect(
      checkAudit(report(picomatch, newHigh), exceptions, 'all', '2026-11-18'),
    ).toEqual(['New advisory GHSA-new2 (high) in left-pad']);
  });

  it('holds an exception through its expiry date and fails the day after', () => {
    expect(
      checkAudit(report(picomatch), exceptions, 'all', '2026-12-01'),
    ).toEqual([]);
    expect(
      checkAudit(report(picomatch), exceptions, 'all', '2026-12-02'),
    ).toEqual([`Exception ${PICOMATCH} expired on 2026-12-01: review it`]);
  });

  it('fails all when a listed advisory is no longer found', () => {
    expect(checkAudit(report(), exceptions, 'all', '2026-11-18')).toEqual([
      `Exception ${PICOMATCH} no longer matches any finding: remove it`,
    ]);
    // The production audit sees only part of the tree, so it does not judge this.
    expect(
      checkAudit(report(), exceptions, 'production', '2026-11-18'),
    ).toEqual([]);
  });

  it('fails when npm returns an error instead of a report', () => {
    const npmError = { error: { code: 'ENOTFOUND', summary: 'no network' } };
    for (const mode of ['production', 'all'] as const) {
      expect(checkAudit(npmError, exceptions, mode, '2026-11-18')).toHaveLength(
        1,
      );
    }
  });

  it('keeps the committed exceptions file well formed', () => {
    const committed = JSON.parse(
      readFileSync(
        new URL('../audit-exceptions.json', import.meta.url),
        'utf8',
      ),
    ) as AuditException[];
    for (const exception of committed) {
      expect(exception.id).toMatch(
        /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/,
      );
      expect(exception.package).not.toBe('');
      expect(exception.reason).not.toBe('');
      expect(exception.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
