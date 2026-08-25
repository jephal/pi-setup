/**
 * Ask Questions
 *
 * A small, self-contained question UI for tools that need a human decision.
 * The UI deliberately replaces pi's chat editor while it is open, so the
 * question feels like a first-class part of the conversation rather than a
 * notification or a second prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	EditableOptionState,
	OTHER_OPTION_VALUE,
	isOtherOption,
	renderDivider,
	withOtherOption,
} from "../src/pi-ui/index.js";
import {
	Input,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface QuestionOption {
	value?: string;
	label: string;
	description?: string;
	visualization?: string;
}

interface Question {
	id: string;
	label?: string;
	question: string;
	options: QuestionOption[];
}

interface NormalizedOption {
	value: string;
	label: string;
	description?: string;
	visualization?: string;
	isOther?: boolean;
}

interface Answer {
	questionId: string;
	value: string;
	label: string;
	wasCustom: boolean;
	baseLabel?: string;
	addition?: string;
}

interface AskQuestionsResult {
	title?: string;
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

const OptionSchema = Type.Object({
	value: Type.Optional(Type.String({ description: "Stable value returned to the model" })),
	label: Type.String({ description: "Text shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional explanation shown under the option" })),
	visualization: Type.Optional(
		Type.String({ description: "Optional ASCII graph or visualization shown in the right-side panel for this option" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique id for this question" }),
	label: Type.Optional(Type.String({ description: "Short label used in the question tabs, for example 'Scope'" })),
	question: Type.String({ description: "The question shown to the user" }),
	options: Type.Array(OptionSchema, { description: "Options to choose from; an Other text-input option is always added" }),
});

const AskQuestionsParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional heading for a group of questions" })),
	questions: Type.Array(QuestionSchema, { description: "One question or a questionnaire containing several questions" }),
});

function cancelledResult(
	questions: Question[],
	title?: string,
): { content: { type: "text"; text: string }[]; details: AskQuestionsResult } {
	return {
		content: [{ type: "text", text: "The user cancelled the questions." }],
		details: { title, questions, answers: [], cancelled: true },
	};
}

export default function askQuestions(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_questions",
		label: "Ask Questions",
		description:
			"Ask the user one or more questions when you need a decision or clarification. Provide a few useful options. The UI always includes an Other text-input option. Use this instead of asking questions in normal assistant text when an answer is needed to continue.",
		promptSnippet: "Ask the user for a decision with options or a short questionnaire",
		promptGuidelines: [
			"Use ask_questions whenever you need an answer from the user before continuing, rather than asking a question in assistant text.",
			"Give ask_questions concise, mutually useful options and include enough context in each question for the user to decide.",
			"ask_questions always adds an Other text-input option; do not add a duplicate free-form option yourself.",
			"ask_questions options may include a visualization string when an ASCII illustration materially helps; it is shown to the right of the question only when the selected option has one."
		],
		parameters: AskQuestionsParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return cancelledResult(params.questions, params.title);
			}

			if (params.questions.length === 0) {
				return cancelledResult([], params.title);
			}

			const questions: Question[] = params.questions.map((question) => ({
				...question,
				options: question.options ?? [],
			}));
			const isMulti = questions.length > 1;

			const result = await ctx.ui.custom<AskQuestionsResult | null | undefined>(
				(tui, theme, _keybindings, done) => {
					let currentTab = 0;
					let optionIndex = 0;
					let inputMode = false;
					let inputQuestionId: string | undefined;
					let editingOption: NormalizedOption | undefined;
					let inputError: string | undefined;
					let cachedLines: string[] | undefined;
					const answers = new Map<string, Answer>();
					// Keep inline edits per option, not per question. This prevents a
					// draft from leaking from one row into another row.
					const optionEdits = new EditableOptionState();

					// A single-line Input is rendered inline beside the Other option.
					// This keeps editing part of the answer row instead of adding a
					// second input box underneath the choices.
					const input = new Input();

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function currentQuestion(): Question | undefined {
						return questions[currentTab];
					}

					function optionEditKey(question: Question, option: NormalizedOption): string {
						return `${question.id}\u0000${option.value}`;
					}

					function optionsFor(question: Question): NormalizedOption[] {
						return withOtherOption(question.options).map((option) => ({
							value: option.value,
							label: option.label,
							description: option.description,
							visualization: option.visualization,
							isOther: option.value === OTHER_OPTION_VALUE || isOtherOption(option),
						}));
					}

					function allAnswered(): boolean {
						return questions.every((question) => answers.has(question.id));
					}

					function selectedIndexFor(question: Question): number {
						const answer = answers.get(question.id);
						if (!answer) return 0;

						const options = optionsFor(question);
						if (answer.wasCustom) return options.length - 1;
						const index = options.findIndex((option) => option.value === answer.value);
						return index >= 0 ? index : 0;
					}

					function selectTab(tab: number) {
						currentTab = tab;
						const question = currentQuestion();
						optionIndex = question ? selectedIndexFor(question) : 0;
						refresh();
					}

					function openAnswerEditor(question: Question) {
						const options = optionsFor(question);
						const option = options[optionIndex];
						const answer = answers.get(question.id);
						inputMode = true;
						inputQuestionId = question.id;
						editingOption = option?.isOther ? undefined : option;
						inputError = undefined;
						// Tab edits the option currently selected. Other is the one
						// exception: it starts as a blank inline answer field.
						const savedEdit = option ? optionEdits.getEdit(optionEditKey(question, option)) : undefined;
						// Only reuse the committed answer when it belongs to the
						// option being edited. A different row must start fresh.
						const answerBelongsToOption = option?.isOther ? answer?.wasCustom : answer?.value === option?.value;
						const previousText = option?.isOther
							? (answerBelongsToOption ? answer?.label : undefined)
							: (answerBelongsToOption ? answer?.addition : undefined);
						input.setValue(savedEdit ?? previousText ?? "");
						refresh();
					}

					function closeOtherEditor() {
						inputMode = false;
						inputQuestionId = undefined;
						editingOption = undefined;
						inputError = undefined;
						input.setValue("");
						refresh();
					}

					function saveAnswer(question: Question, option: NormalizedOption) {
						const addition = optionEdits.getEdit(optionEditKey(question, option));
						answers.set(question.id, {
							questionId: question.id,
							value: option.value,
							label: addition ? `${option.label} — ${addition}` : option.label,
							baseLabel: addition ? option.label : undefined,
							addition,
							wasCustom: false,
						});
					}

					function moveOption(question: Question, nextIndex: number) {
						optionIndex = nextIndex;
						const option = optionsFor(question)[optionIndex];
						// Other becomes an inline input as soon as it is selected.
						if (option?.isOther) openAnswerEditor(question);
						else refresh();
					}

					function commitInlineEdit(advance: boolean) {
						if (!inputQuestionId) return;
						const question = questions.find((candidate) => candidate.id === inputQuestionId);
						const answer = input.getValue().trim();
						if (!question) return;
						if (!answer) {
							// Tab and arrow keys simply stop editing when the draft is
							// empty. Enter still requires a real answer.
							if (!advance) {
								closeOtherEditor();
								return;
							}
							inputError = "Type an answer, or use Tab/arrow keys to stop editing.";
							refresh();
							return;
						}

						if (editingOption) {
							optionEdits.setEdit(optionEditKey(question, editingOption), answer);
							answers.set(question.id, {
								questionId: question.id,
								value: editingOption.value,
								label: `${editingOption.label} — ${answer}`,
								baseLabel: editingOption.label,
								addition: answer,
								wasCustom: false,
							});
							optionIndex = optionsFor(question).findIndex((option) => option.value === editingOption?.value);
						} else {
							const otherOption = optionsFor(question).find((option) => option.isOther);
							if (otherOption) optionEdits.setEdit(optionEditKey(question, otherOption), answer);
							answers.set(question.id, {
								questionId: question.id,
								value: answer,
								label: answer,
								wasCustom: true,
							});
							optionIndex = optionsFor(question).length - 1;
						}
						closeOtherEditor();
						if (!advance) return;

						// Enter saves the edit. The final answer submits the whole
						// questionnaire; otherwise it advances to the next question.
						if (!isMulti || allAnswered()) submit(false);
						else selectTab((currentTab + 1) % questions.length);
					}

					input.onSubmit = () => commitInlineEdit(true);

					function submit(cancelled: boolean) {
						done({ title: params.title, questions, answers: [...answers.values()], cancelled });
					}

					function handleInput(data: string) {
						if (inputMode) {
							const editingQuestion = questions.find((candidate) => candidate.id === inputQuestionId);
							if (matchesKey(data, Key.escape)) {
								closeOtherEditor();
								return;
							}
							// Tab toggles editing off. It never moves between questions.
							if (matchesKey(data, Key.tab)) {
								commitInlineEdit(false);
								return;
							}
							// Arrow keys both stop editing and perform their normal
							// navigation action.
							if (editingQuestion && isMulti && matchesKey(data, Key.right)) {
								commitInlineEdit(false);
								selectTab((currentTab + 1) % questions.length);
								return;
							}
							if (editingQuestion && isMulti && matchesKey(data, Key.left)) {
								commitInlineEdit(false);
								selectTab((currentTab - 1 + questions.length) % questions.length);
								return;
							}
							if (editingQuestion && matchesKey(data, Key.up)) {
								commitInlineEdit(false);
								moveOption(editingQuestion, Math.max(0, optionIndex - 1));
								return;
							}
							if (editingQuestion && matchesKey(data, Key.down)) {
								commitInlineEdit(false);
								moveOption(editingQuestion, Math.min(optionsFor(editingQuestion).length - 1, optionIndex + 1));
								return;
							}
							input.handleInput(data);
							refresh();
							return;
						}

						const question = currentQuestion();
						if (!question) return;
						const options = optionsFor(question);

						// Arrow keys are the only way to move between questions. Tab is
						// reserved exclusively for editing the current answer.
						if (isMulti && matchesKey(data, Key.right)) {
							selectTab((currentTab + 1) % questions.length);
							return;
						}
						if (isMulti && matchesKey(data, Key.left)) {
							selectTab((currentTab - 1 + questions.length) % questions.length);
							return;
						}
						if (matchesKey(data, Key.tab)) {
							openAnswerEditor(question);
							return;
						}

						if (matchesKey(data, Key.up)) {
							moveOption(question, Math.max(0, optionIndex - 1));
							return;
						}
						if (matchesKey(data, Key.down)) {
							moveOption(question, Math.min(options.length - 1, optionIndex + 1));
							return;
						}
						if (matchesKey(data, Key.enter)) {
							const option = options[optionIndex];
							if (option?.isOther) {
								openAnswerEditor(question);
							} else if (option) {
								saveAnswer(question, option);
								// Enter confirms an answer and advances. Enter on the
								// final unanswered question submits the whole questionnaire.
								if (!isMulti || allAnswered()) submit(false);
								else selectTab((currentTab + 1) % questions.length);
							}
							return;
						}
						if (matchesKey(data, Key.escape)) submit(true);
					}

					function addWrapped(lines: string[], text: string, width: number) {
						lines.push(...wrapTextWithAnsi(text, width));
					}

					function addWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= width) {
							addWrapped(lines, prefix + text, width);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const renderWidth = Math.max(1, width);
						const lines: string[] = [];
						const question = currentQuestion();

						// This is intentionally the first line: it separates the question UI
						// from the transcript above it and keeps it from looking like chat.
						lines.push(renderDivider(theme, renderWidth));
						addWrappedWithPrefix(
							lines,
							" ",
							theme.fg("accent", theme.bold(params.title ?? (isMulti ? "Questions" : "Question"))),
							renderWidth,
						);

						if (isMulti) {
							const tabParts = [" "];
							for (let i = 0; i < questions.length; i++) {
								const q = questions[i];
								const active = currentTab === i;
								const answered = answers.has(q.id);
								const label = q.label || `Q${i + 1}`;
								const tab = ` ${answered ? "●" : "○"} ${label} `;
								tabParts.push(active ? theme.bg("selectedBg", theme.fg("text", tab)) : theme.fg(answered ? "success" : "muted", tab));
							}
							lines.push(truncateToWidth(tabParts.join(""), renderWidth, ""));
						}

						lines.push("");

						if (question) {
							const options = optionsFor(question);
							const selectedVisualization = options[optionIndex]?.visualization?.trim();
							// Only claim the right side when the selected option actually
							// has a visualization. Otherwise the question uses full width.
							const showVisualizations = Boolean(selectedVisualization) && renderWidth >= 60;
							// Give ASCII art slightly more room than the question column.
							const leftWidth = showVisualizations ? Math.floor((renderWidth - 3) * 0.48) : renderWidth;
							const rightWidth = renderWidth - leftWidth - 3;
							const questionLines: string[] = [];

							addWrappedWithPrefix(questionLines, " ", theme.fg("text", question.question), leftWidth);
							questionLines.push("");

							for (let i = 0; i < options.length; i++) {
								const option = options[i];
								const selected = i === optionIndex;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								let label = `${i + 1}. ${option.label}`;
								const savedEdit = optionEdits.getEdit(optionEditKey(question, option));

								// Editing is inline: "4. Other — my answer". This keeps
								// the answer attached to the option instead of creating a
								// second input bar below the choices.
								if (inputMode && selected) {
									const available = Math.max(1, leftWidth - visibleWidth(prefix) - visibleWidth(label) - 4);
									const renderedInput = input.render(available)[0] ?? "";
									label += ` — ${renderedInput.replace(/^> /, "")}`;
									if (inputError) label += ` (${inputError})`;
								} else if (savedEdit) {
									label += ` — ${savedEdit}`;
								}

								addWrappedWithPrefix(questionLines, prefix, theme.fg(selected ? "accent" : "text", label), leftWidth);
								if (option.description) {
									addWrappedWithPrefix(questionLines, "     ", theme.fg("muted", option.description), leftWidth);
								}
							}

							if (!showVisualizations) {
								lines.push(...questionLines);
							} else {
								const visualLines: string[] = [];
								for (const rawLine of selectedVisualization!.split("\n")) {
									visualLines.push(...wrapTextWithAnsi(theme.fg("muted", rawLine), rightWidth));
								}

								// Let visualizations use as many rows as they need, but never
								// more than half of the current terminal height.
								const maxVisualizationHeight = Math.max(1, Math.floor(tui.terminal.rows * 0.5));
								if (visualLines.length > maxVisualizationHeight) {
									visualLines.splice(maxVisualizationHeight - 1);
									visualLines.push(theme.fg("dim", "…"));
								}

								const rowCount = Math.max(questionLines.length, visualLines.length);
								for (let i = 0; i < rowCount; i++) {
									const left = truncateToWidth(questionLines[i] ?? "", leftWidth, "");
									const right = truncateToWidth(visualLines[i] ?? "", rightWidth, "");
									lines.push(
										left + " ".repeat(Math.max(0, leftWidth - visibleWidth(left))) +
										"   " + right,
									);
								}
							}
						}

						lines.push("");
						const help = inputMode
							? "Tab stop editing • Enter save + next • arrows stop + move • Esc cancel"
							: isMulti
								? "←→ questions • ↑↓ choose • Tab edit answer • Enter answer + next / submit • Esc cancel"
								: "↑↓ choose • Tab edit answer • Enter answer / submit • Esc cancel";
						addWrappedWithPrefix(lines, " ", theme.fg("dim", help), renderWidth);
						lines.push(renderDivider(theme, renderWidth));

						cachedLines = lines;
						return lines;
					}

					let focused = false;
					const component = {
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
						},
					};

					if (signal) {
						signal.addEventListener("abort", () => done(null), { once: true });
					}
					return component;
				},
			);

			if (!result || result.cancelled) return cancelledResult(questions, params.title);

			const answerText = result.answers
				.map((answer) => {
					const question = questions.find((candidate) => candidate.id === answer.questionId);
					const label = question?.label || answer.questionId;
					if (answer.addition) {
						return `${label}: user selected "${answer.baseLabel}" and added "${answer.addition}" (value: ${answer.value})`;
					}
					return answer.wasCustom
						? `${label}: user wrote "${answer.label}"`
						: `${label}: user selected "${answer.label}" (value: ${answer.value})`;
				})
				.join("\n");

			return {
				content: [{ type: "text", text: answerText }],
				details: result,
			};
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const count = questions.length;
			const title = typeof args.title === "string" ? `${args.title} ` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("ask_questions ")) +
					theme.fg("muted", `${title}${count} question${count === 1 ? "" : "s"}`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskQuestionsResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);

			const lines = details.answers.map((answer) =>
				`${theme.fg("success", "✓ ")}${theme.fg("accent", answer.questionId)}: ${
					answer.wasCustom ? theme.fg("muted", "(wrote) ") : ""
				}${theme.fg("text", answer.label)}`,
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
