import { truncateToWidth } from "@earendil-works/pi-tui";

export interface PiUiTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Render a divider that is safe for the current component width. */
export function renderDivider(theme: PiUiTheme, width: number): string {
	return truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width);
}

/** Keep every custom component line within its declared width. */
export function constrainLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}
