# Dreaming Skill Runbook

Dreaming is the single automatic path from immutable episodic evidence to
audited semantic memory. It reads selected artifacts, transcripts, summaries,
compactions, and checkpoints; it does not rewrite them. The worker emits
provenance-backed ontology operations through the shared daemon-owned writer.

## Worker Path

Inspect the current graph write gates and worker state:

```bash
signet ontology pipeline explain --json
signet dream status
signet dream trigger
signet dream trigger --compact
```

Invalid or rejected operations are recorded without stalling the selected
evidence cursor. Use an ontology proposal only for broad or explicitly reviewed
semantic refactors.

## Epistemic Assertion Path

Use epistemic assertions when the source records who claimed, believed,
observed, decided, preferred, denied, or questioned something. Assertions keep
attribution and provenance without making the assertion current ontology truth.

```bash
signet ontology assertion create \
  --entity "Signet" \
  --predicate claims \
  --speaker "Nicholai" \
  --content "Signet should preserve attributed claims separately from current truth." \
  --confidence 0.91 \
  --source-kind transcript \
  --source-id session-key
```

For batches, write `{ "assertions": [...] }` JSON and run:

```bash
signet ontology assertion import --file assertions.json --json
```

Inspect versioned claim evidence:

```bash
signet ontology claim versions <entity> <aspect> <group> <claim> --json
signet ontology claim show <entity> <aspect> <group> <claim> --version 1 --json
signet ontology claim-evidence <entity> <aspect> <group> <claim> --status all --json
```

## Entity Merge Path

Use direct audited merges for clear duplicate cleanup:

```bash
signet ontology entity merge "Canonical Entity" "Duplicate Entity" \
  --reason "Same source-backed entity after canonicalization" \
  --evidence-file evidence.json \
  --json
```

Use merge planning to inspect impact or to prepare a broad graph-refactor
proposal:

```bash
signet ontology entity merge-plan "Canonical Entity" "Duplicate Entity" --json
signet ontology entity merge-plan "Canonical Entity" "Duplicate Entity" --propose --json
```

## Refactor Proposal Path

Use pending proposals when a human wants a durable review queue for massive
knowledge-graph refactors, risky/destructive changes, or broad merge campaigns:

```bash
signet ontology extract --from transcript:<session-key> --json
signet ontology consolidate --proposals pending --json
signet ontology stream apply proposals.jsonl --propose --json
signet ontology apply <proposal-id> --actor operator --json
signet ontology reject <proposal-id> --reason "weak evidence" --actor operator --json
```

## Rules

- Dreaming never rewrites episodic artifacts, transcripts, or summaries.
- Dreaming is the only automatic episodic-to-semantic writer.
- All semantic changes use audited ontology operation handlers.
- Ambiguous generated output is discarded and recorded as a failed operation.
- Pending proposals are for broad graph refactors and explicit review queues,
  not routine Dreaming consolidation.
- Use epistemic assertions for attributed statements that should not become
  current truth yet.
