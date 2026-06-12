// Live Preview / Source mode paragraph filter.
//
// Reading mode hides rendered <div> blocks with a CSS class, but Live Preview
// and Source mode are a CodeMirror 6 editor with virtual scrolling — off-screen
// lines aren't in the DOM. The CM6-sanctioned way to hide/collapse content is
// editor decorations driven by a StateField (height-affecting decorations like
// line hiding and block widgets are *required* to live in a StateField, not a
// ViewPlugin). Filtering is single-line granularity: a line is kept if it
// contains the (case-insensitive) query, otherwise it is hidden and runs of
// hidden lines collapse into a single clickable "···" ellipsis.
//
// Embedded files (![[page]]) render as block widgets outside the line flow, so
// they're handled separately by a ViewPlugin (EmbedFilter) that reuses the
// reading-mode block filter on each embed's rendered content.

import { App, EventRef, MarkdownView, TFile } from 'obsidian';
import { EditorState, Extension, StateEffect, StateField } from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from '@codemirror/view';
import { applyBlockFilter, clearBlockFilter } from './dom-filter';

// Dispatch this to a CM editor to set the active filter query ('' = no filter).
export const setFilterQuery = StateEffect.define<string>();

// Dispatch this to toggle ancestor-header preservation for the active filter.
export const setPreserveStructure = StateEffect.define<boolean>();

// Dispatch this to toggle the "···" markers for hidden runs.
export const setShowEllipses = StateEffect.define<boolean>();

// A line that is nothing but an embed, e.g. `![[page]]`.
const EMBED_LINE = /^\s*!\[\[[^\]]*\]\]\s*$/;

class EllipsisWidget extends WidgetType {
	// All ellipses are identical, so they never need re-rendering.
	eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const el = activeDocument.createElement('div');
		el.className = 'cm-pf-ellipsis';
		el.textContent = '···';
		return el;
	}

	// Let clicks fall through to the plugin's viewEl listener (which clears the
	// query) instead of being treated as editor interaction.
	ignoreEvent(): boolean {
		return true;
	}
}

const hiddenLine = Decoration.line({ class: 'cm-pf-no-match' });
const ellipsis = Decoration.widget({ widget: new EllipsisWidget(), block: true, side: -1 });
const highlightMark = Decoration.mark({ class: 'cm-pf-highlight' });

// Holds the active query for a given editor.
const queryField = StateField.define<string>({
	create: () => '',
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setFilterQuery)) return e.value;
		}
		return value;
	},
});

const preserveStructureField = StateField.define<boolean>({
	create: () => false,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setPreserveStructure)) return e.value;
		}
		return value;
	},
});

const showEllipsesField = StateField.define<boolean>({
	create: () => true,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setShowEllipses)) return e.value;
		}
		return value;
	},
});

// Returns 1–6 for lines starting with that many `#`, 0 otherwise.
function getHeaderLevel(text: string): number {
	const m = text.match(/^(#{1,6}) /);
	return m ? m[1]!.length : 0;
}

function buildDecorations(state: EditorState): DecorationSet {
	const q = state.field(queryField).trim().toLowerCase();
	if (!q) return Decoration.none;

	const doc = state.doc;
	const preserveStructure = state.field(preserveStructureField);
	const showEllipses = state.field(showEllipsesField);

	// Lines touched by the selection/cursor stay visible regardless of match, so
	// you can press Enter and edit a new (not-yet-matching) paragraph in place.
	// The line collapses again once the cursor leaves it.
	const cursorLines = new Set<number>();
	for (const range of state.selection.ranges) {
		const first = doc.lineAt(range.from).number;
		const last = doc.lineAt(range.to).number;
		for (let n = first; n <= last; n++) cursorLines.add(n);
	}

	// Pass 1: classify every line.
	const lineVisible = new Array<boolean>(doc.lines + 1);
	const lineMatches = new Array<boolean>(doc.lines + 1); // direct text match only
	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		const lower = line.text.toLowerCase();
		const isEmbed = EMBED_LINE.test(line.text);
		const matches = lower.includes(q);
		lineMatches[i] = matches && !isEmbed;
		lineVisible[i] = cursorLines.has(i) || isEmbed || matches;
	}

	// Pass 2 (optional): for each visible line, un-hide its ancestor headers.
	if (preserveStructure) {
		const stack: Array<{ level: number; lineNum: number }> = [];
		for (let i = 1; i <= doc.lines; i++) {
			const level = getHeaderLevel(doc.line(i).text);
			if (level > 0) {
				while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
					stack.pop();
				}
				stack.push({ level, lineNum: i });
			}
			if (lineVisible[i]) {
				for (const h of stack) lineVisible[h.lineNum] = true;
			}
		}
	}

	// Pass 3: build decorations.
	const decos = [];
	let inRun = false;

	for (let i = 1; i <= doc.lines; i++) {
		if (lineVisible[i]) {
			inRun = false;
			if (lineMatches[i]) {
				const line = doc.line(i);
				const lower = line.text.toLowerCase();
				for (let idx = lower.indexOf(q); idx !== -1; idx = lower.indexOf(q, idx + q.length)) {
					decos.push(highlightMark.range(line.from + idx, line.from + idx + q.length));
				}
			}
			continue;
		}
		if (!inRun) {
			if (showEllipses) decos.push(ellipsis.range(doc.line(i).from));
			inRun = true;
		}
		decos.push(hiddenLine.range(doc.line(i).from));
	}

	return Decoration.set(decos, true);
}

// queryField and preserveStructureField are declared before decoField so that,
// within a single transaction, decoField sees their already-updated values.
const decoField = StateField.define<DecorationSet>({
	create: (state) => buildDecorations(state),
	update(value, tr) {
		const filterChanged = tr.effects.some(
			(e) => e.is(setFilterQuery) || e.is(setPreserveStructure) || e.is(setShowEllipses),
		);
		// Recompute on selection moves too, so the cursor's line stays exempt.
		if (filterChanged || tr.docChanged || tr.selection) return buildDecorations(tr.state);
		return value.map(tr.changes);
	},
	provide: (f) => EditorView.decorations.from(f),
});

// Filters the rendered content of embedded files (![[page]]). Embeds render as
// block widgets, so their visibility and internal filtering are driven from the
// DOM rather than line decorations. Match detection reads each embedded file so
// it's correct even before an embed scrolls into view.
class EmbedFilter implements PluginValue {
	private query = '';
	private matchCache = new Map<string, boolean>(); // file path → content matches query
	private scanToken = 0;
	private rafId = 0;
	private readonly win: Window;
	private readonly modifyRef: EventRef;

	constructor(private view: EditorView, private app: App) {
		this.win = view.dom.ownerDocument.defaultView ?? window;
		this.query = view.state.field(queryField).trim().toLowerCase();

		// An edit to an embedded file invalidates its cached match result.
		this.modifyRef = app.vault.on('modify', (file) => {
			if (this.matchCache.delete(file.path) && this.query) void this.rescan();
		});

		if (this.query) void this.rescan();
	}

	update(update: ViewUpdate): void {
		const next = update.state.field(queryField).trim().toLowerCase();
		if (next !== this.query) {
			this.query = next;
			this.matchCache.clear();
			if (this.query) void this.rescan();
			else this.scheduleApply(); // clears embeds
			return;
		}
		// Re-apply when the rendered DOM may have changed (e.g. an embed scrolled
		// into view and rendered, or the document changed).
		if (update.docChanged || update.viewportChanged || update.geometryChanged) {
			this.scheduleApply();
		}
	}

	destroy(): void {
		this.app.vault.offref(this.modifyRef);
		if (this.rafId) this.win.cancelAnimationFrame(this.rafId);
		this.clearEmbeds();
	}

	private hostPath(): string {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const v = leaf.view as MarkdownView;
			if ((v.editor as unknown as { cm?: EditorView })?.cm === this.view) return v.file?.path ?? '';
		}
		return '';
	}

	// Top-level embeds in the editor (not embeds nested inside another embed).
	private embedEls(): HTMLElement[] {
		return Array.from(
			this.view.contentDOM.querySelectorAll<HTMLElement>('.internal-embed.markdown-embed'),
		).filter((el) => !el.closest('.markdown-preview-section'));
	}

	private fileFor(el: HTMLElement, sourcePath: string): TFile | null {
		const src = el.getAttribute('src');
		return src ? this.app.metadataCache.getFirstLinkpathDest(src, sourcePath) : null;
	}

	// Read each referenced file, cache whether it matches, then re-apply.
	private async rescan(): Promise<void> {
		const token = ++this.scanToken;
		const sourcePath = this.hostPath();
		const files = new Map<string, TFile>();
		for (const el of this.embedEls()) {
			const file = this.fileFor(el, sourcePath);
			if (file && !this.matchCache.has(file.path)) files.set(file.path, file);
		}

		for (const [path, file] of files) {
			let matches = false;
			try {
				matches = (await this.app.vault.cachedRead(file)).toLowerCase().includes(this.query);
			} catch {
				matches = false;
			}
			if (token !== this.scanToken) return; // superseded by a newer scan
			this.matchCache.set(path, matches);
		}

		this.scheduleApply();
	}

	// Defer DOM writes out of the CM update cycle to avoid measurement conflicts.
	private scheduleApply(): void {
		if (this.rafId) return;
		this.rafId = this.win.requestAnimationFrame(() => {
			this.rafId = 0;
			this.applyEmbeds();
		});
	}

	private applyEmbeds(): void {
		const sourcePath = this.hostPath();
		const preserveStructure = this.view.state.field(preserveStructureField);
		for (const el of this.embedEls()) {
			const section = el.querySelector<HTMLElement>('.markdown-preview-section');
			if (!this.query) {
				el.classList.remove('pf-embed-hidden');
				if (section) clearBlockFilter(section);
				continue;
			}
			const file = this.fileFor(el, sourcePath);
			const matches = file ? this.matchCache.get(file.path) : undefined;
			if (matches === undefined) continue; // not scanned yet

			el.classList.toggle('pf-embed-hidden', !matches);
			if (section) {
				if (matches) applyBlockFilter(section, this.query, { preserveStructure });
				else clearBlockFilter(section);
			}
		}
	}

	private clearEmbeds(): void {
		for (const el of this.embedEls()) {
			el.classList.remove('pf-embed-hidden');
			const section = el.querySelector<HTMLElement>('.markdown-preview-section');
			if (section) clearBlockFilter(section);
		}
	}
}

// Build the editor extension. Needs App for resolving/reading embedded files.
export function createLiveFilter(app: App): Extension {
	return [queryField, preserveStructureField, showEllipsesField, decoField, ViewPlugin.define((view) => new EmbedFilter(view, app))];
}
