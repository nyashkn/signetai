import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { resolveTemporalRecall } from "./temporal-recall";

describe("temporal recall", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-temporal-recall-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("scopes non-memory temporal edges by the requesting agent policy", () => {
		const createdAt = "2026-05-24T18:00:00.000Z";
		getDbAccessor().withWriteTx((db) => {
			const agent = db.prepare(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES (?, ?, 'isolated', ?, ?, ?)`,
			);
			agent.run("owner", "owner", "team-a", createdAt, createdAt);
			agent.run("teammate", "teammate", "team-a", createdAt, createdAt);
			agent.run("outsider", "outsider", "team-b", createdAt, createdAt);
			const edge = db.prepare(
				`INSERT INTO temporal_edges
				 (id, agent_id, subject_type, subject_id, facet, start_at, end_at, confidence, created_at, updated_at)
				 VALUES (?, ?, 'source_document', ?, 'occurred', ?, ?, 1.0, ?, ?)`,
			);
			edge.run("owner-edge", "owner", "owner-doc", "2026-05-13T12:00:00.000Z", "2026-05-13T12:00:00.000Z", createdAt, createdAt);
			edge.run("teammate-edge", "teammate", "teammate-doc", "2026-05-13T13:00:00.000Z", "2026-05-13T13:00:00.000Z", createdAt, createdAt);
			edge.run("outsider-edge", "outsider", "outsider-doc", "2026-05-13T14:00:00.000Z", "2026-05-13T14:00:00.000Z", createdAt, createdAt);
		});

		const time = {
			start: "2026-05-13T00:00:00.000Z",
			end: "2026-05-14T00:00:00.000Z",
			facets: ["occurred"] as const,
			mode: "timeline" as const,
		};
		const group = resolveTemporalRecall({
			query: "",
			time,
			limit: 10,
			agentId: "owner",
			readPolicy: "group",
			policyGroup: "team-a",
		});
		expect(group.response?.results.map((row) => row.subject_id)).toEqual(["teammate-doc", "owner-doc"]);

		const isolated = resolveTemporalRecall({ query: "", time, limit: 10, agentId: "owner", readPolicy: "isolated" });
		expect(isolated.response?.results.map((row) => row.subject_id)).toEqual(["owner-doc"]);
	});
});
