/**
 * Shared independent edit buffers for selectable option UIs.
 *
 * The questionnaire and approval UIs use different renderers, but they share
 * this state model so edits remain attached to the option being edited.
 */
export class EditableOptionState {
	private readonly edits = new Map<string, string>();
	private activeKey: string | undefined;

	get editingKey(): string | undefined {
		return this.activeKey;
	}

	getEdit(key: string): string | undefined {
		return this.edits.get(key);
	}

	setEdit(key: string, value: string): void {
		const trimmed = value.trim();
		if (trimmed) this.edits.set(key, trimmed);
		else this.edits.delete(key);
	}

	beginEdit(key: string, initialValue?: string): string {
		this.activeKey = key;
		return this.edits.get(key) ?? initialValue ?? "";
	}

	commitEdit(value: string): void {
		if (this.activeKey !== undefined) this.setEdit(this.activeKey, value);
		this.activeKey = undefined;
	}

	cancelEdit(): void {
		this.activeKey = undefined;
	}

	clear(): void {
		this.edits.clear();
		this.activeKey = undefined;
	}
}
