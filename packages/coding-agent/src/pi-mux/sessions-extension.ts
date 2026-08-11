import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, InlineExtension } from "../core/extensions/index.ts";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import type { MultiplexerRuntime } from "./multiplexer-runtime.ts";

/**
 * Registers a `/sessions` command that lists all open sessions (tabs) and lets
 * the user switch to one. It closes over a mutable runtime reference so it can
 * be registered at session-creation time, before the MultiplexerRuntime exists.
 */
export function createSessionsExtension(runtimeRef: { current: MultiplexerRuntime | null }): InlineExtension {
	return {
		name: "pi-mux",
		factory: (pi) => {
			pi.registerCommand("sessions", {
				description: "List open sessions and switch between them",
				handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
					const mux = runtimeRef.current;
					if (!mux) {
						ctx.ui.notify("Multiplexer runtime not available", "error");
						return;
					}
					const sessions = mux.listSessions();
					if (sessions.length <= 1) {
						ctx.ui.notify("Only one session is open. Use /new to create another.", "info");
						return;
					}
					const items = sessions.map((s) => ({
						value: s.id,
						label: `${s.isActive ? "▶" : " "} ${s.name}${s.isStreaming ? " ●" : ""}`,
						description: `${s.cwd}${s.isCompacting ? " (compacting)" : ""} · ${s.messageCount} msgs`,
					}));
					const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
						const container = new Container();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold("Open Sessions")), 1, 0));
						const list = new SelectList(items, Math.min(items.length, 10), {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						});
						list.onSelect = (item) => done(item.value);
						list.onCancel = () => done(null);
						container.addChild(list);
						container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter switch • esc cancel"), 1, 0));
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						return {
							render: (w: number) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data: string) => {
								list.handleInput(data);
								tui.requestRender();
							},
						};
					});
					if (selected && selected !== mux.activeSessionId) {
						await mux.activateSession(selected);
					}
				},
			});
		},
	};
}
