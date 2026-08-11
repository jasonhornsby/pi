import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentSession } from "../core/agent-session.ts";
import {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	SessionImportFileNotFoundError,
} from "../core/agent-session-runtime.ts";
import type { ProjectTrustContext, ReplacedSessionContext } from "../core/extensions/index.ts";
import { emitSessionShutdownEvent } from "../core/extensions/runner.ts";
import { assertSessionCwdExists } from "../core/session-cwd.ts";
import { SessionManager } from "../core/session-manager.ts";
import { resolvePath } from "../utils/paths.ts";

/**
 * MultiplexerRuntime — parallel-session runtime for pi.
 *
 * Extends AgentSessionRuntime but, instead of tearing down the current session
 * on /new, /resume, /fork and /import, it keeps every session alive in a map
 * and only changes which one is active. Background sessions keep streaming,
 * executing tools, and persisting to their own JSONL files. Switching tabs
 * re-binds the UI through the existing setRebindSession machinery.
 *
 * New API on top of the host interface:
 *   - listSessions(): snapshot of open tabs
 *   - activateSession(id): switch to an already-open session
 *   - closeSession(id): dispose a session (never the last one)
 *   - activeSessionId: current tab id
 */
interface SessionEntry {
	session: AgentSession;
	services: AgentSessionServices;
	sessionManager: SessionManager;
	diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	modelFallbackMessage?: string;
}

export interface SessionSummary {
	id: string;
	name: string;
	cwd: string;
	sessionFile?: string;
	isActive: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	messageCount: number;
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

export class MultiplexerRuntime extends AgentSessionRuntime {
	private readonly sessions = new Map<string, SessionEntry>();
	private activeId: string;
	private readonly runtimeFactory: CreateAgentSessionRuntimeFactory;
	private rebind?: (session: AgentSession) => Promise<void>;
	private beforeInvalidate?: () => void;

	constructor(
		initial: CreateAgentSessionRuntimeResult,
		runtimeFactory: CreateAgentSessionRuntimeFactory,
		initialSessionManager: SessionManager,
	) {
		super(initial.session, initial.services, runtimeFactory, initial.diagnostics, initial.modelFallbackMessage);
		this.runtimeFactory = runtimeFactory;
		this.activeId = initial.session.sessionId;
		this.sessions.set(this.activeId, {
			session: initial.session,
			services: initial.services,
			sessionManager: initialSessionManager,
			diagnostics: initial.diagnostics,
			modelFallbackMessage: initial.modelFallbackMessage,
		});
	}

	override get session(): AgentSession {
		return this.sessions.get(this.activeId)!.session;
	}

	override get services(): AgentSessionServices {
		return this.sessions.get(this.activeId)!.services;
	}

	override get cwd(): string {
		return this.services.cwd;
	}

	override get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this.sessions.get(this.activeId)!.diagnostics;
	}

	override get modelFallbackMessage(): string | undefined {
		return this.sessions.get(this.activeId)!.modelFallbackMessage;
	}

	override setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebind = rebindSession;
		super.setRebindSession(rebindSession);
	}

	override setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeInvalidate = beforeSessionInvalidate;
		super.setBeforeSessionInvalidate(beforeSessionInvalidate);
	}

	// --- multiplexer API -----------------------------------------------------

	get activeSessionId(): string {
		return this.activeId;
	}

	listSessions(): SessionSummary[] {
		return [...this.sessions.values()].map((entry, index) => ({
			id: entry.session.sessionId,
			name:
				entry.session.sessionName ??
				(entry.session.sessionFile
					? basename(entry.session.sessionFile).replace(/\.jsonl$/, "")
					: `session ${index + 1}`),
			cwd: entry.services.cwd,
			sessionFile: entry.session.sessionFile ?? undefined,
			isActive: entry.session.sessionId === this.activeId,
			isStreaming: entry.session.isStreaming,
			isCompacting: entry.session.isCompacting,
			messageCount: entry.session.messages.length,
		}));
	}

	/** Switch to an already-open session without creating anything. */
	async activateSession(id: string): Promise<{ cancelled: boolean }> {
		if (!this.sessions.has(id)) {
			throw new Error(`No open session with id ${id}`);
		}
		if (id === this.activeId) {
			return { cancelled: false };
		}
		this.beforeInvalidate?.();
		this.activeId = id;
		await this.finishSessionReplacementMux();
		return { cancelled: false };
	}

	/** Close an open session. The last session can never be closed. */
	async closeSession(id: string): Promise<{ cancelled: boolean }> {
		const entry = this.sessions.get(id);
		if (!entry) {
			return { cancelled: false };
		}
		if (this.sessions.size === 1) {
			throw new Error("Cannot close the last open session");
		}
		const wasActive = id === this.activeId;
		await emitSessionShutdownEvent(entry.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
			targetSessionFile: this.session.sessionFile,
		});
		this.beforeInvalidate?.();
		entry.session.dispose();
		this.sessions.delete(id);
		if (wasActive) {
			this.activeId = [...this.sessions.keys()][0]!;
			await this.finishSessionReplacementMux();
		}
		return { cancelled: false };
	}

	// --- session replacement API (same shapes as AgentSessionRuntime) --------

	override async newSession(
		options: {
			parentSession?: string;
			setup?: (sessionManager: SessionManager) => Promise<void>;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		} = {},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitchMux("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		const previousSessionFile = this.session.sessionFile;
		const current = this.sessions.get(this.activeId)!;
		const sessionDir = current.sessionManager.getSessionDir();
		const sessionManager = current.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}
		// NOTE: no teardown — the previous session keeps running in the background.
		const result = await this.runtimeFactory({
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
		});
		if (options.setup) {
			await options.setup(result.session.sessionManager);
			result.session.agent.state.messages = result.session.sessionManager.buildSessionContext().messages;
		}
		this.register(result, sessionManager);
		this.activeId = result.session.sessionId;
		await this.finishSessionReplacementMux(options.withSession);
		return { cancelled: false };
	}

	/**
	 * Switch to a session. If the target is already open (by sessionId or file
	 * path), activate it. Otherwise open the file as a new tab.
	 */
	override async switchSession(
		sessionPath: string,
		options: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		} = {},
	): Promise<{ cancelled: boolean }> {
		const resolved = resolvePath(sessionPath);
		const open = [...this.sessions.values()].find(
			(entry) =>
				entry.session.sessionId === sessionPath ||
				(entry.session.sessionFile && resolvePath(entry.session.sessionFile) === resolved) ||
				(entry.sessionManager.getSessionFile() ?? "") === resolved,
		);
		if (open) {
			return this.activateSession(open.session.sessionId);
		}
		const beforeResult = await this.emitBeforeSwitchMux("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options.cwdOverride);
		assertSessionCwdExists(sessionManager, sessionManager.getCwd());
		const result = await this.runtimeFactory({
			cwd: sessionManager.getCwd(),
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			projectTrustContext: options.projectTrustContextFactory?.(sessionManager.getCwd()),
		});
		this.register(result, sessionManager);
		this.activeId = result.session.sessionId;
		await this.finishSessionReplacementMux(options.withSession);
		return { cancelled: false };
	}

	override async fork(
		entryId: string,
		options: {
			position?: "before" | "at";
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		} = {},
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options.position ?? "before";
		const beforeResult = await this.emitBeforeForkMux(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | undefined;
		let selectedText: string | undefined;
		const current = this.sessions.get(this.activeId)!;
		const selectedEntry = current.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}
		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId ?? undefined;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}
		const previousSessionFile = this.session.sessionFile;
		if (current.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = current.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				const result = await this.runtimeFactory({
					cwd: this.cwd,
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				});
				this.register(result, sessionManager);
				this.activeId = result.session.sessionId;
				await this.finishSessionReplacementMux(options.withSession);
				return { cancelled: false, selectedText };
			}
			if (!existsSync(currentSessionFile)) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			const result = await this.runtimeFactory({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			});
			this.register(result, sessionManager);
			this.activeId = result.session.sessionId;
			await this.finishSessionReplacementMux(options.withSession);
			return { cancelled: false, selectedText };
		}
		// In-memory session: branch in place.
		const sessionManager = current.sessionManager;
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		const result = await this.runtimeFactory({
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
		});
		this.register(result, sessionManager);
		this.activeId = result.session.sessionId;
		await this.finishSessionReplacementMux(options.withSession);
		return { cancelled: false, selectedText };
	}

	override async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}
		const sessionDir = this.session.sessionManager.getSessionDir();
		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitchMux("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		const previousSessionFile = this.session.sessionFile;
		if (resolve(destinationPath) !== resolvedPath) {
			const { mkdirSync, copyFileSync } = await import("node:fs");
			mkdirSync(sessionDir, { recursive: true });
			copyFileSync(resolvedPath, destinationPath);
		}
		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, sessionManager.getCwd());
		const result = await this.runtimeFactory({
			cwd: sessionManager.getCwd(),
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
		});
		this.register(result, sessionManager);
		this.activeId = result.session.sessionId;
		await this.finishSessionReplacementMux();
		return { cancelled: false };
	}

	override async dispose(): Promise<void> {
		for (const entry of this.sessions.values()) {
			await emitSessionShutdownEvent(entry.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
		}
		this.beforeInvalidate?.();
		for (const entry of this.sessions.values()) {
			entry.session.dispose();
		}
		// Keep the map intact: getters are still used during mode shutdown
		// (mirrors AgentSessionRuntime, which leaves its fields set after dispose).
		// Sessions are disposed; the map is just a registry.
	}

	// --- internals -----------------------------------------------------------

	private register(result: CreateAgentSessionRuntimeResult, sessionManager: SessionManager): SessionEntry {
		const entry: SessionEntry = {
			session: result.session,
			services: result.services,
			sessionManager,
			diagnostics: result.diagnostics,
			modelFallbackMessage: result.modelFallbackMessage,
		};
		this.sessions.set(entry.session.sessionId, entry);
		return entry;
	}

	private async finishSessionReplacementMux(
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
	): Promise<void> {
		if (this.rebind) {
			await this.rebind(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	private async emitBeforeSwitchMux(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}
		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeForkMux(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}
		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}
}
