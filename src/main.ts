// todo
// 1 factor out reading mode > edit functionality. may include in another plugin.
// 2 edit mode > filter > matching text should have border and background.
// 3 filter page: right-click selected text > filter by term (broke page filter + edit icons — needs investigation before reimplementing)

import { MarkdownView, Plugin, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { ParagraphEditor } from './paragraph-editor'; // [paragraph-editor]
import { createLiveFilter, setFilterQuery } from './live-filter';
import { applyBlockFilter, clearBlockFilter } from './dom-filter';

interface PageFilterState {
	query: string;
	filterTimer: number | null;
}

export default class FileFilterPlugin extends Plugin {
	private filterQuery = '';
	private filterActive = false;
	private searchContainerEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private filterTimer: number | null = null;
	private paragraphEditors = new Map<HTMLElement, ParagraphEditor>(); // [paragraph-editor]
	private pageFilters = new Map<HTMLElement, () => void>(); // viewEl → re-apply after a mode switch

	async onload() {

		// Filtering for Live Preview / Source mode is driven by this CM6 editor
		// extension; reading mode uses the DOM-based filter further below.
		this.registerEditorExtension(createLiveFilter(this.app));

		this.app.workspace.onLayoutReady(() => {
			this.initExplorer();
			this.initPageFilters();
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.initExplorer();
			this.initPageFilters();
			this.reapplyPageFilters();
		}));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			this.initPageFilters();
			this.reapplyPageFilters();
		}));

		this.addCommand({
			id: 'toggle-page-filter',
			name: 'Toggle page filter',
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return;

				// Open the filter in whatever mode is active — reading and
				// Live Preview / Source each have their own implementation.
				const container = view.containerEl.querySelector<HTMLElement>('.pf-search-container');
				const input = view.containerEl.querySelector<HTMLInputElement>('.pf-search-input');
				if (!container || !input) return;
				if (container.classList.contains('ff-hidden')) {
					view.containerEl.querySelector<HTMLElement>('.pf-search-btn')?.click();
				} else {
					input.focus();
					input.select();
				}
			},
		});

		this.addCommand({
			id: 'focus-file-filter',
			name: 'Focus file filter',
			callback: () => this.openSearch(),
		});

		// Re-apply filter when vault contents change while a filter is active
		this.registerEvent(this.app.vault.on('create', () => { if (this.filterActive) this.scheduleFilter(); }));
		this.registerEvent(this.app.vault.on('delete', () => { if (this.filterActive) this.scheduleFilter(); }));
		this.registerEvent(this.app.vault.on('rename', () => { if (this.filterActive) this.scheduleFilter(); }));
	}

	onunload() {
		const container = this.getExplorerContainer();
		if (container) this.clearFilter(container);
		container?.querySelector('.ff-search-btn')?.remove();
		this.searchContainerEl?.remove();

		// Clean up all injected page filter elements
		activeDocument.querySelectorAll('.pf-search-btn, .pf-search-container, .pf-ellipsis').forEach(el => el.remove());
		activeDocument.querySelectorAll('.pf-filtering').forEach(el => el.classList.remove('pf-filtering'));
		activeDocument.querySelectorAll('.pf-no-match').forEach(el => el.classList.remove('pf-no-match'));
		this.paragraphEditors.forEach(e => e.destroy()); // [paragraph-editor]
		this.paragraphEditors.clear(); // [paragraph-editor]
		this.pageFilters.clear(); // CM6 decorations are removed by the editor-extension teardown
	}

	private getExplorerContainer(): HTMLElement | null {
		const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
		return leaf?.view?.containerEl ?? null;
	}

	private initExplorer() {
		const container = this.getExplorerContainer();
		if (!container) return;
		if (container.querySelector('.ff-search-btn')) return; // already injected

		const navButtons = container.querySelector('.nav-buttons-container');
		if (!navButtons) return;

		// Search toggle button — inserted as first child so it appears leftmost
		const searchBtn = createEl('button', {
			cls: 'clickable-icon nav-action-button ff-search-btn',
			attr: { 'aria-label': 'Filter files' },
		});
		setIcon(searchBtn, 'filter');
		navButtons.insertBefore(searchBtn, navButtons.firstChild);

		// Search bar — sits between nav-header and the file tree
		const searchContainer = createEl('div', { cls: 'ff-search-container ff-hidden' });

		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			cls: 'ff-search-input',
			placeholder: 'Filter files…',
			attr: { spellcheck: 'false' },
		});
		const clearBtn = searchContainer.createEl('button', {
			cls: 'clickable-icon ff-search-clear',
			attr: { 'aria-label': 'Clear filter' },
		});
		setIcon(clearBtn, 'x');

		const navHeader = container.querySelector('.nav-header');
		if (navHeader) {
			navHeader.after(searchContainer);
		} else {
			container.prepend(searchContainer);
		}

		this.searchContainerEl = searchContainer;
		this.searchInputEl = searchInput;

		searchBtn.addEventListener('click', () => this.toggleSearch(container));
		clearBtn.addEventListener('click', () => this.deactivateSearch(container));
		searchInput.addEventListener('input', () => {
			this.filterQuery = searchInput.value;
			this.scheduleFilter(container);
		});
		searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') this.deactivateSearch(container);
		});

		// Restore state if plugin was reloaded while filter was active
		if (this.filterQuery) {
			searchContainer.classList.remove('ff-hidden');
			searchInput.value = this.filterQuery;
			this.applyFilter(container);
		}
	}

	private toggleSearch(container: HTMLElement) {
		if (!this.searchContainerEl) return;
		if (this.searchContainerEl.classList.contains('ff-hidden')) {
			this.openSearch();
		} else {
			this.deactivateSearch(container);
		}
	}

	private openSearch() {
		if (!this.searchContainerEl || !this.searchInputEl) return;
		this.searchContainerEl.classList.remove('ff-hidden');
		this.searchInputEl.focus();
		this.searchInputEl.select();
	}

	private deactivateSearch(container: HTMLElement) {
		if (!this.searchContainerEl || !this.searchInputEl) return;
		this.searchContainerEl.classList.add('ff-hidden');
		this.searchInputEl.value = '';
		this.filterQuery = '';
		this.clearFilter(container);
	}

	private scheduleFilter(container?: HTMLElement) {
		if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
		this.filterTimer = window.setTimeout(() => {
			const el = container ?? this.getExplorerContainer();
			if (el) this.applyFilter(el);
			this.filterTimer = null;
		}, 50);
	}

	private applyFilter(container: HTMLElement) {
		const q = this.filterQuery.trim().toLowerCase();

		if (!q) {
			this.clearFilter(container);
			return;
		}

		// Files whose full path contains the query
		const matchingFilePaths = new Set(
			this.app.vault.getFiles()
				.filter(f => f.path.toLowerCase().includes(q))
				.map(f => f.path),
		);

		// All ancestor folder paths needed to show directory structure
		const neededFolderPaths = new Set<string>();
		for (const filePath of matchingFilePaths) {
			const parts = filePath.split('/');
			for (let i = 1; i < parts.length; i++) {
				neededFolderPaths.add(parts.slice(0, i).join('/'));
			}
		}

		container.classList.add('ff-filtering');

		container.querySelectorAll<HTMLElement>('.nav-file').forEach(el => {
			const path = el.querySelector('.nav-file-title')?.getAttribute('data-path') ?? '';
			el.classList.toggle('ff-no-match', !matchingFilePaths.has(path));
		});

		container.querySelectorAll<HTMLElement>('.nav-folder').forEach(el => {
			// :scope > ensures we get the direct title child, not a nested folder's title
			const path = el.querySelector(':scope > .nav-folder-title')?.getAttribute('data-path') ?? '';
			const isRoot = el.classList.contains('mod-root') || path === '';
			const show = isRoot || neededFolderPaths.has(path);
			el.classList.toggle('ff-no-match', !show);
		});

		this.insertSidebarEllipses(container);
		this.filterActive = true;
	}

	private clearFilter(container: HTMLElement) {
		this.removeSidebarEllipses(container);
		container.classList.remove('ff-filtering');
		container.querySelectorAll('.ff-no-match').forEach(el => el.classList.remove('ff-no-match'));
		this.filterActive = false;
	}

	private insertSidebarEllipses(container: HTMLElement) {
		this.removeSidebarEllipses(container);
		container.querySelectorAll<HTMLElement>('.nav-folder-children').forEach(group => {
			const items = Array.from(group.children).filter(
				el => el.classList.contains('nav-file') || el.classList.contains('nav-folder'),
			) as HTMLElement[];
			let i = 0;
			while (i < items.length) {
				if (items[i]!.classList.contains('ff-no-match')) {
					let end = i;
					while (end < items.length && items[end]!.classList.contains('ff-no-match')) end++;
					const dot = createEl('div', { cls: 'ff-ellipsis', text: '···' });
					if (end < items.length) group.insertBefore(dot, items[end]!);
					else group.appendChild(dot);
					i = end;
				} else {
					i++;
				}
			}
		});
	}

	private removeSidebarEllipses(container: HTMLElement) {
		container.querySelectorAll('.ff-ellipsis').forEach(el => el.remove());
	}

	private initPageFilters() {
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => this.initPageFilter(leaf));
	}

	// Re-apply any open filter in its current mode (e.g. after a reading ⇄ Live
	// Preview switch) and prune controllers for closed views.
	private reapplyPageFilters() {
		this.pageFilters.forEach((reapply, viewEl) => {
			if (!viewEl.isConnected) {
				this.pageFilters.delete(viewEl);
				return;
			}
			reapply();
		});
	}

	private initPageFilter(leaf: WorkspaceLeaf) {
		const viewEl = leaf.view?.containerEl;
		if (!viewEl) return;
		if (viewEl.querySelector('.pf-search-btn')) return;

		const viewActions = viewEl.querySelector('.view-actions');
		if (!viewActions) return;

		const searchBtn = createEl('button', {
			cls: 'clickable-icon view-action pf-search-btn',
			attr: { 'aria-label': 'Filter paragraphs' },
		});
		setIcon(searchBtn, 'filter');
		viewActions.prepend(searchBtn);

		const searchContainer = createEl('div', { cls: 'pf-search-container ff-hidden' });

		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			cls: 'pf-search-input',
			placeholder: 'Filter paragraphs…',
			attr: { spellcheck: 'false' },
		});
		const clearBtn = searchContainer.createEl('button', {
			cls: 'clickable-icon pf-search-clear',
			attr: { 'aria-label': 'Clear filter' },
		});
		setIcon(clearBtn, 'x');

		const viewHeader = viewEl.querySelector('.view-header');
		if (viewHeader) {
			viewHeader.after(searchContainer);
		} else {
			viewEl.prepend(searchContainer);
		}

		const state: PageFilterState = { query: '', filterTimer: null };

		// Scope to the active reading view. A bare '.markdown-preview-section'
		// lookup also matches sections rendered inside the hidden source view
		// (e.g. Live Preview embeds), which sit earlier in the DOM — querySelector
		// would then return a hidden section and reading-mode filtering would
		// silently target the wrong element. The reading view's outermost section
		// comes first in tree order, so it's the correct match here.
		const getPreviewSection = () =>
			viewEl.querySelector<HTMLElement>('.markdown-reading-view .markdown-preview-section');

		// ── Reading mode (DOM-based) ──────────────────────────────────────────
		// Block-level filtering lives in dom-filter.ts (shared with embeds).
		const clearPreviewFilter = () => {
			const section = getPreviewSection();
			if (section) clearBlockFilter(section);
		};

		const applyPreviewFilter = () => {
			const section = getPreviewSection();
			if (section) applyBlockFilter(section, state.query);
		};

		// ── Live Preview / Source mode (CM6 decorations) ──────────────────────
		const getCmView = (): EditorView | null => {
			const editor = (leaf.view as MarkdownView)?.editor as { cm?: EditorView } | undefined;
			const cm = editor?.cm;
			return cm?.dom.isConnected ? cm : null;
		};

		const applySourceFilter = () => {
			const cm = getCmView();
			if (cm) cm.dispatch({ effects: setFilterQuery.of(state.query.trim().toLowerCase()) });
		};

		const clearSourceFilter = () => {
			const cm = getCmView();
			if (cm) cm.dispatch({ effects: setFilterQuery.of('') });
		};

		// ── Dispatch to whichever mode is active ──────────────────────────────
		// Each mode renders independently, so the inactive mode's leftover state
		// is never visible — only the active mode is touched here. Cross-mode
		// cleanup happens on deactivate() and on a mode switch (reapply below).
		const applyFilter = () => {
			if ((leaf.view as MarkdownView).getMode() === 'preview') {
				applyPreviewFilter();
			} else {
				applySourceFilter();
			}
		};

		const scheduleCurrentFilter = () => {
			if (state.filterTimer !== null) window.clearTimeout(state.filterTimer);
			state.filterTimer = window.setTimeout(() => {
				applyFilter();
				state.filterTimer = null;
			}, 50);
		};

		const deactivate = () => {
			searchContainer.classList.add('ff-hidden');
			searchInput.value = '';
			state.query = '';
			clearPreviewFilter();
			clearSourceFilter();
		};

		// Re-apply the active query after a mode switch (reading ⇄ Live Preview).
		this.pageFilters.set(viewEl, () => {
			if (!searchContainer.classList.contains('ff-hidden') && state.query) scheduleCurrentFilter();
		});

		searchBtn.addEventListener('click', () => {
			// Open in whatever mode is active — no longer forces reading mode.
			if (searchContainer.classList.contains('ff-hidden')) {
				searchContainer.classList.remove('ff-hidden');
				searchInput.focus();
				searchInput.select();
			} else {
				deactivate();
			}
		});

		clearBtn.addEventListener('click', deactivate);

		let previousQuery = '';

		searchInput.addEventListener('input', () => {
			previousQuery = ''; // user typed manually — forget ellipsis-click undo state
			state.query = searchInput.value;
			scheduleCurrentFilter();
		});

		searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') { deactivate(); return; }
			// Restore query after an ellipsis-click clear (only when input is empty)
			if ((e.metaKey || e.ctrlKey) && e.key === 'z' && previousQuery && searchInput.value === '') {
				e.preventDefault();
				searchInput.value = previousQuery;
				state.query = previousQuery;
				previousQuery = '';
				scheduleCurrentFilter();
				searchInput.select();
			}
		});

		// Click an ellipsis → clear the query; Ctrl/Cmd+Z restores it.
		// Handles both the reading-mode ellipsis and the CM6 block-widget one.
		this.registerDomEvent(viewEl, 'click', (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (!target.classList.contains('pf-ellipsis') && !target.classList.contains('cm-pf-ellipsis')) return;
			e.preventDefault();
			e.stopPropagation();
			previousQuery = searchInput.value;
			searchInput.value = '';
			state.query = '';
			scheduleCurrentFilter();
			searchInput.focus();
		});

		// [paragraph-editor]
		const getFile = (): TFile | null => (leaf.view as MarkdownView)?.file ?? null;
		const pgEditor = new ParagraphEditor(this.app);
		this.paragraphEditors.set(viewEl, pgEditor);
		pgEditor.attach(viewEl, getFile, scheduleCurrentFilter);
		// [paragraph-editor]
	}

}
