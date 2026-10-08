// todo
// 1 new feature > filter page: in edit mode, right-click selected text > filter by term

import { Keymap, MarkdownView, Plugin, TFolder, View, WorkspaceLeaf, setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { createLiveFilter, setExcludeMode, setFilterQuery, setPreserveStructure, setShowEllipses } from './live-filter';
import { applyBlockFilter, clearBlockFilter } from './dom-filter';
import { DEFAULT_SETTINGS, FileFilterSettings, FileFilterSettingTab } from './settings';

interface PageFilterState {
	query: string;
	filterTimer: number | null;
	filePath: string;
	exclude: boolean;
}

interface PageFilterController {
	reapply: () => void; // re-apply after a mode switch
	destroy: () => void; // remove injected UI, listeners and timers
}

// Undocumented internals of the core file-explorer view, used to auto-expand
// collapsed folders that contain matches while a filter is active.
// The explorer is virtualized: only items near the viewport are in the DOM,
// so classes are set on each item's el (attached or not), and the scroller's
// cached heights are invalidated after any change that hides or shows items.
interface FileExplorerItem {
	collapsed?: boolean;
	setCollapsed?: (collapsed: boolean) => unknown;
	el?: HTMLElement;
	file?: unknown;
	vChildren?: { children: FileExplorerItem[] };
}
interface FileExplorerView extends View {
	fileItems: Record<string, FileExplorerItem | undefined>;
	// Also used to make the nav buttons act on the open folder in folder view
	createAbstractFile?: (type: 'file' | 'folder', parent: TFolder, newLeaf: unknown) => unknown;
	tree?: {
		setCollapseAll?: (collapsed: boolean) => void;
		requestSaveFolds?: () => void;
		infinityScroll?: { rootEl?: FileExplorerItem; invalidateAll?: () => void };
	};
}

export default class FileFilterPlugin extends Plugin {
	settings: FileFilterSettings = { ...DEFAULT_SETTINGS };

	private filterQuery = '';
	private filterActive = false;
	private filterTimer: number | null = null;
	private autoExpandedFolders = new Set<string>();
	// Folder view: the folder the explorer is narrowed to (null = whole vault),
	// and folders we expanded to show it, collapsed again on exit.
	private scopePath: string | null = null;
	private scopeExpandedFolders = new Set<string>();
	private pageFilters = new Map<HTMLElement, PageFilterController>();

	async loadSettings() {
		const data = (await this.loadData()) as Partial<FileFilterSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.syncEllipsesClass();
		this.reapplyPageFilters();
	}

	// 'Show ellipses' is global, so it's driven by a single class on each
	// window's <body> (main window and popouts). A class on the view container
	// would be wiped whenever Obsidian rewrites that element's classes.
	private syncEllipsesClass(remove = false) {
		const bodies = new Set<HTMLElement>([activeDocument.body]);
		this.app.workspace.iterateAllLeaves(leaf => {
			const body = leaf.view?.containerEl.ownerDocument.body;
			if (body) bodies.add(body);
		});
		const hide = !remove && !this.settings.showEllipses;
		bodies.forEach(body => body.classList.toggle('pf-no-ellipses', hide));
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
			this.syncEllipsesClass();
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.initExplorer();
			this.initPageFilters();
			this.reapplyPageFilters();
			this.syncEllipsesClass(); // covers newly opened popout windows
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
		this.registerEvent(this.app.vault.on('delete', file => {
			// Leave the folder view if the open folder (or an ancestor) went away
			const scope = this.scopePath;
			if (scope !== null && (scope === file.path || scope.startsWith(file.path + '/'))) this.setScope(null);
			if (this.filterActive) this.scheduleFilter();
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			// Follow the open folder when it (or an ancestor) is renamed or moved
			const scope = this.scopePath;
			if (scope !== null && (scope === oldPath || scope.startsWith(oldPath + '/'))) {
				this.scopePath = file.path + scope.slice(oldPath.length);
				const container = this.getExplorerContainer();
				if (container) this.applyScope(container);
			}
			if (this.filterActive) this.scheduleFilter();
		}));
	}

	onunload() {
		if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
		this.syncEllipsesClass(true);

		const container = this.getExplorerContainer();
		if (container) {
			this.setScope(null);
			this.clearFilter(container);
			container.querySelector('.ff-scope-header')?.remove();
			container.querySelector('.ff-search-btn')?.remove();
			container.querySelector('.ff-collapse-btn')?.remove();
			container.querySelector('.ff-native-collapse')?.classList.remove('ff-native-collapse', 'ff-hidden');
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

		// Folder view header — back arrow plus the open folder's name
		const scopeHeader = createEl('div', { cls: 'ff-scope-header ff-hidden' });
		const backBtn = scopeHeader.createEl('button', {
			cls: 'clickable-icon ff-scope-back',
			attr: { 'aria-label': 'Back' },
		});
		setIcon(backBtn, 'arrow-left');
		scopeHeader.createEl('span', { cls: 'ff-scope-label' });
		// The native Collapse all / Expand all toggle can't track the folder
		// view's state, so it's hidden and replaced by one that acts on the
		// open folder's subfolders (or every folder outside folder view).
		navButtons.querySelector('.lucide-chevrons-up-down, .lucide-chevrons-down-up')
			?.closest('.nav-action-button')?.classList.add('ff-native-collapse', 'ff-hidden');
		const collapseBtn = navButtons.createEl('button', { cls: 'clickable-icon nav-action-button ff-collapse-btn' });
		collapseBtn.addEventListener('click', () => {
			const folders = this.foldersInView();
			const collapse = folders.some(f => !f.collapsed);
			for (const f of folders) if (f.collapsed !== collapse) f.setCollapsed?.(collapse);
			(this.getExplorerLeaf()?.view as FileExplorerView | undefined)?.tree?.requestSaveFolds?.();
			this.syncCollapseBtn(container);
		});
		this.syncCollapseBtn(container);
		// Folders toggled by hand can change which action applies
		this.registerDomEvent(container, 'click', () => window.requestAnimationFrame(() => this.syncCollapseBtn(container)));
		searchContainer.before(scopeHeader);

		backBtn.addEventListener('click', () => {
			const path = this.scopePath;
			if (path === null) return;
			const slash = path.lastIndexOf('/');
			this.setScope(slash === -1 ? null : path.slice(0, slash));
		});

		// Clicking a folder's name opens it in the folder view; the chevron
		// still expands/collapses in place. Capture phase so Obsidian's own
		// toggle handler never sees the click.
		this.registerDomEvent(container, 'click', (e: MouseEvent) => {
			const target = e.target as HTMLElement;

			// In folder view, New note / New folder create inside the open folder
			const navBtn = target.closest('.nav-action-button');
			const type = navBtn?.querySelector('.lucide-edit') ? 'file' : navBtn?.querySelector('.lucide-folder-plus') ? 'folder' : null;
			if (type && this.scopePath !== null) {
				const folder = this.app.vault.getAbstractFileByPath(this.scopePath);
				const view = this.getExplorerLeaf()?.view as FileExplorerView | undefined;
				if (!(folder instanceof TFolder) || !view?.createAbstractFile) return;
				e.preventDefault();
				e.stopPropagation();
				view.createAbstractFile(type, folder, type === 'file' ? Keymap.isModEvent(e) || 'tab' : false);
				return;
			}

			const title = target.closest<HTMLElement>('.nav-folder-title');
			if (!title || target.closest('.collapse-icon') || title.parentElement?.classList.contains('mod-root')) return;
			const path = title.getAttribute('data-path');
			if (!path) return;
			e.preventDefault();
			e.stopPropagation();
			this.setScope(path);
		}, { capture: true });

		// Collapse all would also collapse the open folder and its ancestors,
		// leaving the folder view empty; re-expand them afterwards.
		const tree = (this.getExplorerLeaf()?.view as FileExplorerView | undefined)?.tree;
		const setCollapseAll = tree?.setCollapseAll;
		if (tree && setCollapseAll) {
			tree.setCollapseAll = (collapsed: boolean) => {
				setCollapseAll.call(tree, collapsed);
				if (this.scopePath !== null) this.expandScopeChain();
				this.applyScope(container);
			};
			this.register(() => delete tree.setCollapseAll);
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

		this.applyScope(container);

		// Restore state if the explorer pane (or the plugin) was recreated
		// while a filter was active
		if (this.filterQuery) {
			searchContainer.classList.remove('ff-hidden');
			searchInput.value = this.filterQuery;
			this.applyFilter(container);
		}
	}

	// Narrow the explorer to one folder (null shows the whole vault again).
	private setScope(path: string | null) {
		this.scopePath = path;
		const items = (this.getExplorerLeaf()?.view as FileExplorerView | undefined)?.fileItems;
		if (path === null) {
			for (const p of this.scopeExpandedFolders) items?.[p]?.setCollapsed?.(true);
			this.scopeExpandedFolders.clear();
		} else {
			this.expandScopeChain();
		}
		const container = this.getExplorerContainer();
		if (!container) return;
		this.applyScope(container);
		if (path !== null) this.getSearchEls(container).searchContainer?.classList.remove('ff-hidden');
		if (this.filterActive) this.scheduleFilter();
	}

	// Folders the collapse button acts on: the open folder's subfolders, or
	// every folder outside folder view
	private foldersInView(): FileExplorerItem[] {
		const items = (this.getExplorerLeaf()?.view as FileExplorerView | undefined)?.fileItems ?? {};
		const scope = this.scopePath;
		return Object.entries(items)
			.filter(([p, item]) => typeof item?.collapsed === 'boolean' && p !== '/' && (scope === null || p.startsWith(scope + '/')))
			.map(([, item]) => item as FileExplorerItem);
	}

	// Show the action the next click performs, like the native button
	private syncCollapseBtn(container: HTMLElement) {
		const btn = container.querySelector<HTMLElement>('.ff-collapse-btn');
		if (!btn) return;
		const collapse = this.foldersInView().some(f => !f.collapsed);
		setIcon(btn, collapse ? 'chevrons-down-up' : 'chevrons-up-down');
		btn.setAttribute('aria-label', collapse ? 'Collapse all' : 'Expand all');
	}

	// The open folder and its ancestors must be expanded to render it
	private expandScopeChain() {
		const items = (this.getExplorerLeaf()?.view as FileExplorerView | undefined)?.fileItems;
		const parts = this.scopePath?.split('/') ?? [];
		for (let i = 1; i <= parts.length; i++) {
			const p = parts.slice(0, i).join('/');
			if (!items?.[p]?.collapsed) continue;
			items[p]?.setCollapsed?.(false);
			this.scopeExpandedFolders.add(p);
		}
	}

	// Mark the open folder and its ancestors; CSS hides their titles, their
	// other children and their indent, so the folder's contents read as the root.
	private applyScope(container: HTMLElement) {
		const view = this.getExplorerLeaf()?.view as FileExplorerView | undefined;
		const items = view?.fileItems ?? {};
		for (const item of Object.values(items)) item?.el?.classList.remove('ff-scope-chain', 'ff-scope-root');
		const path = this.scopePath;
		container.classList.toggle('ff-scoped', path !== null);
		container.querySelector('.ff-scope-header')?.classList.toggle('ff-hidden', path === null);
		this.syncCollapseBtn(container);
		if (path !== null) {
			container.querySelector('.ff-scope-label')?.setText(path.split('/').pop() ?? path);
			const parts = path.split('/');
			for (let i = 1; i <= parts.length; i++) {
				const folder = items[parts.slice(0, i).join('/')]?.el;
				folder?.classList.add('ff-scope-chain');
				if (i === parts.length) folder?.classList.add('ff-scope-root');
			}
		}
		view?.tree?.infinityScroll?.invalidateAll?.();
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

		// In folder view, only the open folder's contents are searched, by
		// their path relative to it.
		const scope = this.scopePath;
		const inScope = (p: string): boolean => scope === null || p.startsWith(scope + '/');
		const rel = (p: string): string => (scope === null ? p : p.slice(scope.length + 1)).toLowerCase();

		// Folders whose path contains the query are matched in their own right;
		// a matched folder and everything inside it (files and subfolders, even
		// empty ones) is shown. The root folder (path '') is never a match.
		const allFolders = this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && inScope(f.path));
		const matchedFolderPaths = allFolders
			.filter(f => f.path !== '' && rel(f.path).includes(q))
			.map(f => f.path);
		const isUnderMatched = (p: string): boolean =>
			matchedFolderPaths.some(m => p === m || p.startsWith(m + '/'));

		// Files whose full path contains the query, or that live under a matched folder
		const matchingFilePaths = new Set(
			this.app.vault.getFiles()
				.filter(f => inScope(f.path) && (rel(f.path).includes(q) || isUnderMatched(f.path)))
				.map(f => f.path),
		);

		// Folders to display: ancestors needed to show matching files, every
		// matched folder (plus its ancestors, so it's reachable), and every
		// descendant folder of a matched folder.
		const foldersToShow = new Set<string>();
		const addWithAncestors = (path: string): void => {
			const parts = path.split('/');
			for (let i = 1; i <= parts.length; i++) {
				foldersToShow.add(parts.slice(0, i).join('/'));
			}
		};
		for (const filePath of matchingFilePaths) {
			const parts = filePath.split('/');
			for (let i = 1; i < parts.length; i++) {
				foldersToShow.add(parts.slice(0, i).join('/'));
			}
		}
		for (const m of matchedFolderPaths) addWithAncestors(m);
		for (const f of allFolders) {
			if (f.path !== '' && isUnderMatched(f.path)) foldersToShow.add(f.path);
		}

		// Matches inside collapsed folders have no DOM nodes until the folder
		// expands; if anything was expanded, run again so the new nodes get
		// classified (the second pass expands nothing, so this terminates).
		if (this.expandFolders(foldersToShow)) this.scheduleFilter();

		container.classList.add('ff-filtering');

		const view = this.getExplorerLeaf()?.view as FileExplorerView | undefined;
		for (const [path, item] of Object.entries(view?.fileItems ?? {})) {
			const el = item?.el;
			if (!el) continue;
			const show = item.file instanceof TFolder
				? foldersToShow.has(path) || el.classList.contains('ff-scope-chain')
				: matchingFilePaths.has(path);
			el.classList.toggle('ff-no-match', !show);
		}

		this.markSidebarGaps();
		this.filterActive = true;
		view?.tree?.infinityScroll?.invalidateAll?.();
	}

	private clearFilter(container: HTMLElement) {
		container.classList.remove('ff-filtering');
		const view = this.getExplorerLeaf()?.view as FileExplorerView | undefined;
		for (const item of Object.values(view?.fileItems ?? {})) {
			item?.el?.classList.remove('ff-no-match', 'ff-gap-before', 'ff-gap-after');
		}
		this.restoreCollapsedFolders();
		this.filterActive = false;
		view?.tree?.infinityScroll?.invalidateAll?.();
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

	// Mark where runs of hidden siblings were with a '···' drawn by CSS on the
	// next shown sibling (or, for a trailing run, the previous one). Inserted
	// DOM nodes would be wiped by the virtualized explorer on scroll.
	private markSidebarGaps() {
		const view = this.getExplorerLeaf()?.view as FileExplorerView | undefined;
		const items = Object.values(view?.fileItems ?? {});
		for (const item of items) item?.el?.classList.remove('ff-gap-before', 'ff-gap-after');
		const scope = this.scopePath;
		for (const parent of [view?.tree?.infinityScroll?.rootEl, ...items]) {
			if (!parent?.vChildren) continue;
			// In folder view only the open folder and its subfolders count;
			// siblings of the folder-view chain are hidden anyway
			const path = parent.file instanceof TFolder ? parent.file.path : '';
			if (scope !== null && path !== scope && !path.startsWith(scope + '/')) continue;
			let gap = false;
			let last: HTMLElement | undefined;
			for (const child of parent.vChildren.children) {
				if (!child.el) continue;
				if (child.el.classList.contains('ff-no-match')) {
					gap = true;
				} else {
					if (gap) child.el.classList.add('ff-gap-before');
					gap = false;
					last = child.el;
				}
			}
			if (gap) last?.classList.add('ff-gap-after');
		}
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

		const searchRow = searchContainer.createEl('div', { cls: 'pf-search-row' });
		// Include/exclude mode toggle — leftmost so the current mode reads first.
		const excludeBtn = searchRow.createEl('button', {
			cls: 'clickable-icon pf-exclude-toggle',
		});
		const searchInput = searchRow.createEl('input', {
			type: 'text',
			cls: 'pf-search-input',
			placeholder: 'Filter paragraphs…',
			attr: { spellcheck: 'false' },
		});
		const clearBtn = searchRow.createEl('button', {
			cls: 'clickable-icon pf-search-clear',
			attr: { 'aria-label': 'Clear filter' },
		});
		setIcon(clearBtn, 'x');

		// Inline mirrors of the plugin settings — toggling one here changes the
		// setting itself, so the settings tab and every open filter follow.
		const optionsRow = searchContainer.createEl('div', { cls: 'pf-search-options' });
		const addOption = (label: string, apply: (checked: boolean) => void): HTMLInputElement => {
			const option = optionsRow.createEl('label', { cls: 'pf-search-option' });
			const checkbox = option.createEl('input', { type: 'checkbox' });
			option.appendText(label);
			checkbox.addEventListener('change', () => {
				apply(checkbox.checked);
				void this.saveSettings(); // re-applies every open filter
			});
			return checkbox;
		};
		const preserveToggle = addOption('Preserve structure', checked => {
			this.settings.preserveStructure = checked;
		});
		const ellipsesToggle = addOption('Show ellipses', checked => {
			this.settings.showEllipses = checked;
		});

		const syncOptions = () => {
			preserveToggle.checked = this.settings.preserveStructure;
			ellipsesToggle.checked = this.settings.showEllipses;
		};
		syncOptions();

		const viewHeader = viewEl.querySelector('.view-header');
		if (viewHeader) {
			viewHeader.after(searchContainer);
		} else {
			viewEl.prepend(searchContainer);
		}

		const state: PageFilterState = { query: '', filterTimer: null, filePath: '', exclude: false };

		const updateExcludeBtn = () => {
			setIcon(excludeBtn, state.exclude ? 'filter-x' : 'filter');
			excludeBtn.classList.toggle('is-active', state.exclude);
			excludeBtn.setAttribute(
				'aria-label',
				state.exclude ? 'Hiding matches — click to show matches instead' : 'Showing matches — click to hide matches instead',
			);
			searchInput.placeholder = state.exclude ? 'Filter out paragraphs…' : 'Filter paragraphs…';
		};
		updateExcludeBtn();

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
			if (section) applyBlockFilter(section, state.query, {
				preserveStructure: this.settings.preserveStructure,
				exclude: state.exclude,
			});
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
					setShowEllipses.of(this.settings.showEllipses),
					setExcludeMode.of(state.exclude),
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
			state.exclude = false; // next open starts in include mode
			updateExcludeBtn();
			clearPreviewFilter();
			clearSourceFilter();
		};

		excludeBtn.addEventListener('click', () => {
			state.exclude = !state.exclude;
			updateExcludeBtn();
			scheduleCurrentFilter();
			searchInput.focus();
		});

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
			// A leading '-' is consumed and flips include/exclude mode.
			if (searchInput.value.startsWith('-')) {
				searchInput.value = searchInput.value.slice(1);
				state.exclude = !state.exclude;
				updateExcludeBtn();
			}
			state.query = searchInput.value;
			scheduleCurrentFilter();
		});

		searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') { deactivate(); return; }
			// Backspace at the start deletes the consumed '-': back to include mode.
			if (e.key === 'Backspace' && state.exclude && searchInput.selectionStart === 0 && searchInput.selectionEnd === 0) {
				e.preventDefault();
				state.exclude = false;
				updateExcludeBtn();
				scheduleCurrentFilter();
				return;
			}
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
				// Keep the inline toggles in sync when a setting changed
				// elsewhere (settings tab or another view's toggle).
				syncOptions();
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
