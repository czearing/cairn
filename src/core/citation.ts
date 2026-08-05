import { existsSync } from "node:fs";

/** One reference pulled out of a free-text citation, classified by what can be checked about it. */
export interface CitationReference {
  /** The reference exactly as the caller wrote it. */
  raw: string;
  /** local: a path this machine can open. node: a brain id. remote: a URL. prose: everything else. */
  kind: "local" | "node" | "remote" | "prose";
  /** For a local reference, the filesystem path with any trailing line span removed. */
  path?: string;
}

const FILE_URL = "file:///";
const HEX = "0123456789abcdef";

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

/** Split on runs of spaces and tabs. Hand-written: this file must contain no patterns. */
function tokens(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of value) {
    if (ch === " " || ch === "\t") {
      if (current) out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** A brain id is a canonical 36-character UUID. Checked character by character so a malformed id is
 *  rejected for the right reason rather than quietly treated as prose. */
export function looksLikeNodeId(value: string): boolean {
  if (value.length !== 36) return false;
  for (let at = 0; at < 36; at++) {
    const ch = value[at]!.toLowerCase();
    const dash = at === 8 || at === 13 || at === 18 || at === 23;
    if (dash ? ch !== "-" : !HEX.includes(ch)) return false;
  }
  return true;
}

/** Citations routinely pin a location: "…/neurons.ts:186-224" or "…/config.ts:52". Strip only a tail
 *  that is entirely digits, dashes and commas, so a Windows drive letter ("C:/Code") is never cut. */
export function stripLineSpan(value: string): string {
  const colon = value.lastIndexOf(":");
  if (colon <= 0 || colon === value.length - 1) return value;
  const tail = value.slice(colon + 1);
  for (const ch of tail) {
    if (!isDigit(ch) && ch !== "-" && ch !== ",") return value;
  }
  return value.slice(0, colon);
}

function localPath(token: string): string | null {
  if (token.startsWith(FILE_URL)) {
    const rest = stripLineSpan(token.slice(FILE_URL.length));
    // A POSIX file URL keeps its leading slash; a Windows one starts at the drive letter.
    const drive = rest.length > 1 && rest[1] === ":";
    return decodeURIComponent(drive ? rest : `/${rest}`);
  }
  if (token.length > 2 && token[1] === ":" && (token[2] === "/" || token[2] === "\\")) {
    return stripLineSpan(token);
  }
  return null;
}

/** Split a citation into the individual references it names. Callers separate them with semicolons or
 *  newlines; whitespace alone is not a separator because prose references contain spaces. */
export function citationReferences(citation: string): CitationReference[] {
  const references: CitationReference[] = [];
  for (const line of citation.split("\n")) {
    for (const part of line.split(";")) {
      const raw = part.trim();
      if (!raw) continue;
      // A reference may sit inside a sentence, so test the whitespace-delimited tokens too.
      const parts = tokens(raw);
      const url = parts.find((token) =>
        token.startsWith("http://") || token.startsWith("https://"));
      const file = parts.map(localPath).find((path): path is string => path != null);
      const node = parts.find(looksLikeNodeId);
      if (file) references.push({ raw, kind: "local", path: file });
      else if (node) references.push({ raw, kind: "node" });
      else if (url) references.push({ raw, kind: "remote" });
      else references.push({ raw, kind: "prose" });
    }
  }
  return references;
}

/** Every reference a citation names that this machine can check, and that does not resolve.
 *
 *  A citation is only evidence if the thing it points at exists. A fabricated path or id keeps a
 *  perfectly valid shape and passes any presence check while pointing at nothing, which is the exact
 *  failure this gate exists to stop. Remote URLs cannot be resolved without a network call, so they
 *  are reported as unverifiable rather than silently treated as proven. */
export function unresolvedReferences(
  citation: string,
  nodeExists: (id: string) => boolean,
): string[] {
  const missing: string[] = [];
  for (const reference of citationReferences(citation)) {
    if (reference.kind === "local" && reference.path && !existsSync(reference.path)) {
      missing.push(reference.raw);
    }
    if (reference.kind === "node") {
      const id = tokens(reference.raw).find(looksLikeNodeId)!;
      if (!nodeExists(id)) missing.push(reference.raw);
    }
  }
  return missing;
}
