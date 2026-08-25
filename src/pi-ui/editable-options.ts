import { Input, Key, matchesKey, ScrollView, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { EditableOptionState } from "./editable-option-state.js";
import { constrainLines, renderDivider, type PiUiTheme } from "./rendering.js";

export interface EditableOption {
	key: string;
	label: string;
	description?: string;
	/** The option opens an inline custom-answer editor instead of submitting immediately. */
	isOther?: boolean;
	/** Disable Tab-based additions for decision rows such as "Edit the plan". */
	editable?: boolean;
}

export interface EditableOptionsResult {
	key: string;
	edit?: string;
	wasCustom?: boolean;
}

export interface EditableOptionsConfig {
	title: string;
	details?: string | string[];
	options: EditableOption[];
	contentLines?: string[];
	maxHeightPercent?: number;
	autoEditKey?: string;
	initialFocus?: "content" | "options";
	contentFocusHint?: string;
	optionsFocusHint?: string;
	optionsHint?: string;
	editingHint?: string;
}

/**
 * Shared inline selection UI used by questionnaire-like HITL interactions.
 * Tab edits the selected option's independent buffer; page keys scroll content.
 */
export function createEditableOptionsComponent(
	tui: { terminal: { columns: number; rows: number }; requestRender(): void },
	theme: PiUiTheme,
	done: (result: EditableOptionsResult | null) => void,
	config: EditableOptionsConfig,
): Component & { focused: boolean } {
	const edits = new EditableOptionState();
	const input = new Input();
	const contentLines = config.contentLines ?? [];
	let selected = 0;
	let editing = false;
	let inputError: string | undefined;
	let focus: "content" | "options" = config.initialFocus ?? (contentLines.length > 0 ? "content" : "options");
	let focused = false;
	let cachedLines: string[] | undefined;
	const contentComponent: Component = {
		render: (contentWidth) => constrainLines(contentLines, contentWidth),
		handleInput: () => {},
		invalidate: () => {},
	};
	const scrollView = new ScrollView(contentComponent, { overscroll: "contain", scrollbar: "auto" });
	let cachedWidth: number | undefined;

	const details = config.details ? (Array.isArray(config.details) ? config.details : [config.details]) : [];
	const maxHeightPercent = config.maxHeightPercent ?? 0.75;
	const refresh = () => {
		cachedLines = undefined;
		cachedWidth = undefined;
		tui.requestRender();
	};
	const closeEditor = () => {
		edits.cancelEdit();
		input.setValue("");
		editing = false;
		inputError = undefined;
	};
	const commitEdit = (requireValue = false): boolean => {
		const value = input.getValue().trim();
		if (requireValue && !value) {
			inputError = "Type an answer, or press Esc to cancel editing.";
			refresh();
			return false;
		}
		edits.commitEdit(value);
		input.setValue("");
		editing = false;
		inputError = undefined;
		return true;
	};
	const beginEditing = () => {
		const option = config.options[selected];
		if (!option) return;
		editing = true;
		inputError = undefined;
		input.setValue(edits.beginEdit(option.key));
	};
	const finish = () => {
		const option = config.options[selected];
		if (option) done({ key: option.key, edit: edits.getEdit(option.key), wasCustom: option.isOther });
	};
	if (config.autoEditKey) {
		const autoIndex = config.options.findIndex((option) => option.key === config.autoEditKey);
		if (autoIndex >= 0) {
			selected = autoIndex;
			focus = "options";
			editing = true;
			input.setValue(edits.beginEdit(config.autoEditKey));
		}
	}

	const render = (width: number): string[] => {
		const renderWidth = Math.max(1, Math.min(width, tui.terminal.columns));
		if (cachedLines && cachedWidth === renderWidth) return cachedLines;
		const divider = renderDivider(theme, renderWidth);
		const maxHeight = Math.max(8, Math.floor(tui.terminal.rows * maxHeightPercent));
		const fixedRows = 9 + details.length + config.options.length;
		const viewport = Math.max(3, maxHeight - fixedRows);
		scrollView.updateLayout(contentLines.length, viewport, () => tui.requestRender());
		const visibleContent = scrollView.render(renderWidth);
		const focusHint = focus === "content"
			? config.contentFocusHint ?? "Content focused · ↑↓ scroll · Tab decision options"
			: config.optionsFocusHint ?? (contentLines.length > 0
				? "Decision options focused · Shift+Tab returns to content"
				: "Decision options focused · ↑↓ choose");
		const lines: string[] = [
			divider,
			theme.fg("accent", theme.bold(config.title)),
			...details,
			...(focusHint ? [theme.fg("dim", focusHint)] : []),
			...visibleContent,
		];
		if (contentLines.length > viewport) {
			lines.push(theme.fg("dim", `Showing ${scrollView.scrollTop + 1}-${Math.min(scrollView.scrollTop + viewport, contentLines.length)} of ${contentLines.length}`));
		}
		lines.push("");
		for (let index = 0; index < config.options.length; index++) {
			const option = config.options[index];
			const isSelected = index === selected;
			const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
			let label = option.label;
			const edit = edits.getEdit(option.key);
			if (editing && isSelected) {
				const available = Math.max(1, renderWidth - visibleWidth(prefix) - visibleWidth(label) - 4);
				label += ` — ${(input.render(available)[0] ?? "").replace(/^> /, "")}`;
				if (inputError) label += ` (${inputError})`;
			} else if (edit) {
				label += ` — ${edit}`;
			}
			lines.push(truncateToWidth(prefix + theme.fg(isSelected ? "accent" : "text", label), renderWidth));
			if (option.description) {
				lines.push(truncateToWidth(`     ${theme.fg("muted", option.description)}`, renderWidth));
			}
		}
		lines.push(
			"",
			theme.fg("dim", editing
				? config.editingHint ?? "Tab save · Enter submit · arrows stop editing · Esc cancel"
				: focus === "content"
					? "↑↓ scroll · Tab options · Esc cancel"
					: config.optionsHint ?? "↑↓ choose · Tab edit feedback · Enter submit · Esc cancel"),
			divider,
		);
		cachedLines = constrainLines(lines, renderWidth);
		cachedWidth = renderWidth;
		return cachedLines;
	};

	const handleInput = (data: string) => {
		if (matchesKey(data, Key.escape)) {
			if (editing) {
				closeEditor();
				refresh();
			} else {
				done(null);
			}
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const viewport = Math.max(3, Math.floor(tui.terminal.rows * maxHeightPercent) - (9 + details.length + config.options.length));
			scrollView.scrollBy(matchesKey(data, Key.pageDown) ? viewport : -viewport);
			refresh();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			if (editing) commitEdit();
			if (contentLines.length > 0) {
				focus = "content";
				refresh();
			}
			return;
		}
		if (matchesKey(data, Key.tab)) {
			if (focus === "content") {
				focus = "options";
				refresh();
				return;
			}
			const option = config.options[selected];
			if (!option || (option.editable === false && !option.isOther)) return;
			if (editing) {
				commitEdit();
			} else {
				beginEditing();
			}
			refresh();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			if (focus === "content" && !editing) {
				scrollView.scrollBy(matchesKey(data, Key.down) ? 1 : -1);
				refresh();
				return;
			}
			if (editing) commitEdit();
			focus = "options";
			selected = Math.max(0, Math.min(config.options.length - 1, selected + (matchesKey(data, Key.down) ? 1 : -1)));
			if (config.options[selected]?.isOther) beginEditing();
			refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (focus === "content" && !editing) {
				focus = "options";
				refresh();
				return;
			}
			const option = config.options[selected];
			if (editing) {
				if (!commitEdit(Boolean(option?.isOther))) return;
				finish();
				return;
			}
			if (option?.isOther) {
				beginEditing();
				refresh();
				return;
			}
			finish();
			return;
		}
		if (editing) {
			input.handleInput(data);
			refresh();
		}
	};

	return {
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			input.focused = value;
		},
		render,
		handleInput,
		invalidate: () => {
			cachedLines = undefined;
			cachedWidth = undefined;
		},
	};
}
