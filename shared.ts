import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/** Where the child runs in Rex; replaced on every (re)launch. */
	rex?: RexPlacement;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface RexPlacement {
	sessionId: string;
	windowId: string;
	/** Terminal block running the child pi; it closes when the child exits. */
	blockId: string;
	/** True when the run has a dedicated session (spawned outside Rex), which is killed with the run. */
	ownsSession: boolean;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

function isRexPlacement(value: unknown): value is RexPlacement {
	if (typeof value !== "object" || value === null) return false;
	const placement = value as Record<string, unknown>;
	return (
		typeof placement.sessionId === "string" &&
		typeof placement.windowId === "string" &&
		typeof placement.blockId === "string" &&
		typeof placement.ownsSession === "boolean"
	);
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			(metadata.rex !== undefined && !isRexPlacement(metadata.rex)) ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

interface RexResult {
	ok: boolean;
	stdout: string;
	error: string;
}

/**
 * Run the Rex CLI. Queries and teardown pass `--autostart=false` so that inspecting or stopping a run
 * never starts a Rex server; only launching a run may start one.
 */
function rex(args: string[], options: { autostart?: boolean } = {}): RexResult {
	const result = spawnSync("rex", [...(options.autostart ? [] : ["--autostart=false"]), ...args], {
		encoding: "utf8",
	});
	if (result.error) {
		const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
		return { ok: false, stdout: "", error: missing ? "rex CLI not found on PATH" : result.error.message };
	}
	return { ok: result.status === 0, stdout: result.stdout, error: result.stderr.trim() };
}

function rexJson(args: string[], options: { autostart?: boolean } = {}): Record<string, unknown> {
	const result = rex(args, options);
	if (!result.ok) throw new Error(result.error || `rex ${args[0]} failed`);
	const value: unknown = JSON.parse(result.stdout);
	if (typeof value !== "object" || value === null) throw new Error(`rex ${args[0]} returned unexpected output`);
	return value as Record<string, unknown>;
}

export function runTitle(metadata: RunMetadata): string {
	return `subagent ${metadata.name ?? metadata.handle}`;
}

/** IDs of every live Rex block. A terminal block closes when its child exits, so a live block means a live child. */
export function liveRexBlocks(): Set<string> {
	const result = rex(["block", "ls", "--all", "--quiet", "--short=false"]);
	return new Set(result.ok ? result.stdout.split("\n").filter(Boolean) : []);
}

export function isRunAlive(metadata: RunMetadata, liveBlocks: Set<string> = liveRexBlocks()): boolean {
	return metadata.rex !== undefined && liveBlocks.has(metadata.rex.blockId);
}

/** Command a user can run to look at the child's TUI. */
export function rexViewCommand(metadata: RunMetadata): string {
	if (!metadata.rex) return "(not running)";
	const { sessionId, blockId, ownsSession } = metadata.rex;
	return ownsSession ? `rex attach ${sessionId}` : `rex focus --session ${sessionId} ${blockId}`;
}

/** Keep the Rex tab label in sync with the run name. */
export function relabelRexWindow(metadata: RunMetadata): void {
	if (!metadata.rex) return;
	rex(["window", "rename", "--session", metadata.rex.sessionId, metadata.rex.windowId, runTitle(metadata)]);
}

/** Terminate the child by closing its block (and the session, when the run owns it). */
export function closeRexRun(metadata: RunMetadata): void {
	if (!metadata.rex) return;
	const { sessionId, blockId, ownsSession } = metadata.rex;
	if (ownsSession) {
		rex(["kill", sessionId]);
		return;
	}
	rex(["api", "call", "block.close", JSON.stringify({ session_id: sessionId, block_id: blockId })]);
}

/** Variables that describe the parent's terminal, multiplexer, or Pi session rather than the child's. */
function forwardEnvVar(key: string): boolean {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
	if (/^(REX_|TMUX|TERM|ITERM_|KITTY_|GHOSTTY_|WEZTERM_)/.test(key)) return false;
	return ![
		"COLORTERM",
		"PWD",
		"OLDPWD",
		"SHLVL",
		"_",
		"__CFBundleIdentifier",
		"PI_CODING_AGENT",
		"PI_SESSION_ID",
		"PI_SESSION_FILE",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
		"PI_SUBAGENT_RUN_DIR",
	].includes(key);
}

/**
 * Start the child pi process for a run and record where it lives in Rex. `initialArgs` are only passed on
 * first spawn.
 *
 * Inside Rex (`REX_SESSION` set), the child opens as a background tab in the caller's session. Otherwise it
 * gets a dedicated `pi-subagent-<handle>` session that closes when the child exits.
 */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): RunMetadata {
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	const launcher = isExecutable(testLauncher) ? testLauncher : "pi";
	const piCommand = [
		launcher,
		"--session",
		metadata.sessionFile,
		"--provider",
		metadata.provider,
		"--model",
		metadata.model,
		"--thinking",
		metadata.thinking,
		...(metadata.launchArgs ?? []),
		...initialArgs,
	]
		.map(shellQuote)
		.join(" ");

	const parentSession = process.env.REX_SESSION;
	const ownsSession = !parentSession;
	const sessionId =
		parentSession ??
		String(
			rexJson(["api", "call", "session.create", JSON.stringify({ label: `pi-subagent-${metadata.handle}` })], {
				autostart: true,
			}).session_id,
		);

	// Rex starts commands with its server's environment, so the caller's environment (PATH, credentials,
	// PI_CODING_AGENT_DIR, ...) is forwarded through a launch script that deletes itself on start, keeping
	// secrets out of argv and off disk. A dedicated session would linger without windows after the child
	// exits, so the script closes it.
	const exports = Object.entries(process.env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined && forwardEnvVar(entry[0]))
		.map(([key, value]) => `export ${key}=${shellQuote(value)}`);
	const script = [
		"#!/bin/sh",
		'rm -f -- "$0"',
		...exports,
		`export PI_SUBAGENT_RUN_DIR=${shellQuote(metadata.runDir)}`,
		...(ownsSession
			? [piCommand, "status=$?", `rex --autostart=false kill ${sessionId} >/dev/null 2>&1`, 'exit "$status"']
			: [`exec ${piCommand}`]),
		"",
	].join("\n");
	const scriptPath = join(metadata.runDir, `launch-${process.pid}-${Date.now()}.sh`);
	writeFileSync(scriptPath, script, { encoding: "utf8", mode: 0o700 });

	const title = runTitle(metadata);
	let placed: Record<string, unknown>;
	try {
		placed = rexJson(
			[
				"run",
				"--session",
				sessionId,
				"--focus=false",
				"--json",
				"--shell=none",
				"--cwd",
				metadata.cwd,
				"--label",
				title,
				"--",
				"/bin/sh",
				scriptPath,
			],
			{ autostart: true },
		);
	} catch (error) {
		rmSync(scriptPath, { force: true });
		if (ownsSession) rex(["kill", sessionId]);
		throw error;
	}
	const windowId = placed.window_id;
	const blockId = Array.isArray(placed.block_ids) ? placed.block_ids[0] : undefined;
	if (typeof windowId !== "string" || typeof blockId !== "string") throw new Error("rex run returned no block");

	const next =
		updateMetadata(metadata.runDir, { rex: { sessionId, windowId, blockId, ownsSession } }) ??
		({ ...metadata, rex: { sessionId, windowId, blockId, ownsSession } } satisfies RunMetadata);
	relabelRexWindow(next);
	return next;
}

export function effectiveRunState(metadata: RunMetadata, liveBlocks?: Set<string>): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!isRunAlive(metadata, liveBlocks)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
