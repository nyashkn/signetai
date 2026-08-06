import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard the runtime against the version the repo pins.
 *
 * This exists because of a real half-day: a `bun upgrade` to a canary ahead of
 * stable made `bun test` segfault — `panic(main thread): Segmentation fault` —
 * on every daemon suite that opens more than two databases. Nothing pointed at
 * the toolchain. The crash reproduced on a clean checkout with the working tree
 * stashed, which reads exactly like a repo defect, and the hunt went through
 * `bun install`, the lockfile, the sqlite-vec native extension and Homebrew
 * SQLite before the binary's mtime gave it away.
 *
 * A failing assertion naming the versions costs one line and turns that into a
 * sentence. Compared on major.minor only: patch releases inside a line are the
 * normal churn a lockfile already handles, while a minor bump is what actually
 * changes the runtime under you.
 *
 * Note this file opens no database, so it still runs on the broken toolchain —
 * a guard that segfaulted alongside everything else would report nothing.
 *
 * A canary is not separately detectable: `Bun.version` drops the tag and
 * `Bun.revision` is a bare commit hash, so `1.4.0-canary.1` reads as `1.4.0`.
 * The release-line check catches it anyway, since a canary is by definition
 * ahead of the pinned line.
 */
describe("toolchain", () => {
	const repoRoot = join(import.meta.dir, "../../..");

	function pinnedBunVersion(): string {
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
			packageManager?: string;
		};
		const pin = pkg.packageManager;
		if (!pin?.startsWith("bun@")) {
			throw new Error(`Root package.json packageManager should pin bun, got ${pin ?? "nothing"}`);
		}
		return pin.slice("bun@".length);
	}

	function line(version: string): string {
		const [major, minor] = version.split(".");
		return `${major}.${minor}`;
	}

	it("runs on the bun release line the repo pins", () => {
		const pinned = pinnedBunVersion();
		expect(
			line(Bun.version),
			`Running bun ${Bun.version}, but package.json pins bun@${pinned}. Bun releases outside the pinned line have segfaulted this test suite; run \`bun upgrade --stable\` or install the pinned version before trusting a result.`,
		).toBe(line(pinned));
	});
});
