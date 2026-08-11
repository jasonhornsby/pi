import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { ExtensionCommandContext, InlineExtension } from "../core/extensions/index.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SessionManager } from "../core/session-manager.ts";
import type { MultiplexerRuntime } from "./multiplexer-runtime.ts";

/**
 * Exit code that tells the pi-dev wrapper to relaunch pi instead of exiting.
 * The wrapper (pi-dev.sh) stays the shell's foreground job, so a relaunch is
 * seamless: the shell never sees the process exit and job control is untouched.
 */
export const RESTART_EXIT_CODE = 42;

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const BUILD_DIR = join(REPO_ROOT, "packages", "coding-agent");
const DEFAULT_RESTART_ARGS_FILE = join(homedir(), ".pi", "pi-restart-args");

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Mutable state shared with main(): the runtime once created, and the final
 * app mode once main() has settled it (after stdin handling can flip
 * interactive -> print). The command handler reads both at invocation time.
 */
export interface RestartRuntimeRef {
	current: AgentSessionRuntime | MultiplexerRuntime | null;
	mode: AppMode | null;
}

/**
 * Registers a `/restart` command that rebuilds the pi fork and restarts pi.
 * The rebuild runs `npm run build` for the coding-agent package (the fork's
 * runtime) while showing live output in an overlay. On success it writes the
 * active session's resume args to a file the pi-dev wrapper sources, then
 * exits with RESTART_EXIT_CODE. If pi was launched without the wrapper, it
 * just reports the manual restart command instead of exiting.
 *
 * Interactive-only: the build overlay needs TUI UI, and only interactive
 * mode's exit path honors RESTART_EXIT_CODE. In print/json/rpc modes (or
 * before main() has settled the mode) the command refuses instead of running
 * a half-visible build or leaking exit code 42 into a mode that would not
 * relaunch.
 */
export function createRestartExtension(runtimeRef: RestartRuntimeRef): InlineExtension {
	return {
		name: "pi-dev",
		factory: (pi) => {
			pi.registerCommand("restart", {
				description: "Rebuild the pi fork and restart pi",
				handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
					const runtime = runtimeRef.current;
					if (!runtime) {
						ctx.ui.notify("Runtime not available", "error");
						return;
					}
					// Only interactive mode has a TUI to show the build overlay in, and
					// only its exit path honors RESTART_EXIT_CODE (see interactive-mode.ts).
					if (runtimeRef.mode !== "interactive") {
						ctx.ui.notify("/restart is only available in interactive mode", "error");
						return;
					}
					const build = await runBuildWithUi(ctx);
					if (!build.ok) {
						ctx.ui.notify("Rebuild failed — pi was not restarted", "error");
						return;
					}
					const sessionManager = runtime.session.sessionManager;
					writeRestartArgs(sessionManager);
					if (process.env.PI_RESTART_LOOP !== "1") {
						const resume = formatResumeArgs(sessionManager);
						ctx.ui.notify(
							`Rebuilt successfully. Launch pi via the pi-dev wrapper to auto-restart${resume ? ` (resume: ${resume})` : ""}`,
							"info",
						);
						return;
					}
					process.exitCode = RESTART_EXIT_CODE;
					ctx.shutdown();
				},
			});
		},
	};
}

interface BuildResult {
	ok: boolean;
}

/**
 * Runs the fork build in an overlay that streams the output live. On success
 * the overlay closes immediately; on failure it stays open so the errors can
 * be read, and Enter/Esc dismisses it.
 */
function runBuildWithUi(ctx: ExtensionCommandContext): Promise<BuildResult> {
	return ctx.ui.custom<BuildResult>(
		(tui, theme, _keybindings, done) => {
			let settled = false;
			let failed = false;
			let frame = 0;
			const lines: string[] = [];
			const push = (chunk: Buffer) => {
				for (const line of chunk.toString().split("\n")) {
					lines.push(line.trimEnd());
				}
				if (lines.length > 200) lines.splice(0, lines.length - 200);
				tui.requestRender();
			};
			const finish = (result: BuildResult) => {
				if (settled) return;
				settled = true;
				clearInterval(timer);
				done(result);
			};
			const timer = setInterval(() => {
				frame++;
				tui.requestRender();
			}, 100);

			const child = spawn("npm", ["--prefix", BUILD_DIR, "run", "build"], {
				cwd: REPO_ROOT,
				env: { ...process.env, FORCE_COLOR: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout?.on("data", push);
			child.stderr?.on("data", push);
			child.on("error", (error) => {
				lines.push(`[spawn error] ${error.message}`);
				tui.requestRender();
				finish({ ok: false });
			});
			child.on("close", (code) => {
				lines.push("", `Build finished with exit code ${code ?? "?"}`);
				tui.requestRender();
				if (code === 0) {
					finish({ ok: true });
				} else {
					failed = true;
					clearInterval(timer);
					tui.requestRender();
				}
			});

			return {
				render: (width: number) => {
					const accent = (text: string) => theme.fg("accent", text);
					const status = failed
						? theme.fg("error", "✗ build failed")
						: `rebuilding ${SPINNER[frame % SPINNER.length]}`;
					const title = accent(theme.bold(`pi-dev /restart — ${status}`));
					const hint = failed ? theme.fg("dim", "press enter or esc to dismiss") : "";
					const rows = Math.max(3, tui.terminal.rows - 6);
					const visible = lines.slice(-rows);
					const out: string[] = [];
					out.push(accent(`${`┌─ ${title}`.padEnd(width - 1, "─")}┐`));
					if (hint) {
						out.push(hint);
						out.push("");
					}
					for (const line of visible) {
						out.push(line.length > width ? line.slice(0, width) : line);
					}
					if (failed) {
						while (out.length < rows + 2) {
							out.push("");
						}
					}
					out.push(accent(`└${`─`.repeat(Math.max(0, width - 2))}┘`));
					return out;
				},
				invalidate: () => {
					// Nothing cached — every frame is rebuilt from `lines`.
				},
				handleInput: (data: string) => {
					if (failed && (data === "\r" || data === "\x1b")) {
						finish({ ok: false });
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);
}

/** `--session <id> [--session-dir <dir>]` for the active session, or "". */
function formatResumeArgs(sessionManager: SessionManager): string {
	if (!sessionManager.isPersisted() || !sessionManager.getSessionId()) return "";
	const parts = ["--session", sessionManager.getSessionId()];
	if (!sessionManager.usesDefaultSessionDir()) {
		parts.push("--session-dir", sessionManager.getSessionDir());
	}
	return parts.join(" ");
}

/**
 * Writes the resume args as a shell-sourced bash array so the pi-dev wrapper
 * can relaunch pi on the same session. Removed when the session is not
 * persisted (nothing to resume).
 */
function writeRestartArgs(sessionManager: SessionManager): void {
	const file = process.env.PI_RESTART_ARGS_FILE ?? DEFAULT_RESTART_ARGS_FILE;
	if (!sessionManager.isPersisted() || !sessionManager.getSessionId()) {
		rmSync(file, { force: true });
		return;
	}
	const parts = ["--session", sessionManager.getSessionId()];
	if (!sessionManager.usesDefaultSessionDir()) {
		parts.push("--session-dir", sessionManager.getSessionDir());
	}
	const quoted = parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `PI_RESTART_ARGS=(${quoted})\n`);
}
