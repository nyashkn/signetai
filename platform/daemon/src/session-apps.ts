export function formatSessionAppLabel(harness: string): string {
	const normalized = harness
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, "-");
	const labels: Record<string, string> = {
		"claude-code": "Claude Code",
		claude: "Claude Code",
		codex: "Codex",
		gemini: "Gemini",
		hermes: "Hermes Agent",
		"hermes-agent": "Hermes Agent",
		openclaw: "OpenClaw",
		opencode: "OpenCode",
		pi: "Pi",
	};
	if (labels[normalized]) return labels[normalized];
	return (
		harness
			.replace(/[\r\n`*#[\]<>]/g, " ")
			.replace(/\s+/g, " ")
			.trim() || "Unknown app"
	);
}
