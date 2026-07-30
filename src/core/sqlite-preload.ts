// Selects an extension-enabled SQLite before anything can auto-load Apple's system build.
// Registered as a top-level bunfig preload so it also covers `bun -e` subprocesses spawned by
// tests, which open a Database before importing Cairn.
import { configureSqliteLibrary } from "./sqlite";

configureSqliteLibrary();
