---
id: knowledge-base-source-sync
title: Knowledge Base Source Sync
status: planning
informed_by:
  - docs/research/technical/RESEARCH-OBSIDIAN-VAULT-RECALL-EVAL.md
  - docs/research/technical/RESEARCH-GITNEXUS-PATTERNS.md
  - docs/research/market/competitive-landscape.md
scope_boundary: "Realtime file, repo, vault, database, and code-index sources for scoped knowledge bases. Google Drive, Google Workspace, Nextcloud, and other remote adapters are deferred."
---

# Knowledge Base Source Sync

## Question

How should Signet keep external knowledge bases current while preserving
agent scoping, provenance, prospective hints, structural knowledge, and
SEC rules?

## Current baseline

The first knowledge-base ingestion pass creates scoped knowledge bases,
per-agent access policies, CLI import, dashboard server-path import, and
one-shot JSON/CSV/text ingestion into the same memory, graph, hint, and
embedding surfaces used by ordinary memories.

That is enough for deliberate import. It is not yet enough for live
source sync.

## Design direction

The watcher work should build on the existing daemon watcher patterns,
but it should become a modular source-sync service rather than adding
more one-off chokidar logic to `daemon.ts`. The closest existing shape is
`native-memory-sources.ts`: it has a source list, per-file indexing,
content hashes, add/change/unlink handling, a poll fallback, and a handle
that can be closed cleanly.

Knowledge-base sync should follow that pattern with source drivers:

- file tree driver for JSON, CSV, Markdown, plain text, and similar local
  files;
- repo and Obsidian vault driver built on the same filesystem watcher
  foundation, with sensible ignore rules and root-relative provenance;
- database driver for read-only SQLite and Postgres table/view ingestion;
- codebase driver backed by the existing GraphIQ plugin instead of
  duplicating symbol, backlink, and call-site indexing in the generic
  importer.

Each source sync should be hash-gated, debounce-safe, and restart-safe.
Adds and changes should upsert records into the owning knowledge base.
Unlinks should mark source records inactive or tombstoned rather than
blindly deleting graph history. Agent allowlists, enabled/disabled state,
and default-agent bootstrap must remain policy gates at retrieval time,
not import-time filters.

## GraphIQ integration boundary

Code knowledge bases should not reimplement GraphIQ. GraphIQ already owns
code symbol search, structural context, constants, and blast-radius
analysis through `signet index`, `/api/graphiq/index`, MCP tools, and the
managed `signet.graphiq` plugin.

The knowledge-base layer should register a scoped code knowledge-base
pointer to the GraphIQ project and preserve Signet policy/provenance
around it. Symbol backlinks and call sites should be served by GraphIQ
tools, while Signet decides whether a given agent may see and use that
indexed project.

## Deferred scope

SQLite and Postgres table ingestion should remain read-only in the first
database pass. It needs a mapping contract before implementation:
primary-key selection, table/view allowlists, cursor or high-water marks,
record text projection, optional explicit entity/aspect mapping, and
bounded polling.

Google Drive, Google Workspace, Nextcloud, and similar remote adapters are
deferred until the local source model is stable. They should plug into the
same source driver contract later.

## Success criteria

- Users can register local folders, repos, and Obsidian vaults as scoped
  knowledge bases and see them update as files change.
- The daemon starts and stops knowledge-base watchers cleanly without
  leaking handles or duplicating in-flight sync work.
- File changes update knowledge-base records only when content or mapping
  changed.
- Removed files become inactive or tombstoned with provenance preserved.
- SQLite and Postgres table ingestion have an approved read-only mapping
  contract before implementation.
- Codebase knowledge bases use GraphIQ for symbols, backlinks, call sites,
  constants, and blast-radius context rather than a second importer.
- All synced knowledge remains subject to the same agent allowlist,
  enabled/disabled, prospective hint, graph, embedding, and SEC policies
  as ordinary memories.
