// @ts-nocheck
import { describe, expect, it } from "bun:test";
import type { TouchedItemRecord } from "$lib/api";
import { groupTouchedBySource, touchedTitle } from "./identity-panel-data";

function item(overrides: Partial<TouchedItemRecord>): TouchedItemRecord {
	return {
		entityId: "ent-1",
		name: "Sales Cycle Time",
		entityType: "source_document",
		relation: "authored_by",
		strength: 1,
		sourceKind: "source_email_message",
		sourcePath: "email://pivotplanit/Inbox/messages/x",
		occurredAt: "2026-07-10T09:00:00.000Z",
		deepLink: "message://%3cm1%40dock-blocks.com%3e",
		...overrides,
	};
}

describe("identity panel", () => {
	it("leads with the deep-linked source and sinks the extraction bucket", () => {
		// The extraction bucket is the larger one on the live corpus, and it is
		// exactly the one a reviewer cannot follow — size must not float it.
		const groups = groupTouchedBySource([
			item({ entityId: "a", sourceKind: null, deepLink: null }),
			item({ entityId: "b", sourceKind: null, deepLink: null }),
			item({ entityId: "c", sourceKind: null, deepLink: null }),
			item({ entityId: "d" }),
		]);

		expect(groups.map((group) => group.label)).toEqual(["Email", "Extracted from memories"]);
		expect(groups[0].items).toHaveLength(1);
		expect(groups[1].items).toHaveLength(3);
	});

	it("keeps the subject and drops the connector's uniqueness suffix", () => {
		// Verbatim from the live corpus: the whole uri is repeated in the name,
		// which ellipsised every row down to "Re: calendly test - source:e...".
		expect(
			touchedTitle(
				"Re: calendly test - source:email:68979d6264dc21ba:document:email://pivotplanit/Inbox/messages/%3Cx%3E",
			),
		).toBe("Re: calendly test");
		expect(touchedTitle("Alecia Nikole Robinson")).toBe("Alecia Nikole Robinson");
		// A name that is only the suffix has nothing better to show than itself.
		expect(touchedTitle(" - source:email:abc")).toBe("- source:email:abc");
	});

	it("shows an unmapped source kind rather than hiding it", () => {
		const groups = groupTouchedBySource([item({ sourceKind: "source_clickup_task" })]);
		expect(groups[0].label).toBe("source_clickup_task");
	});
});
