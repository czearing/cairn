import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { platform } from "node:os";

let configured = false;

export function configureSqliteLibrary(): void {
  if (configured || platform() !== "darwin") return;
  const candidates = [
    process.env.CAIRN_SQLITE_LIBRARY,
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ];
  const library = candidates.find((path) => path && existsSync(path));
  if (!library) {
    throw new Error(
      "Cairn requires an extension-enabled SQLite library on macOS. Run `brew install sqlite` " +
        "or set CAIRN_SQLITE_LIBRARY to libsqlite3.dylib."
    );
  }
  // setCustomSQLite throws if Bun already auto-loaded SQLite (e.g. a subprocess that opened a
  // Database before this ran). That is unrecoverable but not fatal: the process is already bound
  // to some SQLite, so fail soft and let loadExtension surface a real problem if one exists.
  try {
    Database.setCustomSQLite(library);
  } catch (err) {
    if (!/already loaded/i.test(String((err as Error)?.message))) throw err;
  }
  configured = true;
}
