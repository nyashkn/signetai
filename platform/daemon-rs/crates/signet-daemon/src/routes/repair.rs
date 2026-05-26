//! Repair action routes: maintenance and recovery endpoints.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json},
};
use serde::Deserialize;

use crate::state::AppState;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Standard repair result shape.
fn repair_result(action: &str, success: bool, affected: usize, message: &str) -> serde_json::Value {
    serde_json::json!({
        "action": action,
        "success": success,
        "affected": affected,
        "message": message,
    })
}

fn lease_timeout_ms(state: &AppState) -> u64 {
    // Match the TypeScript repair endpoint's resolved fallback until the
    // Rust daemon shares the same config resolution path.
    state
        .config
        .manifest
        .memory
        .as_ref()
        .and_then(|cfg| cfg.pipeline_v2.as_ref())
        .map(|cfg| cfg.worker.lease_timeout_ms)
        .unwrap_or(300_000)
}

// ---------------------------------------------------------------------------
// Repair endpoints
// ---------------------------------------------------------------------------

/// POST /api/repair/requeue-dead — move dead jobs back to pending.
pub async fn requeue_dead(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let count = conn.execute(
                "UPDATE memory_jobs SET status = 'pending', attempts = 0, error = NULL, updated_at = datetime('now')
                 WHERE status = 'dead'",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "requeue_dead",
                    true,
                    n,
                    &format!("{n} dead jobs requeued"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("requeue_dead", false, 0, &e.to_string())),
        ),
    }
}

/// POST /api/repair/release-leases — release stale job leases.
pub async fn release_leases(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let lease_ms = lease_timeout_ms(&state).min(i64::MAX as u64) as i64;
    let now = chrono::Utc::now();
    let now_s = now.to_rfc3339();
    let cutoff = (now - chrono::Duration::milliseconds(lease_ms)).to_rfc3339();
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let dead = conn.execute(
                "UPDATE memory_jobs
                 SET status = 'dead',
                     leased_at = NULL,
                     failed_at = ?1,
                     error = COALESCE(error, 'lease expired before completion'),
                     updated_at = ?1
                 WHERE status = 'leased'
                   AND leased_at < ?2
                   AND attempts >= max_attempts",
                rusqlite::params![now_s, cutoff],
            )?;
            let pending = conn.execute(
                "UPDATE memory_jobs
                 SET status = 'pending',
                     leased_at = NULL,
                     updated_at = ?1
                 WHERE status = 'leased'
                   AND leased_at < ?2
                   AND attempts < max_attempts",
                rusqlite::params![now_s, cutoff],
            )?;
            Ok(serde_json::json!({
                "pending": pending,
                "dead": dead,
                "total": pending + dead,
            }))
        })
        .await;

    match result {
        Ok(count) => {
            let pending = count["pending"].as_u64().unwrap_or(0) as usize;
            let dead = count["dead"].as_u64().unwrap_or(0) as usize;
            let n = count["total"].as_u64().unwrap_or(0) as usize;
            let msg = if dead > 0 {
                format!(
                    "released {pending} stale lease(s) back to pending and dead-lettered {dead} exhausted job(s)"
                )
            } else {
                format!("released {pending} stale lease(s) back to pending")
            };
            (
                StatusCode::OK,
                Json(repair_result("release_leases", true, n, &msg)),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("release_leases", false, 0, &e.to_string())),
        ),
    }
}

#[derive(Deserialize)]
pub struct CheckFtsBody {
    #[serde(default)]
    pub repair: bool,
}

/// POST /api/repair/check-fts — verify/repair FTS index consistency.
pub async fn check_fts(
    State(state): State<Arc<AppState>>,
    body: Option<Json<CheckFtsBody>>,
) -> impl IntoResponse {
    let do_repair = body.map(|Json(b)| b.repair).unwrap_or(false);

    let result = state
        .pool
        .write(signet_core::db::Priority::Low, move |conn| {
            let fts_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM memories_fts", [], |r| r.get(0))
                .unwrap_or(0);
            let active_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memories WHERE deleted = 0",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let mismatch = (fts_count - active_count).unsigned_abs();

            if do_repair && mismatch > 0 {
                // Rebuild FTS
                conn.execute("DELETE FROM memories_fts", [])?;
                conn.execute(
                    "INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories WHERE deleted = 0",
                    [],
                )?;
            }

            Ok(serde_json::json!({
                "fts_count": fts_count,
                "active_count": active_count,
                "mismatch": mismatch,
                "repaired": do_repair && mismatch > 0,
            }))
        })
        .await;

    match result {
        Ok(info) => {
            let repaired = info["repaired"].as_bool().unwrap_or(false);
            let mismatch = info["mismatch"].as_u64().unwrap_or(0) as usize;
            let msg = if repaired {
                format!("FTS index rebuilt, {mismatch} entries corrected")
            } else if mismatch > 0 {
                format!("FTS mismatch detected: {mismatch} entries differ")
            } else {
                "FTS index consistent".into()
            };
            (
                StatusCode::OK,
                Json(repair_result("check_fts", true, mismatch, &msg)),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("check_fts", false, 0, &e.to_string())),
        ),
    }
}

/// POST /api/repair/retention-sweep — trigger retention sweep.
pub async fn retention_sweep(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    // TODO: Wire to retention worker
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(repair_result(
            "retention_sweep",
            false,
            0,
            "not yet wired — retention worker handles this automatically",
        )),
    )
}

/// GET /api/repair/embedding-gaps — audit embedding coverage.
pub async fn embedding_gaps(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let result = state
        .pool
        .read(|conn| {
            let total: i64 = conn
                .query_row("SELECT COUNT(*) FROM memories WHERE deleted = 0", [], |r| {
                    r.get(0)
                })
                .unwrap_or(0);

            let missing: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memories m
                     LEFT JOIN memory_embeddings e ON e.memory_id = m.id
                     WHERE m.deleted = 0 AND e.memory_id IS NULL",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let pct = if total > 0 {
                (missing as f64 / total as f64) * 100.0
            } else {
                0.0
            };

            Ok(serde_json::json!({
                "total_memories": total,
                "missing_count": missing,
                "missing_percent": format!("{pct:.1}"),
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({"error": "db unavailable"}));

    Json(result)
}

#[derive(Deserialize)]
#[allow(dead_code)] // Fields used when embedding provider integration is wired
pub struct ReEmbedBody {
    #[serde(default = "default_batch")]
    pub batch_size: usize,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub full_sweep: bool,
}

fn default_batch() -> usize {
    50
}

/// POST /api/repair/re-embed — re-compute embeddings for gaps.
pub async fn re_embed(
    State(_state): State<Arc<AppState>>,
    Json(_body): Json<Option<ReEmbedBody>>,
) -> impl IntoResponse {
    // TODO: Wire to embedding provider for re-embedding.
    // Parity note (PR #372): when implemented, write content_hash back to
    // memories.content_hash for null-hash rows after embedding, but guard
    // against the unique partial index (idx_memories_content_hash_unique):
    // check that no other non-deleted memory already owns the hash before
    // writing -- skip and let dedup clean it up if there is a collision.
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(repair_result(
            "re_embed",
            false,
            0,
            "re-embedding requires embedding provider integration",
        )),
    )
}

/// POST /api/repair/resync-vec — rebuild vector index.
pub async fn resync_vec(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            // Clear and rebuild vec_documents from memory_embeddings
            conn.execute("DELETE FROM vec_documents", [])?;
            let count = conn.execute(
                "INSERT INTO vec_documents(rowid, embedding)
                 SELECT m.rowid, e.embedding FROM memories m
                 JOIN memory_embeddings e ON e.memory_id = m.id
                 WHERE m.deleted = 0",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "resync_vec",
                    true,
                    n,
                    &format!("{n} vectors resynced"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("resync_vec", false, 0, &e.to_string())),
        ),
    }
}

/// POST /api/repair/clean-orphans — remove orphan embedding entries.
pub async fn clean_orphans(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let count = conn.execute(
                "DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories WHERE deleted = 0)",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "clean_orphans",
                    true,
                    n,
                    &format!("{n} orphan embeddings removed"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("clean_orphans", false, 0, &e.to_string())),
        ),
    }
}

/// GET /api/repair/dedup-stats — audit duplicate memories.
pub async fn dedup_stats(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let result = state
        .pool
        .read(|conn| {
            // Exact duplicates by content hash
            let exact_clusters: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM (SELECT content_hash, COUNT(*) as cnt FROM memories WHERE deleted = 0 AND content_hash IS NOT NULL GROUP BY content_hash HAVING cnt > 1)",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            let exact_memories: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(cnt), 0) FROM (SELECT content_hash, COUNT(*) as cnt FROM memories WHERE deleted = 0 AND content_hash IS NOT NULL GROUP BY content_hash HAVING cnt > 1)",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);

            Ok(serde_json::json!({
                "exact_duplicates": {
                    "cluster_count": exact_clusters,
                    "memory_count": exact_memories,
                },
                "semantic_duplicates": {
                    "cluster_count": 0,
                    "memory_count": 0,
                    "threshold": 0.9,
                }
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({"error": "db unavailable"}));

    Json(result)
}

/// POST /api/repair/deduplicate — merge duplicate memories.
pub async fn deduplicate(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    // TODO: Implement deduplication with content hash and semantic similarity
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(repair_result(
            "deduplicate",
            false,
            0,
            "deduplication not yet implemented",
        )),
    )
}

/// POST /api/repair/backfill-skipped — retry skipped sessions.
pub async fn backfill_skipped(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .read(|conn| {
            // Check if session_summaries table exists
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_summaries'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if !exists {
                return Ok(serde_json::json!(0));
            }

            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM session_summaries WHERE status = 'skipped'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "backfill_skipped",
                    true,
                    n,
                    &format!("{n} skipped sessions found"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("backfill_skipped", false, 0, &e.to_string())),
        ),
    }
}

/// POST /api/repair/reclassify-entities — re-run entity classification.
pub async fn reclassify_entities(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(repair_result(
            "reclassify_entities",
            false,
            0,
            "requires LLM provider integration",
        )),
    )
}

/// POST /api/repair/prune-chunk-groups — remove empty chunk group entities.
pub async fn prune_chunk_groups(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let count = conn.execute(
                "DELETE FROM entities WHERE entity_type = 'chunk_group' AND id NOT IN (
                    SELECT DISTINCT entity_id FROM memory_entity_mentions
                )",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "prune_chunk_groups",
                    true,
                    n,
                    &format!("{n} chunk groups pruned"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result(
                "prune_chunk_groups",
                false,
                0,
                &e.to_string(),
            )),
        ),
    }
}

/// POST /api/repair/prune-singleton-entities — remove low-mention entities.
pub async fn prune_singletons(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let result = state
        .pool
        .write(signet_core::db::Priority::Low, |conn| {
            let count = conn.execute(
                "DELETE FROM entities WHERE pinned = 0 AND id IN (
                    SELECT e.id FROM entities e
                    LEFT JOIN memory_entity_mentions m ON m.entity_id = e.id
                    GROUP BY e.id HAVING COUNT(m.entity_id) <= 1
                )",
                [],
            )?;
            Ok(serde_json::json!(count))
        })
        .await;

    match result {
        Ok(count) => {
            let n = count.as_u64().unwrap_or(0) as usize;
            (
                StatusCode::OK,
                Json(repair_result(
                    "prune_singletons",
                    true,
                    n,
                    &format!("{n} singleton entities pruned"),
                )),
            )
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(repair_result("prune_singletons", false, 0, &e.to_string())),
        ),
    }
}

/// POST /api/repair/structural-backfill — re-extract structural features.
pub async fn structural_backfill(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(repair_result(
            "structural_backfill",
            false,
            0,
            "requires LLM provider integration",
        )),
    )
}

/// GET /api/repair/cold-stats — audit cold storage.
pub async fn cold_stats(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let result = state
        .pool
        .read(|conn| {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM memories_cold", [], |r| r.get(0))
                .unwrap_or(0);

            let oldest: Option<String> = conn
                .query_row("SELECT MIN(created_at) FROM memories_cold", [], |r| {
                    r.get(0)
                })
                .ok();

            let newest: Option<String> = conn
                .query_row("SELECT MAX(archived_at) FROM memories_cold", [], |r| {
                    r.get(0)
                })
                .ok();

            Ok(serde_json::json!({
                "count": count,
                "oldest": oldest,
                "newest": newest,
            }))
        })
        .await
        .unwrap_or_else(|_| serde_json::json!({"count": 0}));

    Json(result)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use axum::routing::post;
    use signet_core::config::{AgentIdentity, AgentManifest, DaemonConfig};
    use signet_core::db::DbPool;
    use tempfile::tempdir;
    use tower::ServiceExt;

    use crate::auth::rate_limiter::{AuthRateLimiter, default_limits};
    use crate::auth::types::AuthMode;
    use crate::state::AppState;

    use super::check_fts;

    fn test_state() -> Arc<AppState> {
        let dir = tempdir().expect("tempdir").keep();
        let db = dir.join("memory").join("memories.db");
        let (pool, _writer) = DbPool::open(&db).expect("open db");
        let rules = default_limits();

        Arc::new(AppState::new(
            DaemonConfig {
                base_path: dir,
                db_path: db,
                port: 3850,
                host: "127.0.0.1".to_string(),
                bind: Some("127.0.0.1".to_string()),
                manifest: AgentManifest {
                    agent: AgentIdentity {
                        name: "test-agent".to_string(),
                        description: None,
                        created: None,
                        updated: None,
                    },
                    ..Default::default()
                },
            },
            pool,
            None,
            None,
            None,
            AuthMode::Local,
            None,
            AuthRateLimiter::from_rules(&rules),
            AuthRateLimiter::from_rules(&rules),
        ))
    }

    #[tokio::test]
    async fn check_fts_accepts_empty_post_without_json_content_type() {
        let app = Router::new()
            .route("/api/repair/check-fts", post(check_fts))
            .with_state(test_state());

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repair/check-fts")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("send request");

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("json body");

        assert_eq!(json["action"], "check_fts");
        assert_eq!(json["success"], true);
    }
}
