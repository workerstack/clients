/**
 * The release's CHANGELOG check: a version ships only with its own entry, so a tag whose notes nobody wrote cannot
 * reach npm. release.yml runs it in the pack job, before the packing and before the publish.
 *
 * Usage: `bun scripts/changelog.ts <version>` — it reads `CHANGELOG.md` beside the working directory, prints why the
 * entry does not count, and exits 1. A version with its entry prints nothing and exits 0. The file keeps Keep a
 * Changelog's shape, which `bun repo check` holds it to: a prerelease reads the `## [Unreleased]` entry, where the
 * notes of the coming release collect (`1.0.0-rc.1` → `## [Unreleased]`), and a final release needs its own dated
 * `## [1.0.0] - YYYY-MM-DD` entry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The heading of the notes the coming release collects while its candidates ship. */
export const UNRELEASED = "## [Unreleased]";

/**
 * The heading that opens `version`'s entry: `## [Unreleased]` for a prerelease, else `## [<version>] - <date>`. It is
 * anchored at both ends, so `## [1.0.10]` is not `1.0.1`'s entry.
 */
export function headingOf(version: string): RegExp {
  if (prerelease(version)) return /^## \[Unreleased\]$/m;

  return new RegExp(String.raw`^## \[${version.replaceAll(".", String.raw`\.`)}\] - \d{4}-\d{2}-\d{2}$`, "m");
}

/** Whether `version` is a prerelease: a hyphen after the triple, as semver spells it. */
export const prerelease = (version: string): boolean => version.includes("-");

/** How the entry `version` reads is named in a message. */
function entryName(version: string): string {
  return prerelease(version) ? UNRELEASED : `## [${version}] - YYYY-MM-DD`;
}

/**
 * Why `changelog` holds no entry for `version`, or null when it does: a heading, at least one `###` section under
 * it, and at least one bullet. A heading with nothing under it is not notes, so it does not count.
 */
export function missingEntry(changelog: string, version: string): string | null {
  const name = entryName(version);
  const heading = headingOf(version).exec(changelog);

  if (heading === null) return `CHANGELOG.md has no "${name}" entry`;
  const body = changelog.slice(heading.index + heading[0].length).split(/^## /m)[0] ?? "";

  if (!/^### \S/m.test(body)) return `CHANGELOG.md's "${name}" entry has no section (### Added, ### Changed, …)`;

  if (!/^- \S/m.test(body)) return `CHANGELOG.md's "${name}" entry lists nothing`;

  return null;
}

/** The CLI: the version to check is the one argument, and `CHANGELOG.md` is read from the working directory. */
function main(argv: readonly string[]): number {
  const version = argv[0];

  if (version === undefined || version === "") {
    process.stderr.write("usage: bun scripts/changelog.ts <version>\n");

    return 2;
  }

  const why = missingEntry(readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8"), version);

  if (why === null) return 0;
  process.stderr.write(`${why}\n`);

  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
