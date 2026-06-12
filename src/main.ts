// todo
// New feature: 'todo' and 'task' strings also return `- [ ]`
// New feature: filter out : instead of filtering for a term you want to see, you filter out a term you don't want to see. E.g. filter out 'done' tasks.
// filter in embeds not working?
// new feature: add a checkbox under the filter input with title 'preserve structure'. checkbox mirrors the state of 'preserve structure' that's in the settings. toggling the checkbox under the filter input has the same effect: showing/hiding the structure of the matching paragraphs.
// 1 new feature > filter page: in edit mode, right-click selected text > filter by term

import { MarkdownView, Plugin, View, WorkspaceLeaf, setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { createLiveFilter, setFilterQuery, setPreserveStructure } from './live-filter';
import { applyBlockFilter, clearBlockFilter } from './dom-filter';
import { DEFAULT_SETTINGS, FileFilterSettings, FileFilterSettingTab } from './settings';

interface PageFilterState {
	query: string;
	filterTimer: number | null;
	filePath: string;
}

interface PageFilterController {
	reapply: () => void; // re-apply after a mode switch
	destroy: () => void; // remove injected UI, listeners and timers
}

// Undocumented internals of the core file-explorer view, used to auto-expand
// collapsed folders that contain matches while a filter is active.
interface FileExplorerItem {
	collapsed?: boolean;
	setCollapsed?: (collapsed: boolean) => unknown;
}
interface FileExplorerView extends View {
	fileItems: Record<string, FileExplorerItem | undefined>;
}

export default class FileFilterPlugin extends Plugin {
	settings: FileFilterSettings = { ...DEFAULT_SETTINGS };

	private filterQuery = '';
	private filterActive = false;
	private filterTimer: number | null = null;
	private autoExpandedFolders = new Set<string>();
	private pageFilters = new Map<HTMLElement, PageFilterController>();

	async loadSettings() {
		const data = (await this.loadData()) as Partial<FileFilterSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.reapplyPageFilters();
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new FileFilterSettingTab(this.app, this));

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
		// A leaf can be reused for a different file without a layout change;
		// reapply() notices the file swap and drops the stale filter.
		this.registerEvent(this.app.workspace.on('file-open', () => {
			this.reapplyPageFilters();
		}));

		this.addCommand({
			id: 'toggle-page-filter',
			name: 'Filter page',
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
			id: 'focus-explorer-filter',
			name: 'Filter sidebar',
			callback: () => this.openSearch(),
		});

		// Re-apply filter when vault contents change while a filter is active
		this.registerEvent(this.app.vault.on('create', () => { if (this.filterActive) this.scheduleFilter(); }));
		this.registerEvent(this.app.vault.on('delete', () => { if (this.filterActive) this.scheduleFilter(); }));
		this.registerEvent(this.app.vault.on('rename', () => { if (this.filterActive) this.scheduleFilter(); }));
	}

	onunload() {
		if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);

		const container = this.getExplorerContainer();
		if (container) {
			this.clearFilter(container);
			container.querySelector('.ff-search-btn')?.remove();
			container.querySelector('.ff-search-container')?.remove();
		}

		// Each controller removes its own injected UI, filter state, listeners
		// and timers — including views living in popout windows.
		this.pageFilters.forEach(({ destroy }) => destroy());
		this.pageFilters.clear(); // CM6 decorations are removed by the editor-extension teardown
	}

	private getExplorerLeaf(): WorkspaceLeaf | null {
		return this.app.workspace.getLeavesOfType('file-explorer')[0] ?? null;
	}

	private getExplorerContainer(): HTMLElement | null {
		return this.getExplorerLeaf()?.view?.containerEl ?? null;
	}

	// Resolve the injected elements from the current container each time — the
	// explorer pane can be closed and recreated, so element references held
	// across calls would go stale.
	private getSearchEls(container: HTMLElement) {
		return {
			searchContainer: container.querySelector<HTMLElement>('.ff-search-container'),
			searchInput: container.querySelector<HTMLInputElement>('.ff-search-input'),
		};
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

		searchBtn.addEventListener('click', () => this.toggleSearch(container));
		clearBtn.addEventListener('click', () => this.deactivateSearch(container));
		searchInput.addEventListener('input', () => {
			this.filterQuery = searchInput.value;
			this.scheduleFilter();
		});
		searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') this.deactivateSearch(container);
		});

		// Restore state if the explorer pane (or the plugin) was recreated
		// while a filter was active
		if (this.filterQuery) {
			searchContainer.classList.remove('ff-hidden');
			searchInput.value = this.filterQuery;
			this.applyFilter(container);
		}
	}

	private toggleSearch(container: HTMLElement) {
		const { searchContainer } = this.getSearchEls(container);
		if (!searchContainer) return;
		if (searchContainer.classList.contains('ff-hidden')) {
			this.openSearch();
		} else {
			this.deactivateSearch(container);
		}
	}

	private openSearch() {
		const container = this.getExplorerContainer();
		if (!container) return;
		const { searchContainer, searchInput } = this.getSearchEls(container);
		if (!searchContainer || !searchInput) return;
		searchContainer.classList.remove('ff-hidden');
		searchInput.focus();
		searchInput.select();
	}

	private deactivateSearch(container: HTMLElement) {
		const { searchContainer, searchInput } = this.getSearchEls(container);
		if (!searchContainer || !searchInput) return;
		searchContainer.classList.add('ff-hidden');
		searchInput.value = '';
		this.filterQuery = '';
		this.clearFilter(container);
	}

	private scheduleFilter() {
		if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
		this.filterTimer = window.setTimeout(() => {
			this.filterTimer = null;
			// Resolve at fire time — the pane may have been recreated meanwhile
			const el = this.getExplorerContainer();
			if (el) this.applyFilter(el);
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

		// Matches inside collapsed folders have no DOM nodes until the folder
		// expands; if anything was expanded, run again so the new nodes get
		// classified (the second pass expands nothing, so this terminates).
		if (this.expandFolders(neededFolderPaths)) this.scheduleFilter();

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
		this.restoreCollapsedFolders();
		this.filterActive = false;
	}

	// Expand collapsed folders that contain matches, remembering which ones we
	// touched so clearFilter() can restore them. A folder the user re-collapses
	// while filtering stays collapsed (it remains in the set, so it isn't
	// re-expanded). Returns true if anything was expanded.
	private expandFolders(paths: Set<string>): boolean {
		const items = (this.getExplorerLeaf()?.view as FileExplorerView | undefined)?.fileItems;
		if (!items) return false;
		let expanded = false;
		for (const path of paths) {
			const item = items[path];
			if (!item?.collapsed || this.autoExpandedFolders.has(path)) continue;
			item.setCollapsed?.(false);
			this.autoExpandedFolders.add(path);
			expanded = true;
		}
		return expanded;
	}

	private restoreCollapsedFolders() {
		const items = (this.getExplorerLeaf()?.view as FileExplorerView | undefined)?.fileItems;
		if (items) {
			for (const path of this.autoExpandedFolders) {
				items[path]?.setCollapsed?.(true);
			}
		}
		this.autoExpandedFolders.clear();
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
		this.pageFilters.forEach((controller, viewEl) => {
			if (!viewEl.isConnected) {
				controller.destroy(); // cancel pending timers; element ops are no-ops
				this.pageFilters.delete(viewEl);
				return;
			}
			controller.reapply();
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

		const state: PageFilterState = { query: '', filterTimer: null, filePath: '' };

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
		// Reading mode re-renders blocks on edits and renders them lazily on
		// scroll, which wipes the applied filter classes — so while a filter is
		// active in preview mode, watch the reading view and re-apply after
		// external mutations. The observer is paused around our own DOM writes
		// to keep them from re-triggering it.
		const observer = new MutationObserver(() => {
			if (state.query) scheduleCurrentFilter();
		});
		const stopObserving = () => observer.disconnect();
		const startObserving = () => {
			const target = viewEl.querySelector('.markdown-reading-view');
			if (target) observer.observe(target, { childList: true, subtree: true });
		};

		const clearPreviewFilter = () => {
			stopObserving();
			const section = getPreviewSection();
			if (section) clearBlockFilter(section);
		};

		const applyPreviewFilter = () => {
			stopObserving();
			const section = getPreviewSection();
			if (section) applyBlockFilter(section, state.query, { preserveStructure: this.settings.preserveStructure });
			if (state.query) startObserving();
		};

		// ── Live Preview / Source mode (CM6 decorations) ──────────────────────
		const getCmView = (): EditorView | null => {
			const editor = (leaf.view as MarkdownView)?.editor as { cm?: EditorView } | undefined;
			const cm = editor?.cm;
			return cm?.dom.isConnected ? cm : null;
		};

		const applySourceFilter = () => {
			const cm = getCmView();
			if (cm) cm.dispatch({
				effects: [
					setFilterQuery.of(state.query.trim().toLowerCase()),
					setPreserveStructure.of(this.settings.preserveStructure),
				],
			});
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
				stopObserving(); // the hidden preview DOM doesn't need watching
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
			if (state.filterTimer !== null) {
				window.clearTimeout(state.filterTimer);
				state.filterTimer = null;
			}
			searchContainer.classList.add('ff-hidden');
			searchInput.value = '';
			state.query = '';
			clearPreviewFilter();
			clearSourceFilter();
		};

		searchBtn.addEventListener('click', () => {
			// Open in whatever mode is active — no longer forces reading mode.
			if (searchContainer.classList.contains('ff-hidden')) {
				state.filePath = (leaf.view as MarkdownView).file?.path ?? '';
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
		// A plain listener (not registerDomEvent) so destroy() can remove it when
		// the view closes, instead of accumulating registrations until unload.
		const onViewClick = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (!target.classList.contains('pf-ellipsis') && !target.classList.contains('cm-pf-ellipsis')) return;
			e.preventDefault();
			e.stopPropagation();
			previousQuery = searchInput.value;
			searchInput.value = '';
			state.query = '';
			scheduleCurrentFilter();
			searchInput.focus();
		};
		viewEl.addEventListener('click', onViewClick);

		const destroy = () => {
			deactivate();
			viewEl.removeEventListener('click', onViewClick);
			searchBtn.remove();
			searchContainer.remove();
		};

		this.pageFilters.set(viewEl, {
			reapply: () => {
				if (searchContainer.classList.contains('ff-hidden')) return;
				// The same leaf can be reused for a different file — drop the
				// filter rather than carry a stale query across files.
				if (((leaf.view as MarkdownView).file?.path ?? '') !== state.filePath) {
					deactivate();
					return;
				}
				if (state.query) scheduleCurrentFilter();
			},
			destroy,
		});
	}

}
