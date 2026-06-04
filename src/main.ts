import { Plugin, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, FileFilterSettings, FileFilterSettingTab } from './settings';

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

		this.app.workspace.onLayoutReady(() => this.initExplorer());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.initExplorer()));

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
		setIcon(searchBtn, 'search');
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

		this.filterActive = true;
	}

	private clearFilter(container: HTMLElement) {
		container.classList.remove('ff-filtering');
		container.querySelectorAll('.ff-no-match').forEach(el => el.classList.remove('ff-no-match'));
		this.filterActive = false;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<FileFilterSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
