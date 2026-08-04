/**
 * Post-conditions a sync must satisfy, enforced rather than reported.
 *
 * Every ingest defect this connector has had reported success while it happened.
 * The first live run answered "351 indexed, 0 failures" having fetched zero
 * bodies; the re-sync overwrite replaced whole messages with their headers and
 * likewise counted them as indexed. A row count is not evidence of content, and
 * a warning in a log is something nobody reads until the corpus is already thin.
 *
 * So the checks live here and they throw. A sync that destroyed data is a failed
 * sync, not a successful one with a note.
 */
import { getDbAccessor } from "./db-accessor";

export class SourceIngestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SourceIngestError";
	}
}

export interface IngestSnapshot {
	/** Live artifact paths that carry a fetched body. */
	readonly withBody: ReadonlySet<string>;
}

interface PathRow {
	readonly source_path: string;
}

function livePaths(agentId: string, sourceId: string, withBodyOnly: boolean): Set<string> {
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_path FROM memory_artifacts
					 WHERE agent_id = ? AND source_id = ? AND COALESCE(is_deleted, 0) = 0
					 ${withBodyOnly ? "AND json_extract(source_meta_json, '$.bodyFetched') = 1" : ""}`,
				)
				.all(agentId, sourceId) as PathRow[],
	);
	return new Set(rows.map((row) => row.source_path));
}

export function snapshotSourceIngest(agentId: string, sourceId: string): IngestSnapshot {
	return { withBody: livePaths(agentId, sourceId, true) };
}

/**
 * A body may legitimately disappear with its message — mail gets deleted and the
 * stale purge follows. What may never happen is a path that is still live losing
 * the body it had, which is exactly the shape of a destructive rewrite.
 */
export function assertIngestNotDegraded(agentId: string, sourceId: string, before: IngestSnapshot): void {
	const liveAfter = livePaths(agentId, sourceId, false);
	const withBodyAfter = livePaths(agentId, sourceId, true);

	const lost = [...before.withBody].filter((path) => liveAfter.has(path) && !withBodyAfter.has(path));
	if (lost.length > 0) {
		throw new SourceIngestError(
			`Sync dropped stored bodies from ${lost.length} live artifact(s): ${lost.slice(0, 3).join(", ")}`,
		);
	}

	const corrupt = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_path FROM memory_artifacts
					 WHERE agent_id = ? AND source_id = ? AND COALESCE(is_deleted, 0) = 0
					   AND json_extract(source_meta_json, '$.bodyFetched') = 1
					   AND COALESCE(length(content), 0) = 0
					 LIMIT 3`,
				)
				.all(agentId, sourceId) as PathRow[],
	);
	if (corrupt.length > 0) {
		throw new SourceIngestError(
			`Sync left ${corrupt.length}+ artifact(s) claiming a fetched body with no content: ${corrupt
				.map((row) => row.source_path)
				.join(", ")}`,
		);
	}
}
