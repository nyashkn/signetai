import type { MigrationDb } from "./contract";

// Fork (nyashkn/signetai) deliberately skips upstream's migration 168, which deletes every Obsidian
// vault paragraph claim and soft-deletes the memories projected from them. The kuze_ds vault is
// recalled through those claims, and Dreaming has thousands of sources still to read, so retiring
// them would drop vault recall for weeks. The version stays registered so numbering matches upstream;
// source sync still stops writing new paragraph claims (upstream 94a447fec), so existing ones go
// stale rather than being refreshed.
export function up(_db: MigrationDb): void {}
