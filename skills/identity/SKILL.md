---
name: identity
description: "Resolve who is who across email, ClickUp, GitHub and session memory — find the rows that are one person, prove it from the historical record, and link or propose accordingly."
version: 1.0.0
builtin: true
---

# Identity

Use this skill when the graph holds more than one row for the same person or
organization, or when you need to attach a contact detail — an address, a
login, a phone number — to someone.

Signet's graph accretes names from four channels that never agreed with each
other: mail headers key on addresses, ClickUp keys on member emails, GitHub
records a bare login, and extraction mints whatever the prose called them.
`njui`, `KN`, `Jui` and `njui@pivotplanit.com` can all be the same human, filed
four ways. That is normal, not a bug — the job is to say so.

## The model: link, don't merge

`entity_aliases` is the join. A link says "this handle belongs to this entity"
and leaves both rows in place, each keeping its own mentions and provenance.
Identity resolution reads aliases in both directions, so after a link
`knowledge_what_touched` answers the same set from either spelling.

A merge is different: it collapses two rows and **hard-deletes** one. There is
no lineage table, so an approved merge cannot be undone. Merges are for the
operator to approve, never for you to apply.

| You want to say | Use |
|---|---|
| These two spellings are the same identity | `identity_link` |
| That link was wrong | `identity_unlink` |
| These two rows should become one row | `ontology_propose` with `merge_entities` |
| This name is wrong and should change | `ontology_propose` with `rename_entity` |

## The loop

1. **See who a name currently resolves to.** `knowledge_what_touched` with the
   name, address, or id. The response says whether it matched directly or
   through an alias, and returns the whole set. If two spellings return
   disjoint sets, they are not linked yet.
2. **List near-duplicates.** `knowledge_list_entities` with a name fragment.
   Rows carry `aliasCount` and `resolvesToEntityId`; a row with a
   `resolvesToEntityId` is already a known spelling of another identity, so
   leave it alone.
3. **Find the evidence.** `signet_source_search` over the historical record —
   mail, ClickUp comments, notes. What you are looking for is a line that pairs
   the two literally: a `From:` header carrying both a display name and an
   address, a quoted forward block, a signature, or someone saying it outright
   ("he was talking about his outlook account matt@dock-blocks.com"). If you
   cannot find one, `knowledge_trail` on both spellings sometimes shows they
   sit on the same threads.
4. **Act on what the evidence supports.**
   - A literal pairing → `identity_link`, quoting the line in `source`.
   - A strong inference with no literal pairing → `ontology_propose`, with the
     inference in `rationale` and whatever you did find in `evidence`.
   - Nothing → say so and stop. An unfounded link is worse than two rows,
     because it is silent.

## Guards

These come from real rows that broke the graph. Do not link when:

- **The display name is an organization.** `Dock Blocks <matt@dock-blocks.com>`
  is the company signing the mail, not Matt's other name. Linking it makes
  every later lookup of the company resolve to a person.
- **The name is under three characters.** A quoted `Cc:` fragment once produced
  `is` → `is@crmoz.com`, claiming the word "is" as an identity.
- **The handle is already held.** One handle resolves to one entity per agent.
  `identity_link` answers `409` naming the current holder. That is the
  invariant working: check `identity_handles` on the holder, and either unlink
  it there or accept that these are two different people who share a name.
- **The two are named on the same message.** One person's two addresses are
  essentially never both on one envelope. A message carrying both refutes the
  pairing.
- **A role is not a person.** `CEO`, `ambassador`, `sourcing_rep` are typed
  `person` in this graph and are not people. `entity_type` does not tell you
  what is a name — read it.

## Evidence quality

`source` and `evidence` are the whole difference between a link an operator
trusts and one they audit. Cite the literal text and where it came from:

```
source: "From: Matt West <matt@dock-blocks.com> in <CAO-UE0abc123@mail.gmail.com>"
```

Not `"looks like the same person"`. A reviewer reading the second has to redo
your work; a reviewer reading the first is done in two seconds.

## Contact details

An address, a phone number, a GitHub login and a display name are all handles —
link them with the matching `kind` (`email`, `phone`, `github_login`,
`clickup_member`, `discord_id`, `display_name`). Pass `organization` when the
handle belongs to a work identity rather than the person generally; that is what
makes a trail readable as "what we sent Matt, as PivotPlanIt".

Facts that are not handles — a job title, a company someone works for — are
claims, not aliases. Those go through `ontology_propose` with
`add_claim_value`.

## Tools

| Tool | Use |
|---|---|
| `knowledge_what_touched` | Everything a person is attached to, resolved through aliases |
| `knowledge_trail` | Ordered provenance chains, for showing two names share a context |
| `knowledge_list_entities` | Near-duplicates by name fragment, with alias counts |
| `identity_handles` | Every handle one entity answers to, and what asserted each |
| `signet_source_search` | The historical record that proves a pairing |
| `identity_link` / `identity_unlink` | Apply and reverse a link |
| `ontology_propose` | Queue anything destructive for the operator |
