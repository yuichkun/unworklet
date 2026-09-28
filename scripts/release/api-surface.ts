/**
 * Compares the public API two sets of release tarballs declare: every export of
 * every package entry, as its declaration reads in the published `.d.mts`.
 *
 * Removing an export breaks every caller of it, so it is only allowed in a
 * release that bumps the minor (the breaking-change axis before 1.0). A changed
 * declaration may widen or narrow what callers can do, which only a reader can
 * tell, so it is reported for review rather than refused.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";

import type { Tarball } from "./tarballs.ts";
import { readStatus, type ChangesetStatus } from "./version.ts";

export type ApiSurface = Record<string, string>;
export type ApiDiff = { removed: string[]; changed: string[]; added: string[] };

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function declarationText(node: ts.Declaration): string {
  return normalize((ts.isVariableDeclaration(node) ? node.parent.parent : node).getText());
}

export function readApiSurface(packageDir: string): ApiSurface {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
    name: string;
    exports?: Record<string, unknown>;
  };
  const entries = Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) => {
    const types =
      typeof target === "object" && target !== null
        ? (target as { types?: string }).types
        : undefined;
    return types ? [{ subpath, file: path.join(packageDir, types) }] : [];
  });

  const program = ts.createProgram(
    entries.map((e) => e.file),
    {
      noEmit: true,
      skipLibCheck: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
    },
  );
  const checker = program.getTypeChecker();

  const surface: ApiSurface = {};
  for (const { subpath, file } of entries) {
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(file)!);
    if (!moduleSymbol) continue;
    const prefix = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      surface[`${prefix}#${symbol.name}`] = (target.declarations ?? [])
        .map(declarationText)
        .join("\n");
    }
  }
  return surface;
}

export function compareApiSurfaces(before: ApiSurface, after: ApiSurface): ApiDiff {
  const keys = (s: ApiSurface) => Object.keys(s).sort();
  return {
    removed: keys(before).filter((k) => !(k in after)),
    changed: keys(before).filter((k) => k in after && before[k] !== after[k]),
    added: keys(after).filter((k) => !(k in before)),
  };
}

/** `allowBreaking` is only asked when an export was removed. */
export function apiVerdict(
  diff: ApiDiff,
  options: { allowBreaking: () => boolean },
): { ok: true } | { ok: false; message: string } {
  if (diff.removed.length === 0 || options.allowBreaking()) return { ok: true };
  return {
    ok: false,
    message:
      `Removing a public export breaks code that uses it (${diff.removed.join(", ")}). ` +
      "Release it with a minor changeset.",
  };
}

function formatApiReport(diff: ApiDiff, labels: { before: string; after: string }): string {
  const section = (title: string, keys: string[]) =>
    keys.length === 0 ? [] : [`**${title}**`, "", ...keys.map((k) => `- \`${k}\``), ""];
  const total = diff.removed.length + diff.changed.length + diff.added.length;
  return [
    `## Public API: ${labels.before} → ${labels.after}`,
    "",
    ...(total === 0 ? ["No export was added, removed or changed.", ""] : []),
    ...section("Removed — breaks code that uses it", diff.removed),
    ...section("Changed — breaking if it narrows what callers can pass or rely on", diff.changed),
    ...section("Added", diff.added),
  ].join("\n");
}

function surfaceOf(dir: string): ApiSurface {
  const tarballs = JSON.parse(readFileSync(path.join(dir, "tarballs.json"), "utf8")) as Tarball[];
  const surface: ApiSurface = {};
  for (const t of tarballs) {
    const out = mkdtempSync(path.join(tmpdir(), "uwk-api-"));
    mkdirSync(out, { recursive: true });
    execFileSync("tar", ["-xzf", path.join(dir, t.file), "-C", out]);
    Object.assign(surface, readApiSurface(path.join(out, "package")));
  }
  return surface;
}

const minorOf = (version: string) => version.split(".").slice(0, 2).join(".");

/**
 * `api-surface.ts <before tarball dir> <after tarball dir> <before label> <after label> [--since <base>]`:
 * reports the API difference and fails on a removed export the release may not
 * contain. With `--since`, the pull request's changesets decide whether it may
 * break; without it, the two versions do.
 */
function main(): void {
  const [beforeDir, afterDir, beforeLabel, afterLabel, flag, base] = process.argv.slice(2);
  const diff = compareApiSurfaces(surfaceOf(beforeDir!), surfaceOf(afterDir!));

  const version = (dir: string) =>
    (JSON.parse(readFileSync(path.join(dir, "tarballs.json"), "utf8")) as Tarball[])[0]!.version;
  const allowBreaking = () => {
    if (flag !== "--since") return minorOf(version(beforeDir!)) !== minorOf(version(afterDir!));
    let status: ChangesetStatus;
    try {
      status = readStatus(mkdtempSync(path.join(tmpdir(), "uwk-api-status-")), base);
    } catch {
      // Changesets has already said why it could not read them; the Changeset job fails too.
      return false;
    }
    return status.changesets.some((c) =>
      c.releases.some((r) => r.type === "minor" || r.type === "major"),
    );
  };

  const report = formatApiReport(diff, { before: beforeLabel!, after: afterLabel! });
  console.log(report);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) appendFileSync(stepSummary, report + "\n");

  const verdict = apiVerdict(diff, { allowBreaking });
  if (!verdict.ok) {
    console.error(`::error::${verdict.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
