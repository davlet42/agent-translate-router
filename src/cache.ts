import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256 } from "./segments.js";

interface DocMeta { sourcePath: string; sourceSha256: string; projectSlug: string; }
interface Sidecar { version?: number; sections?: Record<string, string>; }

function gitRoot(directory: string): string | null {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

export function projectRoot(cwd: string, hint?: string): string {
  return gitRoot(cwd) || (hint ? gitRoot(dirname(resolve(hint))) : null) || cwd;
}

export function projectSlug(cwd: string, override?: string, hint?: string): string {
  if (override?.trim()) return override.trim();
  const root = projectRoot(cwd, hint);
  return basename(root);
}

function cacheRelative(sourcePath: string, root: string): string {
  const rel = relative(root, resolve(sourcePath));
  const extension = extname(rel);
  return join(rel.slice(0, rel.length - extension.length) + ".en" + extension);
}

export function cachePath(home: string, slug: string, sourcePath: string, root: string): string {
  return join(resolve(home), "cache", slug, cacheRelative(sourcePath, root));
}

function sidecarPath(path: string): string { return path.replace(/\.en\.[^./]+$/u, ".en.sections.json"); }

function parseDoc(raw: string): { meta: DocMeta; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;
  const value = (key: string) => match[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const sourcePath = value("cursor-translate-source") || value("claude-translate-source");
  const sourceSha256 = value("cursor-translate-source-sha256") || value("claude-translate-source-sha256");
  const project = value("cursor-translate-project") || value("claude-translate-project");
  if (!sourcePath || !sourceSha256 || !project) return null;
  return { meta: { sourcePath, sourceSha256, projectSlug: project }, body: match[2] };
}

async function readSections(path: string): Promise<Map<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(sidecarPath(path), "utf8")) as Sidecar;
    return parsed.sections && typeof parsed.sections === "object" ? new Map(Object.entries(parsed.sections)) : new Map();
  } catch { return new Map(); }
}

async function findCompatibleCacheInHome(home: string, sourcePath: string, sourceSha256: string): Promise<{ path: string; body: string; sections: Map<string, string> } | undefined> {
  const root = join(resolve(home), "cache");
  async function walk(directory: string): Promise<{ path: string; body: string; sections: Map<string, string> } | undefined> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return undefined; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(path);
        if (found) return found;
      } else if (entry.name.endsWith(".en.md")) {
        try {
          const parsed = parseDoc(await readFile(path, "utf8"));
          if (parsed?.meta.sourcePath === sourcePath && parsed.meta.sourceSha256 === sourceSha256 && parsed.body.trim()) {
            return { path, body: parsed.body.trimEnd(), sections: await readSections(path) };
          }
        } catch { /* keep looking */ }
      }
    }
    return undefined;
  }
  return walk(root);
}

export interface CacheLookup { fullText?: string; sections: Map<string, string>; path?: string; source: "own" | "sibling"; }

export async function findCache(options: { homes: string[]; ownHome: string; readSiblings: boolean; slug: string; sourcePath: string; root: string; sourceSha256: string; }): Promise<CacheLookup> {
  const homes = [options.ownHome, ...(options.readSiblings ? options.homes : [])].filter((value, index, list) => list.indexOf(value) === index);
  const wantedPath = cacheRelative(options.sourcePath, options.root);
  const mergedSections = new Map<string, string>();
  let firstSectionPath: string | undefined;
  let firstSectionSource: "own" | "sibling" = "own";
  for (const home of homes) {
    const path = join(resolve(home), "cache", options.slug, wantedPath);
    try {
      const parsed = parseDoc(await readFile(path, "utf8"));
      if (parsed?.meta.sourceSha256 === options.sourceSha256 && parsed.body.trim()) {
        return { fullText: parsed.body.trimEnd(), sections: await readSections(path), path, source: home === options.ownHome ? "own" : "sibling" };
      }
      const sections = await readSections(path);
      if (sections.size) {
        if (!firstSectionPath) {
          firstSectionPath = path;
          firstSectionSource = home === options.ownHome ? "own" : "sibling";
        }
        for (const [key, value] of sections) mergedSections.set(key, value);
      }
    } catch { /* try next cache */ }
  }
  // Different hosts can supply different workspace roots/slugs for the same
  // absolute document. Fall back to the metadata identity so that an existing
  // translation remains shared across those hosts instead of being re-run.
  for (const home of homes) {
    const found = await findCompatibleCacheInHome(home, options.sourcePath, options.sourceSha256);
    if (found) return { fullText: found.body, sections: found.sections, path: found.path, source: home === options.ownHome ? "own" : "sibling" };
  }
  return { sections: mergedSections, path: firstSectionPath, source: firstSectionSource };
}

export async function writeCache(options: { home: string; slug: string; sourcePath: string; root: string; sourceSha256: string; body: string; sections: Map<string, string>; }): Promise<string> {
  const path = cachePath(options.home, options.slug, options.sourcePath, options.root);
  await mkdir(dirname(path), { recursive: true });
  const meta = `---\ncursor-translate-version: 2\ncursor-translate-source: ${options.sourcePath}\ncursor-translate-source-sha256: ${options.sourceSha256}\ncursor-translate-generated-at: ${new Date().toISOString()}\ncursor-translate-project: ${options.slug}\n---\n\n`;
  await writeFile(path, meta + options.body.trimStart().trimEnd() + "\n", "utf8");
  await writeFile(sidecarPath(path), JSON.stringify({ version: 2, sections: Object.fromEntries(options.sections) }, null, 2) + "\n", "utf8");
  return path;
}

export async function copySiblingFullCache(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  try { await copyFile(sidecarPath(sourcePath), sidecarPath(targetPath)); } catch { /* sidecar optional */ }
}

export async function cacheStats(home: string): Promise<{ files: number; bytes: number }> {
  let files = 0; let bytes = 0;
  async function walk(path: string): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".md")) { files++; bytes += (await stat(child)).size; }
    }
  }
  await walk(join(home, "cache"));
  return { files, bytes };
}

export async function cacheExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
