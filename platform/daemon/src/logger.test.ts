import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { resolveLoggerConfig } from "./logger";

describe("logger config", () => {
	it("uses SIGNET_PATH for the default daemon log directory", () => {
		expect(resolveLoggerConfig({ SIGNET_PATH: "/tmp/signet-workspace" }, "/home/test")).toEqual({
			logDir: join("/tmp/signet-workspace", ".daemon", "logs"),
		});
	});

	it("keeps explicit log file and log directory overrides ahead of SIGNET_PATH", () => {
		expect(
			resolveLoggerConfig(
				{
					SIGNET_LOG_FILE: "/tmp/signet.log",
					SIGNET_LOG_DIR: "/tmp/logs",
					SIGNET_PATH: "/tmp/signet-workspace",
				},
				"/home/test",
			),
		).toEqual({ logFilePath: "/tmp/signet.log", logDir: "/tmp" });

		expect(
			resolveLoggerConfig(
				{
					SIGNET_LOG_DIR: "/tmp/logs",
					SIGNET_PATH: "/tmp/signet-workspace",
				},
				"/home/test",
			),
		).toEqual({ logDir: "/tmp/logs" });
	});

	it("falls back to the home-scoped agents directory", () => {
		expect(resolveLoggerConfig({}, "/home/test")).toEqual({
			logDir: join("/home/test", ".agents", ".daemon", "logs"),
		});
	});
});
