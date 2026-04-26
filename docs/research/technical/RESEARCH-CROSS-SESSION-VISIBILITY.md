---
id: RESEARCH-CROSS-SESSION-VISIBILITY
question: "How should Signet expose live and historical cross-session visibility without flooding prompt context or violating scope boundaries?"
status: adopted
updated: 2026-04-26
---

# Cross-Session Visibility Research

## Question

How should Signet expose live and historical cross-session visibility without
flooding prompt context or violating scope boundaries?

## Reference

Hermes Agent provides a useful reference pattern. It separates cheap session
awareness from deeper transcript search. The default path can list recent or
active sessions with lightweight metadata, while deeper search is an explicit
tool call that searches stored session transcripts, groups by session, excludes
the current lineage, and summarizes only the matching sessions.

The important design lesson is not the specific implementation language. It is
the shape of the interface: agents should first know that other sessions exist,
which app or surface they are in, and whether they are likely relevant. Only
then should they spend context or model calls on transcript search.

## Adopted Direction

Signet should keep prompt-submit visibility compact and live. Prompt-submit may
surface the number of active peer sessions, the apps those sessions are in, and
which sessions share the current project. This should stay cheap, bounded, and
safe by default.

Deeper cross-session work should move into explicit tools and APIs. A future
session browser/search surface should list recent and live sessions first, then
allow scoped search over summaries and transcripts. Ongoing transcript search
must respect agent scope, visibility, project boundaries, and session lineage.

## Requirements Captured

- Prompt-submit visibility is a hint, not the full browser.
- Active peer visibility should include app identity, not only raw harness name.
- Session search should support live sessions, recent sessions, summaries, and
  transcript excerpts under policy.
- Cross-session transcript search needs explicit RBAC and project/agent scope
  controls before broad rollout.
- Prompt budget and display limits must be configurable so many active agents do
  not produce noisy context.

