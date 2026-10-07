// Marks 'pending' footage older than 24h as 'failed' and deletes their R2 objects.
// 'failed' rows whose objects are not yet deleted (r2_deleted_at is null) are retried.
// Run with: npm run cleanup:footage
import 'dotenv/config';
import db from '../db/index.js';
import { deleteObject, abortMultipartUpload } from '../lib/r2.js';

try {
  // Flipping the status first means a late /complete call can no longer succeed for these rows
  const { rows } = await db.query(
    `update public.incident_videos
     set status = 'failed', updated_at = case when status = 'pending' then now() else updated_at end
     where (status = 'pending' and created_at < now() - interval '24 hours')
        or (status = 'failed' and r2_deleted_at is null)
     returning id, r2_key, upload_id`,
  );

  let failedDeletes = 0;
  for (const row of rows) {
    try {
      // Unfinished multipart uploads keep their stored parts (and cost) until aborted
      if (row.upload_id) await abortMultipartUpload(row.r2_key, row.upload_id);
      await deleteObject(row.r2_key);
      await db.query(`update public.incident_videos set r2_deleted_at = now() where id = $1`, [row.id]);
    } catch (err) {
      failedDeletes += 1;
      console.error(`Could not delete object for footage ${row.id}:`, err.message);
    }
  }

  console.log(`Cleaned up ${rows.length - failedDeletes} of ${rows.length} upload(s), ${failedDeletes} object delete(s) failed`);
  process.exitCode = failedDeletes ? 1 : 0;
} catch (err) {
  console.error('Cleanup failed:', err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
