import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../../core/src/migrations";
import { type DbAccessor, type ReadDb, type WriteDb, closeDbAccessor, initDbAccessor } from "../db-accessor";
import { loadMemoryConfig } from "../memory-config";
import { IMMUTABLE_ARTIFACT_ERROR_PREFIX, writeSummaryArtifact } from "../memory-lineage";
import { RateLimitExceededError } from "./provider";
import type { LlmProvider } from "./provider";
import {
	SUMMARY_WORKER_UPDATED_BY,
	type SummaryJobRow,
	type SummaryWorkerHandle,
	canProcessSummaryJobs,
	isTerminalSummaryJobError,
	leaseSummaryJobWhenAvailable,
	persistSessionSummaryArtifact,
	recoverSummaryJobs,
	resolveFailedSummaryJobStatus,
	resolveSummaryHeadingDate,
	scoreContinuity,
	startSummaryRecovery,
	startSummaryWorker,
} from "./summary-worker";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
			return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

function makeAgentsDir(yaml: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-summary-cfg-"));
	writeFileSync(join(dir, "agent.yaml"), yaml);
	return dir;
}

describe("canProcessSummaryJobs", () => {
	it("processes when synthesis is available", () => {
		expect(canProcessSummaryJobs(true)).toBe(true);
	});

	it("does not process when synthesis is unavailable", () => {
		expect(canProcessSummaryJobs(false)).toBe(false);
	});

	it("does not process when paused even if synthesis is available", () => {
		expect(canProcessSummaryJobs(true, true)).toBe(false);
		expect(canProcessSummaryJobs(false, true)).toBe(false);
	});
});

describe("leaseSummaryJobWhenAvailable", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, session_id, harness, project, agent_id, transcript,
			  trigger, status, attempts, max_attempts, created_at)
			 VALUES ('job-gated', 'session-gated', 'session-gated', 'hermes', NULL,
			         'default', 'User: hello', 'session_end', 'pending', 0, 3, ?)`,
		).run(new Date().toISOString());
	});

	afterEach(() => {
		db.close();
	});

	it("leaves pending jobs unchanged when synthesis is unavailable", async () => {
		const job = await leaseSummaryJobWhenAvailable(accessor, async () => false);

		expect(job).toBeNull();
		const row = db.prepare("SELECT status, attempts FROM summary_jobs WHERE id = 'job-gated'").get() as {
			status: string;
			attempts: number;
		};
		expect(row).toEqual({ status: "pending", attempts: 0 });
	});

	it("restores an unchanged pending job when synthesis becomes unavailable after lease", async () => {
		let checks = 0;
		const job = await leaseSummaryJobWhenAvailable(accessor, async () => {
			checks += 1;
			return checks === 1;
		});

		expect(job).toBeNull();
		expect(checks).toBe(2);
		const row = db.prepare("SELECT status, attempts FROM summary_jobs WHERE id = 'job-gated'").get() as {
			status: string;
			attempts: number;
		};
		expect(row).toEqual({ status: "pending", attempts: 0 });
	});

	it("restores an unchanged pending job when the post-lease availability check errors", async () => {
		let checks = 0;
		await expect(
			leaseSummaryJobWhenAvailable(accessor, async () => {
				checks += 1;
				if (checks === 2) throw new Error("routing refresh failed");
				return true;
			}),
		).rejects.toThrow("routing refresh failed");

		const row = db.prepare("SELECT status, attempts FROM summary_jobs WHERE id = 'job-gated'").get() as {
			status: string;
			attempts: number;
		};
		expect(row).toEqual({ status: "pending", attempts: 0 });
	});

	it("surfaces a failed lease restoration instead of silently stranding work", async () => {
		let checks = 0;
		await expect(
			leaseSummaryJobWhenAvailable(accessor, async () => {
				checks += 1;
				if (checks === 2) {
					db.prepare("UPDATE summary_jobs SET status = 'dead' WHERE id = 'job-gated'").run();
					return false;
				}
				return true;
			}),
		).rejects.toThrow("Failed to restore unprocessed summary lease for job job-gated");
	});

	it("leases a pending job only while synthesis remains available", async () => {
		const job = await leaseSummaryJobWhenAvailable(accessor, async () => true);

		expect(job?.id).toBe("job-gated");
		expect(job?.attempts).toBe(1);
		const row = db.prepare("SELECT status, attempts FROM summary_jobs WHERE id = 'job-gated'").get() as {
			status: string;
			attempts: number;
		};
		expect(row).toEqual({ status: "processing", attempts: 1 });
	});
});

describe("recoverSummaryJobs", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("recovers stuck summary jobs in bounded batches", () => {
		const now = new Date().toISOString();
		const stmt = db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES (?, NULL, 'codex', NULL, 'transcript', ?, ?, ?, ?)`,
		);

		for (let i = 0; i < 205; i++) {
			const attempts = i % 3;
			const max = 2;
			const status = i % 2 === 0 ? "processing" : "leased";
			stmt.run(`job-${i}`, status, attempts, max, now);
		}

		expect(recoverSummaryJobs(accessor, 100)).toEqual({ selected: 100, updated: 100 });
		expect(recoverSummaryJobs(accessor, 100)).toEqual({ selected: 100, updated: 100 });
		expect(recoverSummaryJobs(accessor, 100)).toEqual({ selected: 5, updated: 5 });
		expect(recoverSummaryJobs(accessor, 100)).toEqual({ selected: 0, updated: 0 });

		const left = db
			.prepare("SELECT COUNT(*) as n FROM summary_jobs WHERE status IN ('processing', 'leased')")
			.get() as { n: number };
		expect(left.n).toBe(0);

		const dead = db.prepare("SELECT COUNT(*) as n FROM summary_jobs WHERE status = 'dead'").get() as { n: number };
		expect(dead.n).toBeGreaterThan(0);
	});

	it("clamps invalid recovery limits to a sane positive range", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES ('job-limit', NULL, 'codex', NULL, 'transcript', 'processing', 0, 3, ?)`,
		).run(now);
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES ('job-limit-2', NULL, 'codex', NULL, 'transcript', 'processing', 0, 3, ?)`,
		).run(now);

		expect(recoverSummaryJobs(accessor, 0)).toEqual({ selected: 1, updated: 1 });
		expect(recoverSummaryJobs(accessor, Number.POSITIVE_INFINITY)).toEqual({ selected: 1, updated: 1 });
	});

	it("recovers both js and rust persisted in-flight status variants", () => {
		const now = new Date().toISOString();
		const stmt = db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES (?, NULL, 'codex', NULL, 'transcript', ?, 0, 3, ?)`,
		);

		stmt.run("job-processing", "processing", now);
		stmt.run("job-leased", "leased", now);

		expect(recoverSummaryJobs(accessor, 10)).toEqual({ selected: 2, updated: 2 });

		const rows = db.prepare("SELECT id, status FROM summary_jobs ORDER BY id ASC").all() as Array<{
			id: string;
			status: string;
		}>;
		expect(rows).toEqual([
			{ id: "job-leased", status: "pending" },
			{ id: "job-processing", status: "pending" },
		]);
	});

	it("recovers processing jobs during crash recovery", () => {
		const now = new Date().toISOString();
		const stmt = db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, result, attempts, max_attempts, created_at)
			 VALUES (?, NULL, 'codex', NULL, 'transcript', 'processing', ?, 0, 3, ?)`,
		);
		stmt.run("job-stuck", "some-marker", now);

		expect(recoverSummaryJobs(accessor, 10)).toEqual({ selected: 1, updated: 1 });

		const row = db.prepare("SELECT status FROM summary_jobs WHERE id = 'job-stuck'").get() as { status: string };
		expect(row.status).toBe("pending");
	});

	it("defers crash recovery off the synchronous startup path", async () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES ('job-startup', NULL, 'codex', NULL, 'transcript', 'processing', 0, 3, ?)`,
		).run(now);

		const handle = startSummaryWorker(accessor);
		const before = db.prepare("SELECT status FROM summary_jobs WHERE id = 'job-startup'").get() as { status: string };
		expect(before.status).toBe("processing");

		await new Promise((resolve) => setTimeout(resolve, 10));
		handle.stop();

		const after = db.prepare("SELECT status FROM summary_jobs WHERE id = 'job-startup'").get() as { status: string };
		expect(after.status).toBe("pending");
	});

	it("recovers stale leases without leasing pending work", async () => {
		const now = new Date().toISOString();
		const stmt = db.prepare(
			`INSERT INTO summary_jobs
			 (id, session_key, harness, project, transcript, status, attempts, max_attempts, created_at)
			 VALUES (?, NULL, 'codex', NULL, 'transcript', ?, ?, 3, ?)`,
		);
		stmt.run("job-stale", "leased", 1, now);
		stmt.run("job-pending", "pending", 0, now);

		const stopRecovery = startSummaryRecovery(accessor);
		await new Promise((resolve) => setTimeout(resolve, 10));
		stopRecovery();

		const rows = db.prepare("SELECT id, status, attempts FROM summary_jobs ORDER BY id").all();
		expect(rows).toEqual([
			{ id: "job-pending", status: "pending", attempts: 0 },
			{ id: "job-stale", status: "pending", attempts: 1 },
		]);
	});
});

describe("summary job helpers", () => {
	it("passes pipeline cancellation into continuity scoring generation", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = makeAccessor(db);
		const controller = new AbortController();
		controller.abort();
		let observedSignal: AbortSignal | undefined;
		const provider: LlmProvider = {
			async generate(_prompt, opts) {
				observedSignal = opts?.signal;
				throw new Error("aborted");
			},
		};

		try {
			await expect(
				scoreContinuity(
					accessor,
					provider,
					{
						id: "job-continuity",
						session_key: "session-continuity",
						session_id: null,
						harness: "codex",
						project: "/tmp/project",
						agent_id: "default",
						transcript: "User: summarize continuity cancellation",
						trigger: "test",
						captured_at: null,
						started_at: null,
						ended_at: null,
						attempts: 1,
						max_attempts: 3,
						created_at: new Date().toISOString(),
					},
					"summary",
					loadMemoryConfig(makeAgentsDir("memory:\n")),
					controller.signal,
				),
			).rejects.toThrow("aborted");
			expect(observedSignal).toBe(controller.signal);
		} finally {
			db.close();
		}
	});

	it("derives the summary heading date from persisted session timing instead of wall clock", () => {
		expect(
			resolveSummaryHeadingDate({
				ended_at: "2026-04-03T17:07:08.000Z",
				captured_at: "2026-04-03T17:06:55.000Z",
				created_at: "2026-04-03T17:06:55.000Z",
			}),
		).toBe("2026-04-03");
		expect(
			resolveSummaryHeadingDate({
				ended_at: null,
				captured_at: "2026-04-02T23:59:59.000Z",
				created_at: "2026-04-03T00:00:01.000Z",
			}),
		).toBe("2026-04-02");
		expect(
			resolveSummaryHeadingDate({
				ended_at: null,
				captured_at: null,
				created_at: "2026-04-01T12:00:00.000Z",
			}),
		).toBe("2026-04-01");
	});

	it("classifies immutable artifact conflicts as terminal failures", () => {
		expect(
			isTerminalSummaryJobError(
				`${IMMUTABLE_ARTIFACT_ERROR_PREFIX} /tmp/.agents/memory/2026-04-03T14-08-11.982Z--token--summary.md`,
			),
		).toBe(true);
		expect(isTerminalSummaryJobError("summary command timed out after 5000ms")).toBe(false);
	});

	it("classifies RateLimitExceededError as terminal via error instance", () => {
		const err = new RateLimitExceededError("claude-code:haiku", 200);
		expect(isTerminalSummaryJobError(err)).toBe(true);
		expect(isTerminalSummaryJobError(err.message)).toBe(false);
	});

	it("marks terminal errors dead immediately even with remaining attempts", () => {
		// terminal=true -> dead regardless of attempt count (one attempt is
		// still consumed by the worker tick before the error is classified)
		expect(resolveFailedSummaryJobStatus(true, 1, 3)).toBe("dead");
		// terminal=false, attempts < maxAttempts -> pending (retryable)
		expect(resolveFailedSummaryJobStatus(false, 1, 3)).toBe("pending");
		// terminal=false, attempts >= maxAttempts -> dead (exhausted)
		expect(resolveFailedSummaryJobStatus(false, 3, 3)).toBe("dead");
	});
});

describe("persistSessionSummaryArtifact", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	function resetWorkspace(): void {
		closeDbAccessor();
		rmSync(join(dir, "memory"), { recursive: true, force: true });
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	}

	beforeAll(() => {
		prevSignetPath = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-summary-conflict-"));
		process.env.SIGNET_PATH = dir;
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		resetWorkspace();
	});

	beforeEach(() => {
		resetWorkspace();
	});

	afterAll(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
		if (prevSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
			return;
		}
		process.env.SIGNET_PATH = prevSignetPath;
	});

	it("completes instead of throwing when a prior attempt already committed the artifact (#900)", async () => {
		const job: SummaryJobRow = {
			id: "job-conflict",
			session_key: "session-conflict",
			session_id: "session-conflict",
			harness: "codex",
			project: "/mnt/work/dev/project",
			agent_id: "default",
			transcript: "transcript",
			trigger: "session_end",
			boundary_reason: "session_closed",
			captured_at: "2026-04-03T14:08:11.982Z",
			started_at: "2026-04-03T14:00:00.000Z",
			ended_at: "2026-04-03T15:00:00.000Z",
			attempts: 2,
			max_attempts: 3,
			created_at: "2026-04-03T14:08:11.982Z",
		};

		// Simulate a prior attempt that already committed the summary artifact
		// (daemon crashed between core commit and the 'completed' status update).
		await writeSummaryArtifact({
			agentId: job.agent_id,
			sessionId: job.session_id ?? job.session_key ?? job.id,
			sessionKey: job.session_key,
			project: job.project,
			harness: job.harness,
			capturedAt: job.captured_at ?? job.created_at,
			startedAt: job.started_at,
			endedAt: job.ended_at,
			summary: "Prior attempt already persisted this summary with different body content.",
		});

		// The retry produces a different summary body. Without the immutable-
		// conflict catch this throws (content mismatch) and the worker would
		// classify it terminal -> dead. With the fix it resolves cleanly so the
		// caller can mark the job completed.
		await expect(
			persistSessionSummaryArtifact(job, "Retry produced a different summary body.", null),
		).resolves.toBeUndefined();
	});
});

describe("summary jobs produce no fact memories or extract jobs (#913)", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("does not expose the retired summary-fact writer", async () => {
		const module = await import("./summary-worker");
		expect((module as Record<string, unknown>).insertSummaryFacts).toBeUndefined();
	});
});
