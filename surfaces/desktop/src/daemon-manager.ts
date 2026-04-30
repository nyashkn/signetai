import { resolve } from "node:path";
import { type WorkspaceMismatch, healthWorkspaceMismatch } from "./daemon-workspace.js";

export interface HealthStatus {
	readonly version: string;
	readonly pid: number;
	readonly uptime: number;
	readonly agentsDir: string | null;
}

export interface DesktopDaemonStatus {
	readonly running: boolean;
	readonly pid: number | null;
	readonly version: string | null;
	readonly uptime: number | null;
	readonly port: number;
	readonly baseUrl: string;
	readonly workspacePath: string;
	readonly mismatch: WorkspaceMismatch | null;
}

export interface DaemonManagerOptions {
	readonly workspacePath: string;
}

function readPort(): number {
	const parsed = Number.parseInt(process.env.SIGNET_PORT ?? "3850", 10);
	return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3850;
}

function controllerSignal(ms: number): { readonly signal: AbortSignal; readonly cancel: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return {
		signal: controller.signal,
		cancel: () => clearTimeout(timer),
	};
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export class DaemonManager {
	readonly port = readPort();
	readonly baseUrl = `http://localhost:${this.port}`;
	readonly #workspacePath: string;
	#lastMismatch: WorkspaceMismatch | null = null;

	constructor(options: DaemonManagerOptions) {
		this.#workspacePath = resolve(options.workspacePath);
		process.env.SIGNET_DESKTOP_DAEMON_BASE_URL = this.baseUrl;
	}

	async probe(timeoutMs = 1200): Promise<HealthStatus | null> {
		const health = await this.#probeRaw(timeoutMs);
		const mismatch = health ? healthWorkspaceMismatch(this.#workspacePath, health.agentsDir) : null;
		this.#lastMismatch = mismatch;
		return mismatch ? null : health;
	}

	getMismatch(): WorkspaceMismatch | null {
		return this.#lastMismatch;
	}

	async #probeRaw(timeoutMs = 1200): Promise<HealthStatus | null> {
		const { signal, cancel } = controllerSignal(timeoutMs);
		try {
			const response = await fetch(`${this.baseUrl}/health`, { signal });
			if (!response.ok) return null;
			const data = (await response.json()) as Record<string, unknown>;
			const pid = numberOrNull(data.pid);
			return {
				version: stringOrNull(data.version) ?? "unknown",
				pid: pid ?? 0,
				uptime: numberOrNull(data.uptime) ?? 0,
				agentsDir: stringOrNull(data.agentsDir),
			};
		} catch {
			return null;
		} finally {
			cancel();
		}
	}

	async status(): Promise<DesktopDaemonStatus> {
		const health = await this.probe();
		return {
			running: health !== null,
			pid: health?.pid ?? null,
			version: health?.version ?? null,
			uptime: health?.uptime ?? null,
			port: this.port,
			baseUrl: this.baseUrl,
			workspacePath: this.#workspacePath,
			mismatch: this.#lastMismatch,
		};
	}

	// TODO: remove after main.ts is updated
	async start(): Promise<DesktopDaemonStatus> {
		await this.probe();
		return this.status();
	}

	// TODO: remove after main.ts is updated
	async stop(): Promise<DesktopDaemonStatus> {
		await this.probe();
		return this.status();
	}

	// TODO: remove after main.ts is updated
	async restart(): Promise<DesktopDaemonStatus> {
		await this.probe();
		return this.status();
	}
}
