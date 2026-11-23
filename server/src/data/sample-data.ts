import { withTransaction } from '../db.js';
import type { Resource } from './resources.js';
import type { Service } from './services.js';
import { SELECT_WORKING_HOURS, type WorkingWindow } from './working-hours.js';

// Monday to Friday, 09:00 to 17:00 in the resource's time zone.
const SAMPLE_WINDOWS: WorkingWindow[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1020,
}));

export type SampleDataResult =
  | {
      status: 'created';
      resource: Resource;
      service: Service;
      windows: WorkingWindow[];
    }
  | { status: 'notEmpty' };

// One demo resource, service and week, all or nothing, and only for an
// organization with no resources and no services yet.
export async function createSampleData(
  orgId: string,
  timeZone: string,
): Promise<SampleDataResult> {
  return withTransaction(async (client) => {
    // The lock makes a second request at the same moment wait here until
    // this one commits; its check below then sees our rows.
    await client.query(
      'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
      [orgId],
    );
    const existing = await client.query(
      `SELECT 1 FROM resources WHERE org_id = $1
       UNION ALL
       SELECT 1 FROM services WHERE org_id = $1
       LIMIT 1`,
      [orgId],
    );
    if (existing.rowCount !== 0) {
      return { status: 'notEmpty' };
    }

    // The existing create functions each use the pool, not this
    // transaction, so the inserts are written out here.
    const resource = await client.query<Resource>(
      `INSERT INTO resources (org_id, name, time_zone) VALUES ($1, $2, $3)
       RETURNING id, name, time_zone AS "timeZone"`,
      [orgId, 'Consultation room', timeZone],
    );
    const resourceId = resource.rows[0]!.id;
    const service = await client.query<Service>(
      `INSERT INTO services (org_id, name, duration_minutes) VALUES ($1, $2, $3)
       RETURNING id, name, duration_minutes AS "durationMinutes"`,
      [orgId, 'Consultation', 30],
    );
    for (const window of SAMPLE_WINDOWS) {
      await client.query(
        `INSERT INTO working_hours (org_id, resource_id, weekday, start_minute, end_minute)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          orgId,
          resourceId,
          window.weekday,
          window.startMinute,
          window.endMinute,
        ],
      );
    }
    const windows = await client.query<WorkingWindow>(SELECT_WORKING_HOURS, [
      orgId,
      resourceId,
    ]);
    return {
      status: 'created',
      resource: resource.rows[0]!,
      service: service.rows[0]!,
      windows: windows.rows,
    };
  });
}
