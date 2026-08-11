import { basename } from "node:path";
import { type Component, getKeybindings, Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, InlineExtension } from "../core/extensions/index.ts";
import { type SessionInfo, SessionManager } from "../core/session-manager.ts";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../modes/interactive/components/keybinding-hints.ts";
import { deleteSessionFile, formatSessionDate, shortenPath } from "../modes/interactive/components/session-selector.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { resolvePath } from "../utils/paths.ts";
import type { MultiplexerRuntime, SessionSummary } from "./multiplexer-runtime.ts";

const cleanLabel = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, " ").trim();

interface PickerRow {
	kind: "header" | "session";
	// header
	text?: string;
	// session
	value?: string; // "open:<id>" | "disk:<path>"
	label?: string;
	isNamed?: boolean;
	isActive?: boolean;
	isStreaming?: boolean;
	isCompacting?: boolean;
	cwd?: string;
	msgs?: number;
	age?: string;
	path?: string; // session file path (for rename/delete)
	openId?: string; // mux tab id (for open rows)
}

type PickerResult =
	| { action: "select"; value: string }
	| { action: "rename"; id?: string; path?: string; name: string };

/** Callbacks the picker uses to act on the underlying sessions. */
interface PickerActions {
	select(value: string): void;
	rename(row: PickerRow, name: string): void;
	/** Performed in place: the picker stays open and is refreshed by the caller. */
	delete(row: PickerRow): void;
	cancel(): void;
}

/**
 * Full-height session picker: searchable list of open (cached) tabs and
 * previous (on-disk) sessions, with rename and delete actions.
 */
class SessionsPicker implements Component {
	private rows: PickerRow[] = [];
	private selectedIndex = 0;
	private mode: "list" | "rename" | "delete" = "list";
	private queryInput = new Input();
	private renameInput = new Input();
	private status: { type: "error" | "info"; message: string } | null = null;
	private open: SessionSummary[];
	private previous: SessionInfo[];
	private theme: Theme;
	private actions: PickerActions;

	constructor(open: SessionSummary[], previous: SessionInfo[], theme: Theme, actions: PickerActions) {
		this.open = open;
		this.previous = previous;
		this.theme = theme;
		this.actions = actions;
		this.renameInput.onSubmit = (value: string) => {
			const row = this.selectedRow();
			const name = value.trim();
			if (!row || !name) return;
			this.actions.rename(row, name);
		};
		this.rebuild();
	}

	/** Replace the session lists (e.g. after a delete) and re-render. */
	refresh(open: SessionSummary[], previous: SessionInfo[]): void {
		this.open = open;
		this.previous = previous;
		this.rebuild();
	}

	/** Optimistically drop a row so it disappears immediately, before the async delete lands. */
	removeSession(row: PickerRow): void {
		if (row.openId) {
			this.open = this.open.filter((s) => s.id !== row.openId);
		} else if (row.path) {
			this.previous = this.previous.filter((i) => i.path !== row.path);
		}
		this.rebuild();
	}

	showStatus(message: string, type: "error" | "info" = "info"): void {
		this.status = { type, message };
	}

	private selectedRow(): PickerRow | undefined {
		const row = this.rows[this.selectedIndex];
		return row?.kind === "session" ? row : undefined;
	}

	private rebuild(): void {
		const q = this.queryInput.getValue().trim().toLowerCase();
		const match = (text: string): boolean => q.length === 0 || text.toLowerCase().includes(q);

		const openRows: PickerRow[] = [];
		for (const s of this.open) {
			const label = s.name || basename(s.sessionFile ?? s.id).replace(/\.jsonl$/, "");
			if (!match(label) && !match(s.cwd)) continue;
			openRows.push({
				kind: "session",
				value: `open:${s.id}`,
				label,
				isNamed: s.isNamed,
				isActive: s.isActive,
				isStreaming: s.isStreaming,
				isCompacting: s.isCompacting,
				cwd: s.cwd,
				msgs: s.messageCount,
				path: s.sessionFile,
				openId: s.id,
			});
		}

		const prevRows: PickerRow[] = [];
		for (const info of this.previous) {
			const label = cleanLabel(info.name ?? info.firstMessage) || basename(info.path).replace(/\.jsonl$/, "");
			if (!match(label) && !match(info.cwd ?? "")) continue;
			prevRows.push({
				kind: "session",
				value: `disk:${info.path}`,
				label,
				isNamed: !!info.name,
				cwd: info.cwd,
				msgs: info.messageCount,
				age: formatSessionDate(info.modified),
				path: info.path,
			});
		}

		const next: PickerRow[] = [];
		if (openRows.length > 0) {
			next.push({
				kind: "header",
				text: `Open Sessions (${openRows.length}${q ? ` of ${this.open.length}` : ""})`,
			});
			next.push(...openRows);
		}
		if (prevRows.length > 0) {
			next.push({
				kind: "header",
				text: `── previous sessions (${prevRows.length}${q ? ` of ${this.previous.length}` : ""}) ──`,
			});
			next.push(...prevRows);
		}
		this.rows = next;

		// Keep the selection on a session row.
		if (this.rows[this.selectedIndex]?.kind !== "session") {
			this.selectedIndex = 0;
			while (this.selectedIndex < this.rows.length && this.rows[this.selectedIndex]?.kind !== "session") {
				this.selectedIndex++;
			}
		}
	}

	private moveSelection(delta: number): void {
		const n = this.rows.length;
		if (n === 0) return;
		let i = this.selectedIndex;
		for (let step = 0; step < n; step++) {
			i = (i + delta + n) % n;
			if (this.rows[i]?.kind === "session") {
				this.selectedIndex = i;
				return;
			}
		}
	}

	private renderRow(row: PickerRow, selected: boolean, width: number): string {
		const t = this.theme;
		if (row.kind === "header") {
			return t.fg("muted", truncateToWidth(row.text ?? "", width, "…"));
		}
		const s = row;
		const cursor = selected ? t.fg("accent", "› ") : "  ";
		const marker = s.isActive ? t.fg("accent", "▶ ") : "   ";
		const suffix = s.isCompacting ? t.fg("warning", " (compacting)") : s.isStreaming ? t.fg("accent", " ●") : "";
		const right = `${s.cwd ? `${shortenPath(s.cwd)} · ` : ""}${s.msgs ?? 0} msgs${s.age ? ` · ${s.age}` : ""}`;
		const leftFixed = cursor + marker;
		const labelWidth = Math.max(10, width - visibleWidth(leftFixed) - visibleWidth(right) - 2);
		const label = truncateToWidth(s.label ?? "", labelWidth, "…");
		let styled = label;
		if (this.mode === "delete" && selected) {
			styled = t.fg("error", label);
		} else if (s.isActive) {
			styled = t.fg("accent", label);
		} else if (s.isNamed) {
			styled = t.fg("warning", label);
		} else if (!s.openId) {
			// On-disk sessions are dimmed unless named: the visual split between
			// cached (open tabs) and disk-only sessions.
			styled = t.fg("dim", label);
		}
		if (selected) {
			styled = t.bold(styled);
		}
		const left = leftFixed + styled + suffix;
		const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		const line = left + " ".repeat(spacing) + t.fg("dim", right);
		const final = truncateToWidth(line, width);
		return selected ? t.bg("selectedBg", final) : final;
	}

	private footerHints(width: number): string {
		const t = this.theme;
		if (this.mode === "delete") {
			const isTab = this.selectedRow()?.openId !== undefined;
			return t.fg(
				"error",
				truncateToWidth(
					`Delete ${isTab ? "tab and session" : "session"}? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`,
					width,
					"…",
				),
			);
		}
		if (this.status) {
			const color = this.status.type === "error" ? "error" : "accent";
			return t.fg(color, truncateToWidth(this.status.message, width, "…"));
		}
		const sep = t.fg("muted", " · ");
		const parts = [
			keyHint("tui.select.confirm", "switch"),
			keyHint("app.session.rename", "rename"),
			keyHint("app.session.delete", "delete"),
			t.fg("muted", "type to search"),
		];
		return truncateToWidth(parts.join(sep), width, "…");
	}

	render(width: number): string[] {
		const t = this.theme;
		if (this.mode === "rename") {
			return [
				t.fg("accent", t.bold("Rename Session")),
				"",
				...this.renameInput.render(width),
				"",
				t.fg(
					"muted",
					truncateToWidth(
						`${keyHint("tui.select.confirm", "save")} · ${keyHint("tui.select.cancel", "cancel")}`,
						width,
						"…",
					),
				),
			];
		}

		const lines: string[] = [];
		lines.push(...this.queryInput.render(width));
		lines.push("");
		if (this.rows.length === 0) {
			lines.push(t.fg("muted", "  No sessions match the filter"));
			lines.push("");
		} else {
			for (let i = 0; i < this.rows.length; i++) {
				lines.push(this.renderRow(this.rows[i]!, i === this.selectedIndex, width));
			}
			lines.push("");
		}
		lines.push(this.footerHints(width));
		return lines;
	}

	invalidate(): void {
		// No cached state to invalidate; every frame is rebuilt from current state.
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		// Any input clears a transient status line.
		this.status = null;
		if (this.mode === "rename") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.mode = "list";
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}
		if (this.mode === "delete") {
			if (kb.matches(data, "tui.select.confirm")) {
				const row = this.selectedRow();
				if (row) {
					// Back to list mode; the delete runs in place and refreshes the list.
					this.mode = "list";
					this.actions.delete(row);
				}
			} else if (kb.matches(data, "tui.select.cancel")) {
				this.mode = "list";
			}
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-10);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(10);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const row = this.selectedRow();
			if (row?.value) this.actions.select(row.value);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.actions.cancel();
			return;
		}
		if (kb.matches(data, "app.session.rename")) {
			const row = this.selectedRow();
			if (!row) return;
			this.renameInput.setValue(row.label ?? "");
			this.mode = "rename";
			return;
		}
		if (kb.matches(data, "app.session.delete")) {
			if (this.selectedRow()) this.mode = "delete";
			return;
		}
		this.queryInput.handleInput(data);
		this.rebuild();
	}
}

/**
 * Registers a `/sessions` command that lists all open sessions (tabs) and lets
 * the user switch to one, rename it, or delete it. It closes over a mutable
 * runtime reference so it can be registered at session-creation time, before
 * the MultiplexerRuntime exists.
 */
export function createSessionsExtension(runtimeRef: { current: MultiplexerRuntime | null }): InlineExtension {
	return {
		name: "pi-mux",
		factory: (pi) => {
			pi.registerCommand("sessions", {
				description: "List open and previous sessions; switch, rename, or delete",
				handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
					const mux = runtimeRef.current;
					if (!mux) {
						ctx.ui.notify("Multiplexer runtime not available", "error");
						return;
					}
					let open = mux.listSessions();
					// Also load persisted sessions (same source as /resume) so previous
					// sessions can be reopened from here. Skip the ones already open as tabs.
					const loadPrevious = async (): Promise<SessionInfo[]> => {
						const openFiles = new Set(
							open
								.map((s) => s.sessionFile)
								.filter((f): f is string => f !== undefined)
								.map((f) => resolvePath(f)),
						);
						return (await SessionManager.listAll()).filter((info) => !openFiles.has(resolvePath(info.path)));
					};
					let previous = await loadPrevious();

					if (open.length <= 1 && previous.length === 0) {
						ctx.ui.notify("Only one session is open. Use /new to create another.", "info");
						return;
					}

					const showPicker = (): Promise<PickerResult | null> =>
						ctx.ui.custom<PickerResult | null>(
							(tui, theme, _keybindings, done) => {
								// The delete action runs in place (the overlay stays open), so it
								// needs a ref to the picker to update its list without a flash.
								const pickerRef: { current: SessionsPicker | null } = { current: null };
								const actions: PickerActions = {
									select: (value) => done({ action: "select", value }),
									rename: (row, name) => done({ action: "rename", id: row.openId, path: row.path, name }),
									cancel: () => done(null),
									delete: (row) => {
										// Optimistic: drop the row immediately so there is no flash.
										pickerRef.current?.removeSession(row);
										void (async () => {
											try {
												if (row.openId) {
													// skipInvalidate: closing the tab must not hide this overlay
													// (resetExtensionUI -> hideOverlay) while it is still open.
													await mux.closeSession(row.openId, { skipInvalidate: true });
												}
												if (row.path) {
													const del = await deleteSessionFile(row.path);
													if (!del.ok) throw new Error(del.error ?? "delete failed");
												}
											} catch (error) {
												pickerRef.current?.showStatus(
													`Failed to delete: ${error instanceof Error ? error.message : String(error)}`,
													"error",
												);
											}
											// Sync with the real state on disk (corrects the optimistic removal).
											open = mux.listSessions();
											previous = await loadPrevious();
											pickerRef.current?.refresh(open, previous);
										})();
									},
								};
								const picker = new SessionsPicker(open, previous, theme, actions);
								pickerRef.current = picker;
								const accent = (text: string) => theme.fg("accent", text);
								const headerBorder = new DynamicBorder(accent);
								const footerBorder = new DynamicBorder(accent);

								return {
									render: (width: number) => {
										const lines: string[] = [];
										const add = (comp: Component) => {
											for (const line of comp.render(width)) {
												lines.push(line);
											}
										};
										add(headerBorder);
										for (const line of picker.render(width)) {
											lines.push(line);
										}
										// Fill the middle so the footer border hugs the bottom edge.
										while (lines.length < tui.terminal.rows - 1) {
											lines.push(" ".repeat(width));
										}
										add(footerBorder);
										while (lines.length < tui.terminal.rows) {
											lines.push(" ".repeat(width));
										}
										return lines;
									},
									invalidate: () => {
										headerBorder.invalidate();
										footerBorder.invalidate();
										picker.invalidate();
									},
									handleInput: (data: string) => {
										picker.handleInput(data);
										tui.requestRender();
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

					const result = await showPicker();
					if (!result) return;

					if (result.action === "select") {
						if (result.value.startsWith("disk:")) {
							// Open a persisted session as a new tab.
							try {
								await mux.switchSession(result.value.slice("disk:".length));
							} catch (error) {
								ctx.ui.notify(
									`Failed to open session: ${error instanceof Error ? error.message : String(error)}`,
									"error",
								);
							}
						} else if (result.value.startsWith("open:") && result.value !== `open:${mux.activeSessionId}`) {
							await mux.activateSession(result.value.slice("open:".length));
						}
						return;
					}

					if (result.action === "rename") {
						try {
							if (result.id) {
								const res = mux.renameSession(result.id, result.name);
								if (!res.ok) throw new Error(res.error ?? "rename failed");
							} else if (result.path) {
								SessionManager.open(result.path).appendSessionInfo(result.name);
							}
							ctx.ui.notify(`Session renamed: ${result.name}`, "info");
						} catch (error) {
							ctx.ui.notify(
								`Failed to rename: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						}
						return;
					}
				},
			});
		},
	};
}
