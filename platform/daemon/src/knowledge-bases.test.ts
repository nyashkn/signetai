import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKnowledgeSource, projectionForRow, resolveWorkspaceDefaultAgentIds } from "./knowledge-bases";

describe("knowledge base ingestion helpers", () => {
	test("parses CSV rows into structured source records", () => {
		const rows = parseKnowledgeSource({
			kind: "csv",
			content: "name,email\nAda Lovelace,ada@example.com\n",
		});

		expect(rows).toHaveLength(1);
		expect(rows[0]?.sourceKey).toBe("row:1");
		expect(rows[0]?.values.name).toBe("Ada Lovelace");
		expect(rows[0]?.values.email).toBe("ada@example.com");
	});

	test("projects rows into entity/aspect/attribute knowledge", () => {
		const rows = parseKnowledgeSource({
			kind: "json",
			content: JSON.stringify([{ title: "Signet", repo: "github.com/signetai/signetai" }]),
		});
		const row = rows[0];
		expect(row).toBeDefined();
		if (!row) return;
		const projection = projectionForRow("repos", "json", row, {
			entity: { field: "title", type: "project", aspect: "source" },
		});

		expect(projection.entityName).toBe("Signet");
		expect(projection.entityType).toBe("project");
		expect(projection.aspects[0]?.attributes.some((attr) => attr.content.includes("repo:"))).toBe(true);
		expect(projection.hints.some((hint) => hint.includes("Signet"))).toBe(true);
	});

	test("uses the workspace default agent from agent.yaml before literal default", () => {
		const dir = join(tmpdir(), `signet-kb-agent-${process.pid}-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "agent:\n  name: ant\n");

		expect(resolveWorkspaceDefaultAgentIds(dir)).toEqual(["ant", "default"]);
	});
});
