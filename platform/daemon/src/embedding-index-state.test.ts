import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { MIGRATIONS, type MigrationDb } from "@signet/core";
import type { WriteDb } from "./db-accessor";
import {
	beginEmbeddingIndexBuild,
	describeEmbeddingProviderConflict,
	ensureEmbeddingIndexState,
	failEmbeddingIndexBuild,
	isActiveEmbeddingConfig,
	readEmbeddingIndexState,
	resolveActiveEmbeddingConfig,
} from "./embedding-index-state";
import type { EmbeddingConfig } from "./memory-config";

/**
 * Reach one migration through the package entry rather than its file path.
 * A relative import into `platform/core/src` escapes this project's rootDir,
 * which is what kept every test file out of `tsc` in the first place.
 */
function embeddingIndexGenerations(db: MigrationDb): void {
	const migration = MIGRATIONS.find((m) => m.version === 91);
	if (!migration) throw new Error("migration 91 (embedding index generations) is missing");
	migration.up(db);
}

const config: EmbeddingConfig = {
	provider: "native",
	model: "nomic-embed-text-v1.5",
	dimensions: 768,
	base_url: "",
};

describe("embedding index state", () => {
	it("seeds one legacy raw active profile and preserves it on later starts", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as MigrationDb);
		const db = raw as unknown as WriteDb;

		const initial = ensureEmbeddingIndexState(db, config, "2026-01-01T00:00:00.000Z");
		expect(initial.state).toBe("ready");
		expect(initial.active.profile).toBeUndefined();
		expect(initial.active.model).toBe("nomic-embed-text-v1.5");
		expect(readEmbeddingIndexState(db)).toEqual(initial);

		const changedConfig = { ...config, model: "qwen3-embedding:0.6b", dimensions: 1024 };
		const later = ensureEmbeddingIndexState(db, changedConfig, "2026-01-02T00:00:00.000Z");
		expect(later.active).toEqual(initial.active);
		expect(resolveActiveEmbeddingConfig(db, changedConfig)).toMatchObject({
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
			profile: undefined,
		});
		expect(raw.prepare("SELECT COUNT(*) AS count FROM embedding_index_state").get() as { count: number }).toEqual({
			count: 1,
		});
	});

	it("builds Qwen in staging without changing the legacy active profile", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as MigrationDb);
		raw.exec(
			`CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)`,
		);
		const db = raw as unknown as WriteDb;
		const active = ensureEmbeddingIndexState(db, config);
		const staged = beginEmbeddingIndexBuild(db, {
			...config,
			provider: "ollama",
			model: "qwen3-embedding:0.6b",
			dimensions: 1024,
		});

		expect(staged.state).toBe("building");
		expect(staged.active).toEqual(active.active);
		expect(staged.staging?.profile).toBe("qwen3-embedding");
		failEmbeddingIndexBuild(db, "provider unavailable");
		expect(ensureEmbeddingIndexState(db, config).state).toBe("failed");
		expect(ensureEmbeddingIndexState(db, config).active).toEqual(active.active);
	});

	it("stages unknown model changes with identity formatting instead of silently skipping them", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as MigrationDb);
		raw.exec(
			`CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)`,
		);
		const db = raw as unknown as WriteDb;
		ensureEmbeddingIndexState(db, { ...config, model: "custom-a" });
		const staging = beginEmbeddingIndexBuild(db, { ...config, model: "custom-b" });
		expect(staging.state).toBe("building");
		expect(staging.staging?.profile).toBeUndefined();
		expect(staging.staging?.model).toBe("custom-b");
	});

	it("rejects writes that captured a superseded active generation", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as MigrationDb);
		raw.exec(
			`CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)`,
		);
		const db = raw as unknown as WriteDb;
		ensureEmbeddingIndexState(db, config);
		expect(isActiveEmbeddingConfig(db, config)).toBe(true);
		beginEmbeddingIndexBuild(db, { ...config, model: "qwen3-embedding:0.6b", dimensions: 1024 });
		raw
			.prepare(
				"UPDATE embedding_index_state SET active_profile_json = staging_profile_json, staging_profile_json = NULL, state = 'ready' WHERE id = 1",
			)
			.run();
		expect(isActiveEmbeddingConfig(db, config)).toBe(false);
	});

	/**
	 * The operator edits `embedding.provider` and nothing appears to happen,
	 * because the active profile pins the vector space and wins — correctly. The
	 * cost is that the divergence is invisible, and on this exact shape (active
	 * `native`, configured anything else) the native ONNX worker segfaults Bun
	 * outright. A dead process cannot report its own conflict, so it has to be
	 * said before it matters.
	 */
	it("reports a configured provider the active profile is overriding", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as MigrationDb);
		raw.exec(
			"CREATE TABLE embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)",
		);
		const db = raw as unknown as WriteDb;

		ensureEmbeddingIndexState(db, config);
		const asked: EmbeddingConfig = { ...config, provider: "ollama", base_url: "http://127.0.0.1:11434" };
		beginEmbeddingIndexBuild(db, asked);

		expect(describeEmbeddingProviderConflict(db, asked)).toEqual({
			configuredProvider: "ollama",
			activeProvider: "native",
			migrationPending: true,
		});
	});

	it("does not report a conflict when the configured provider is already active", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as MigrationDb);
		const db = raw as unknown as WriteDb;

		ensureEmbeddingIndexState(db, config);
		// Same provider, different model: a real change, but not the one that
		// routes work to a crashing module. Reporting it would train the operator
		// to ignore the warning.
		expect(describeEmbeddingProviderConflict(db, { ...config, model: "qwen3-embedding:0.6b" })).toBeNull();
		expect(describeEmbeddingProviderConflict(db, config)).toBeNull();
	});

	it("reports nothing when the caller pinned a profile, because nothing is overridden", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as MigrationDb);
		const db = raw as unknown as WriteDb;

		ensureEmbeddingIndexState(db, config);
		// `resolveActiveEmbeddingConfig` returns a profile-pinned config verbatim,
		// so there is no override to warn about.
		const pinned: EmbeddingConfig = { ...config, provider: "ollama", profile: "nomic-embed-text-v1.5" };
		expect(describeEmbeddingProviderConflict(db, pinned)).toBeNull();
	});

	it("normalizes malformed config before it becomes durable state", () => {
		const raw = new Database(":memory:");
		embeddingIndexGenerations(raw as unknown as MigrationDb);
		const db = raw as unknown as WriteDb;
		const malformed = { ...config, provider: "not-a-provider", dimensions: 0 } as unknown as EmbeddingConfig;
		const initial = ensureEmbeddingIndexState(db, malformed);
		expect(initial.active.provider).toBe("native");
		expect(initial.active.dimensions).toBe(768);
		expect(ensureEmbeddingIndexState(db, malformed)).toEqual(initial);
	});
});
