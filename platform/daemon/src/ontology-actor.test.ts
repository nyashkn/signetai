import { describe, expect, it } from "bun:test";
import { DESTRUCTIVE_ONTOLOGY_OPERATIONS, mayApplyOntologyOperation, resolveOntologyActor } from "./ontology-actor";

describe("ontology actor policy", () => {
	it("takes the identity from a verified token and ignores what the body claims", () => {
		// The defect this exists for: routes read `body.actor ?? x-signet-actor ??
		// "operator"` and nowhere else, so the audit trail recorded a claim rather
		// than a fact and anyone could name themselves the operator.
		const caller = resolveOntologyActor({
			claims: { sub: "api-key:7f2", role: "agent" },
			headerActor: "operator",
			headerActorType: "operator",
			bodyActor: "operator",
		});

		expect(caller).toEqual({
			actor: "api-key:7f2",
			role: "agent",
			verified: true,
			mayApplyDestructive: false,
		});
	});

	it("honours an unverified claim downward but never upward", () => {
		// "I am an agent" is a claim against interest, so it is believed.
		const agent = resolveOntologyActor({ headerActor: "mcp-server", headerActorType: "harness" });
		expect(agent.role).toBe("agent");
		expect(agent.mayApplyDestructive).toBe(false);
		expect(agent.verified).toBe(false);

		// "I am the operator" is believed only because in `local` mode the host
		// itself is the trust boundary — but `verified` stays false so the audit
		// never overstates what it knows.
		const operator = resolveOntologyActor({ headerActor: "dashboard", headerActorType: "operator" });
		expect(operator.mayApplyDestructive).toBe(true);
		expect(operator.verified).toBe(false);
	});

	it("gates only the operations that cannot be undone by archiving", () => {
		const agent = resolveOntologyActor({ headerActorType: "harness" });

		// Additive and reversible applies for anyone — the apply-first doctrine,
		// and an alias is its canonical example.
		expect(mayApplyOntologyOperation(agent, "create_entity_alias")).toBe(true);
		expect(mayApplyOntologyOperation(agent, "add_claim_value")).toBe(true);

		for (const operation of DESTRUCTIVE_ONTOLOGY_OPERATIONS) {
			expect({ operation, allowed: mayApplyOntologyOperation(agent, operation) }).toEqual({
				operation,
				allowed: false,
			});
		}
	});

	it("names the caller rather than falling back to 'operator' when it can", () => {
		expect(resolveOntologyActor({ bodyActor: "dashboard" }).actor).toBe("dashboard");
		expect(resolveOntologyActor({ headerActor: "signet-cli" }).actor).toBe("signet-cli");
		// Header before body. Neither is proof, but the body field is precisely
		// what a caller reaches for to file its work under someone else's name.
		expect(resolveOntologyActor({ bodyActor: "operator", headerActor: "mcp-server" }).actor).toBe("mcp-server");
		expect(resolveOntologyActor({}).actor).toBe("operator");
		// With nothing to go on, the recorded name is the role — never a more
		// authoritative-sounding default than the caller earned.
		expect(resolveOntologyActor({ headerActorType: "harness" }).actor).toBe("agent");
	});

	it("treats a readonly token as unable to destroy anything", () => {
		const readonly = resolveOntologyActor({ claims: { sub: "api-key:ro", role: "readonly" } });
		expect(readonly.mayApplyDestructive).toBe(false);
		expect(mayApplyOntologyOperation(readonly, "merge_entities")).toBe(false);
	});
});
