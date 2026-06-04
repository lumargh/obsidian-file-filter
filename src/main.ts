// todo
// filter page: allow select text + right click > filter by term
// filter sidebar: add visual indicator of hidden folders and files in the sidebar, in the same way as on the page.

import { MarkdownView, Plugin, WorkspaceLeaf, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, FileFilterSettings, FileFilterSettingTab } from './settings';

interface PageFilterState {
	query: string;
	filterTimer: number | null;
}

export default class FileFilterPlugin extends Plugin {
	settings!: FileFilterSettings;

	private filterQuery = '';
	private filterActive = false;
	private searchContainerEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private filterTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new FileFilterSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.initExplorer();
			this.initPageFilters();
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.initExplorer();
			this.initPageFilters();
		}));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.initPageFilters()));

		this.addCommand({
			id: 'toggle-page-filter',
			name: 'Toggle page filter',
			hotkeys: [{ modifiers: ['Mod'], key: 'f' }],
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return;
				const container = view.containerEl.querySelector<HTMLElement>('.pf-search-container');
				const input = view.containerEl.querySelector<HTMLInputElement>('.pf-search-input');
				if (!container || !input) return;
				if (container.style.display === 'none') {
					view.containerEl.querySelector<HTMLElement>('.pf-search-btn')?.click();
				} else {
					input.focus();
					input.select();
				}
			},
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
		document.querySelectorAll('.pf-search-btn, .pf-search-container, .pf-ellipsis').forEach(el => el.remove());
		document.querySelectorAll('.pf-filtering').forEach(el => el.classList.remove('pf-filtering'));
		document.querySelectorAll('.pf-no-match').forEach(el => el.classList.remove('pf-no-match'));
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
		const searchContainer = createEl('div', { cls: 'ff-search-container' });
		searchContainer.style.display = 'none';

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
			searchContainer.style.display = '';
			searchInput.value = this.filterQuery;
			this.applyFilter(container);
		}
	}

	private toggleSearch(container: HTMLElement) {
		if (!this.searchContainerEl) return;
		if (this.searchContainerEl.style.display === 'none') {
			this.openSearch();
		} else {
			this.deactivateSearch(container);
		}
	}

	private openSearch() {
		if (!this.searchContainerEl || !this.searchInputEl) return;
		this.searchContainerEl.style.display = '';
		this.searchInputEl.focus();
		this.searchInputEl.select();
	}

	private deactivateSearch(container: HTMLElement) {
		if (!this.searchContainerEl || !this.searchInputEl) return;
		this.searchContainerEl.style.display = 'none';
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

		const searchContainer = createEl('div', { cls: 'pf-search-container' });
		searchContainer.style.display = 'none';

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

		const getPreviewSection = () => viewEl.querySelector<HTMLElement>('.markdown-preview-section');

		const highlightTextNodes = (el: Node, q: string) => {
			if (el.nodeType === Node.TEXT_NODE) {
				const text = el.textContent ?? '';
				const lower = text.toLowerCase();
				if (!lower.includes(q)) return;
				const frag = document.createDocumentFragment();
				let last = 0;
				let i = lower.indexOf(q, 0);
				while (i !== -1) {
					if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
					const span = document.createElement('span');
					span.className = 'pf-highlight';
					span.textContent = text.slice(i, i + q.length);
					frag.appendChild(span);
					last = i + q.length;
					i = lower.indexOf(q, last);
				}
				if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
				el.parentNode?.replaceChild(frag, el);
			} else if (el.nodeType === Node.ELEMENT_NODE && !(el as Element).classList.contains('pf-highlight')) {
				Array.from(el.childNodes).forEach(child => highlightTextNodes(child, q));
			}
		};

		const clearHighlights = (root: HTMLElement) => {
			root.querySelectorAll('.pf-highlight').forEach(span => {
				const parent = span.parentNode;
				if (!parent) return;
				parent.replaceChild(document.createTextNode(span.textContent ?? ''), span);
				parent.normalize();
			});
		};

		const insertPageEllipses = (section: HTMLElement) => {
			section.querySelectorAll('.pf-ellipsis').forEach(el => el.remove());
			const blocks = Array.from(section.querySelectorAll<HTMLElement>(':scope > div'));
			let i = 0;
			while (i < blocks.length) {
				if (blocks[i]!.classList.contains('pf-no-match')) {
					let end = i;
					while (end < blocks.length && blocks[end]!.classList.contains('pf-no-match')) end++;
					const dot = createEl('div', { cls: 'pf-ellipsis', text: '···' });
					if (end < blocks.length) section.insertBefore(dot, blocks[end]!);
					else section.appendChild(dot);
					i = end;
				} else {
					i++;
				}
			}
		};

		const applyPageFilter = () => {
			const q = state.query.trim().toLowerCase();
			const section = getPreviewSection();
			if (!section) return;

			clearHighlights(section);
			section.querySelectorAll('.pf-ellipsis').forEach(el => el.remove());

			if (!q) {
				section.classList.remove('pf-filtering');
				section.querySelectorAll('.pf-no-match').forEach(el => el.classList.remove('pf-no-match'));
				return;
			}

			section.classList.add('pf-filtering');
			section.querySelectorAll<HTMLElement>(':scope > div').forEach(el => {
				const text = el.textContent?.toLowerCase() ?? '';
				const matches = text.includes(q);
				el.classList.toggle('pf-no-match', !matches);
				if (matches) highlightTextNodes(el, q);
			});
			insertPageEllipses(section);
		};

		const scheduleCurrentFilter = () => {
			if (state.filterTimer !== null) window.clearTimeout(state.filterTimer);
			state.filterTimer = window.setTimeout(() => {
				applyPageFilter();
				state.filterTimer = null;
			}, 50);
		};

		const deactivate = () => {
			searchContainer.style.display = 'none';
			searchInput.value = '';
			state.query = '';

			const section = getPreviewSection();
			if (section) {
				clearHighlights(section);
				section.querySelectorAll('.pf-ellipsis').forEach(el => el.remove());
				section.classList.remove('pf-filtering');
				section.querySelectorAll('.pf-no-match').forEach(el => el.classList.remove('pf-no-match'));
			}
		};

		searchBtn.addEventListener('click', () => {
			if (searchContainer.style.display === 'none') {
				searchContainer.style.display = '';
				searchInput.focus();
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

		// Click an ellipsis → clear the query; Ctrl/Cmd+Z restores it
		this.registerDomEvent(viewEl, 'click', (e: MouseEvent) => {
			if (!(e.target as HTMLElement).classList.contains('pf-ellipsis')) return;
			e.preventDefault();
			e.stopPropagation();
			previousQuery = searchInput.value;
			searchInput.value = '';
			state.query = '';
			scheduleCurrentFilter();
			searchInput.focus();
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<FileFilterSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
