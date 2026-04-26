---
id: cross-session-visibility-and-search
status: planning
title: Cross-Session Visibility and Search
informed_by:
  - docs/research/technical/RESEARCH-CROSS-SESSION-VISIBILITY.md
---

# Cross-Session Visibility and Search

## Problem

Signet now has canonical JSONL transcripts and live cross-agent presence, but
the agent experience is still too thin. Agents can miss that related work is
happening in another active session, and there is no first-class equivalent of
a session browser that starts with cheap metadata and escalates to scoped
transcript or summary search only when needed.

## Direction

The prompt-submit hook should remain lightweight. It can show bounded peer
session visibility from a durable session registry: how many peer sessions are
active, which app or harness they are in, whether any share the current project,
and which MCP tools can inspect or coordinate with them. Live presence is only
a cache over the registry, not the source of truth.

Canonical JSONL transcripts are the transcript substrate. Prompt-submit appends
live turns, session-end replaces the final session slice, and the registry keeps
the session lifecycle pointer: app identity, project, started/last-seen/ended
times, status, end reason, and transcript location. A session without a stable
session key or session id can be shown as ephemeral live presence, but should
not become durable history until the harness provides a stable identifier.

The deeper surface should be explicit. A future MCP/API layer should support a
session browser and session search flow that can list live sessions, list recent
sessions, search summaries, and search transcript excerpts. Search must exclude
or de-emphasize the current lineage unless explicitly requested.

## Open Requirements

1. Add a configurable prompt budget and display limit for live peer visibility.
2. Keep explicit app identity metadata in the durable session registry, with
   live presence as a short-lived cache for coordination.
3. Use canonical JSONL transcript paths as the transcript pointer for active and
   ended sessions.
4. Add a scoped session browser/search MCP tool for live and historical sessions.
5. Support ongoing transcript search for active sessions where canonical JSONL
   has live prompt-submit turns before session-end.
6. Enforce agent scope, memory visibility, project boundaries, and lineage rules
   before exposing transcript search broadly.
7. Document the fallback hierarchy: live peer metadata first, recent session
   metadata second, summary search third, transcript search last.

## Success Criteria

- Agents see compact live peer-session visibility during prompt-submit without
  materially increasing prompt noise.
- Agents can explicitly list recent and active sessions with app, project, age,
  lifecycle status, end reason, and canonical transcript pointer.
- Agents can search session summaries and transcript excerpts under the same
  agent scope and visibility rules as memory recall.
- Ongoing transcript search reads from canonical JSONL or derived transcript
  indexes and cannot expose another agent's private session data across policy
  boundaries.
- Operators can tune or disable prompt-submit peer visibility separately from
  explicit session search.
