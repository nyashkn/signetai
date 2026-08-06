import { describe, expect, it } from "bun:test";
import type { OntologyProposalRecord } from "@/lib/ontology-api";
import { proposalEvidenceLines, proposalHeadline } from "./proposal-inbox-data";

function proposal(overrides: Partial<OntologyProposalRecord>): OntologyProposalRecord {
	return {
		id: "prop-1",
		operation: "merge_entities",
		status: "pending",
		payload: {},
		confidence: 0.5,
		rationale: "",
		evidence: [],
		risk: null,
		sourceKind: null,
		sourcePath: null,
		createdBy: "duplicate_entities",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
		...overrides,
	};
}

describe("proposal inbox", () => {
	it("reads an identity merge as target and the spellings folding into it", () => {
		const headline = proposalHeadline(
			proposal({
				payload: {
					target_entity: "westmatt81@gmail.com",
					target_entity_id: "ent-addr",
					source_entities: ["Matt West", "matt@dock-blocks.com", "Matt"],
					source_entity_ids: ["a", "b", "c"],
				},
			}),
		);
		expect(headline).toBe("westmatt81@gmail.com ← Matt West, matt@dock-blocks.com, Matt");
	});

	it("falls back to the payload rather than rendering an empty row", () => {
		// Operations arrive from the daemon as free strings; the inbox must stay
		// readable for one it has never seen, and for a known one missing a key.
		expect(proposalHeadline(proposal({ operation: "attach_interface", payload: { thing: 1 } }))).toBe('{"thing":1}');
		expect(proposalHeadline(proposal({ payload: { target_entity: "A" } }))).toBe('{"target_entity":"A"}');
	});

	it("shows the cited header verbatim with the message it came from", () => {
		const lines = proposalEvidenceLines(
			proposal({
				evidence: [
					{ source_id: "email:<m1@dock-blocks.com>", quote: "From: Matt West <matt@dock-blocks.com>" },
					{ note: "no quote here" },
					"already a string",
				],
			}),
		);
		expect(lines).toEqual([
			"From: Matt West <matt@dock-blocks.com>  —  email:<m1@dock-blocks.com>",
			'{"note":"no quote here"}',
			"already a string",
		]);
	});
});
