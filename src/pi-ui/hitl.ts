/** Shared option and answer semantics for keyboard-driven HITL surfaces. */

// Keep the historical ask-questions value for result compatibility while
// moving ownership of the behavior into this shared package.
export const OTHER_OPTION_VALUE = "__ask_questions_other__";
export const OTHER_OPTION_LABEL = "Type your own answer";

export interface FreeformOption {
	value?: string;
	label: string;
}

export interface HitlAnswer {
	key: string;
	label: string;
	value: string;
	wasCustom: boolean;
	addition?: string;
	baseLabel?: string;
}

export interface HitlCancelled {
	cancelled: true;
}

/** Recognize caller-supplied free-form rows so they can be canonicalized. */
export function isOtherOption(option: FreeformOption): boolean {
	const label = option.label.trim().toLowerCase();
	const value = option.value?.trim().toLowerCase();
	return label === "other" || label === OTHER_OPTION_LABEL.toLowerCase() || value === "other" || value === OTHER_OPTION_VALUE;
}

/**
 * Return the caller's normal options followed by one canonical free-form row.
 * This prevents models from accidentally creating two "Other" choices.
 */
export function withOtherOption<T extends FreeformOption>(options: T[]): Array<T & { value: string; isOther?: boolean }> {
	const normal = options
		.filter((option) => !isOtherOption(option))
		.map((option, index) => ({
			...option,
			value: option.value ?? (option.label || `option-${index + 1}`),
		}));
	return [
		...normal,
		{ value: OTHER_OPTION_VALUE, label: OTHER_OPTION_LABEL, isOther: true } as T & { value: string; isOther: boolean },
	];
}

/** Convert a selected row and its optional Tab edit into a stable answer. */
export function resolveHitlAnswer(
	option: { key: string; label: string; isOther?: boolean },
	editedText?: string,
): HitlAnswer {
	const addition = editedText?.trim() || undefined;
	if (option.isOther) {
		return {
			key: option.key,
			label: addition ?? "",
			value: addition ?? "",
			wasCustom: true,
		};
	}
	return {
		key: option.key,
		label: addition ? `${option.label} — ${addition}` : option.label,
		value: option.key,
		wasCustom: false,
		baseLabel: addition ? option.label : undefined,
		addition,
	};
}
