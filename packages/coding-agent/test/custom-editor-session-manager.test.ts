import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor session manager keybinding", () => {
	it("opens the session manager with left arrow when the editor is empty", () => {
		const keybindings = new KeybindingsManager({ "app.session.manager": "left" });
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let opens = 0;
		editor.onAction("app.session.manager", () => {
			opens++;
		});

		editor.handleInput("\x1b[D"); // left arrow
		expect(opens).toBe(1);
	});

	it("does not intercept left arrow while typing so the cursor can move", () => {
		const keybindings = new KeybindingsManager({ "app.session.manager": "left" });
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let opens = 0;
		editor.onAction("app.session.manager", () => {
			opens++;
		});
		editor.setText("draft");

		// Cursor at end; left arrow moves the cursor instead of opening the manager.
		editor.handleInput("\x1b[D"); // left arrow
		expect(opens).toBe(0);
		expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
	});
});
