import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

/**
 * `.gitignore` is the one config whose failures are invisible: an ignored source
 * file is not staged, and a file that is never staged looks exactly like a file
 * that was never written. A bare `email*` rule hid the whole email connector
 * this way — five tracked files that `git status` never mentioned.
 *
 * So the rules that could plausibly swallow source are asserted rather than
 * reviewed. These paths need not exist; `git check-ignore` answers on the
 * pattern, which is the point — it catches the rule before the file lands.
 */

const REPO_ROOT = (() => {
	// Walk up from this file to the checkout root (four levels: src → daemon →
	// platform → repo). Resolving by `git rev-parse` would pass inside a
	// worktree pointing somewhere else.
	let dir = dirname(new URL(import.meta.url).pathname);
	for (let i = 0; i < 3; i++) dir = dirname(dir);
	return dir;
})();

function isIgnored(relativePath: string): boolean {
	const result = spawnSync("git", ["check-ignore", "-q", "--", relativePath], {
		cwd: REPO_ROOT,
		stdio: "ignore",
	});
	// 0 = ignored, 1 = not ignored, 128 = not a git checkout.
	if (result.status === 128) throw new Error("gitignore scope test requires a git checkout");
	return result.status === 0;
}

describe("gitignore scope", () => {
	it("does not ignore source files whose names start with a swallowed prefix", () => {
		for (const path of [
			"platform/daemon/src/email-source-provider.ts",
			"platform/daemon/src/email-message-parse.ts",
			"surfaces/cli/src/features/email-sources.ts",
			"platform/core/src/emails.ts",
		]) {
			expect({ path, ignored: isIgnored(path) }).toEqual({ path, ignored: false });
		}
	});

	it("still ignores the repo-root scratch paths those rules exist for", () => {
		expect(isIgnored("email-export.json")).toBe(true);
		expect(isIgnored(join("node_modules", "anything"))).toBe(true);
	});
});
