#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

export async function cleanPendingStorage({ db, storage, onError = null }) {
  const pending = await db.query(
    `SELECT project_id, storage_key
       FROM admin_storage_cleanup
      WHERE cleaned_at IS NULL
      ORDER BY created_at, storage_key`);
  let cleaned = 0;
  let failed = 0;
  for (const item of pending.rows) {
    try {
      await storage.delete(item.storage_key);
      await db.query(
        `UPDATE admin_storage_cleanup
            SET cleaned_at = COALESCE(cleaned_at, now())
          WHERE project_id = $1 AND storage_key = $2`,
        [item.project_id, item.storage_key]);
      cleaned += 1;
    } catch (error) {
      failed += 1;
      if (onError) onError(error, item);
    }
  }
  return { cleaned, failed };
}

async function main() {
  const config = loadConfig(process.env);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const db = await createDb({ url: config.databaseUrl });
  try {
    const result = await cleanPendingStorage({
      db,
      storage: config.storage,
      onError: (error, item) => {
        console.error(`storage cleanup failed for ${item.storage_key}: ${error.message}`);
      }
    });
    console.log(`storage cleanup: ${result.cleaned} cleaned, ${result.failed} failed`);
    if (result.failed) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
