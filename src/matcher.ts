// Keyword queries that additionally match task syntax, on top of literal text
// matching: 'task' and 'todo' also match unchecked tasks (- [ ]), 'done' also
// matches completed tasks (- [x]). Only an exact keyword query activates task
// matching — 'done tasks' is matched literally.

export type TaskKind = 'open' | 'done';

const KEYWORDS: Record<string, TaskKind> = {
	task: 'open',
	todo: 'open',
	done: 'done',
};

// q must already be trimmed and lowercased.
export function taskKind(q: string): TaskKind | null {
	return KEYWORDS[q] ?? null;
}

// A task is a list item (bullet or numbered) followed by a checkbox.
const OPEN_TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[ \](?=\s|$)/;
const DONE_TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[x\](?=\s|$)/i;

export function taskLineMatches(lineText: string, kind: TaskKind): boolean {
	return (kind === 'open' ? OPEN_TASK : DONE_TASK).test(lineText);
}

// Whole-file variant, used when scanning embedded files.
export function taskContentMatches(content: string, kind: TaskKind): boolean {
	return content.split('\n').some(line => taskLineMatches(line, kind));
}
