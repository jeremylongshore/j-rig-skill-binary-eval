import { createDatabase, type JRigDatabase } from "@j-rig/db";

const DEFAULT_DB_PATH = "j-rig.db";

/**
 * Opens (or creates) the j-rig SQLite database at the given path.
 * Falls back to `j-rig.db` in the current working directory when no
 * path is supplied.
 */
export function openDb(path?: string): JRigDatabase {
  return createDatabase(path ?? DEFAULT_DB_PATH);
}
