/**
 * Shared JSON recovery and parsing helpers.
 *
 * These utilities are consumed across the daemon pipeline (reranker,
 * skill enrichment, contradiction, dreaming) and by ontology modules.
 * They deliberately contain no extraction-specific logic; the retired
 * `extractFactsAndEntities` chain was removed and its callers now go
 * through the audited Dreaming apply path.
 */

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;
const THINK_RE = /<think>[\s\S]*?<\/think>\s*/g;
const TRAILING_COMMA_RE = /,\s*([}\]])/g;

export function stripFences(raw: string): string {
	// Strip <think> blocks from models that use chain-of-thought (qwen3, etc.)
	const stripped = raw.replace(THINK_RE, "");
	const match = stripped.match(FENCE_RE);
	if (match) return match[1].trim();

	// Fallback: extract balanced JSON array from verbose output
	// (handles "explanation then JSON" pattern common with qwen3)
	const arr = extractBalancedJsonArray(stripped);
	if (arr) return arr;

	// Strip leading non-JSON text before the first '{'.
	// Handles models (Copilot, GPT) that prefix JSON with explanatory prose.
	const trimmed = stripped.trim();
	const brace = trimmed.indexOf("{");
	if (brace > 0) {
		return trimmed.slice(brace);
	}

	return trimmed;
}

export function tryParseJson(candidate: string): unknown | null {
	const trimmed = candidate.trim();
	if (!trimmed) return null;

	const attempts = [trimmed, trimmed.replace(TRAILING_COMMA_RE, "$1")];
	for (const attempt of attempts) {
		try {
			const parsed = JSON.parse(attempt);
			if (typeof parsed === "string") {
				try {
					return JSON.parse(parsed);
				} catch {
					return parsed;
				}
			}
			return parsed;
		} catch {
			// try next candidate
		}
	}

	return null;
}

export function extractBalancedJsonObjects(raw: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inString = false;
	let escaping = false;
	let start = -1;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === "\\") {
				escaping = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		}
		if (ch === "}") {
			depth--;
			if (depth === 0 && start >= 0) {
				out.push(raw.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return out;
}

export function extractBalancedJsonObject(raw: string): string | null {
	const list = extractBalancedJsonObjects(raw);
	return list.length > 0 ? list[0] : null;
}

/**
 * Find the last top-level JSON array in a string. Scans forward with
 * string-awareness, recording every depth-0 '[' position, then extracts
 * the balanced array starting from the last one. This handles both:
 * - brackets in explanation text before JSON: "options: [a,b] ... [{...}]"
 * - brackets inside JSON strings: [{"reason":"uses [auth]"}]
 */
export function extractBalancedJsonArray(raw: string): string | null {
	// Pass 1: find the last top-level '[' (not inside a quoted string)
	let last = -1;
	let depth = 0;
	let inString = false;
	let escaping = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === "\\") {
				escaping = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "[") {
			if (depth === 0) last = i;
			depth++;
		}
		if (ch === "]") depth--;
	}

	if (last < 0) return null;

	// Pass 2: extract balanced array from the last top-level '['
	depth = 0;
	inString = false;
	escaping = false;

	for (let i = last; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === "\\") {
				escaping = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "[") depth++;
		if (ch === "]") {
			depth--;
			if (depth === 0) return raw.slice(last, i + 1);
		}
	}

	return null;
}
