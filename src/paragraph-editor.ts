import { App, TFile, setIcon } from 'obsidian';

interface SourceSpan {
	start: number;
	end: number;
	text: string;
}

export class ParagraphEditor {
	private popup: HTMLElement | null = null;
	private sectionObserver: MutationObserver | null = null;

	constructor(private app: App) {}

	attach(viewEl: HTMLElement, getFile: () => TFile | null, onMutation?: () => void): void {
		const tryAttach = (): boolean => {
			const section = viewEl.querySelector<HTMLElement>('.markdown-preview-section');
			if (!section) return false;

			this.injectIcons(section, getFile);

			this.sectionObserver?.disconnect();
			let pending = false;
			this.sectionObserver = new MutationObserver(() => {
				if (pending) return;
				pending = true;
				window.requestAnimationFrame(() => {
					pending = false;
					this.injectIcons(section, getFile);
					onMutation?.();
				});
			});
			this.sectionObserver.observe(section, { childList: true, subtree: true });
			return true;
		};

		if (!tryAttach()) {
			const waitObserver = new MutationObserver(() => {
				if (tryAttach()) waitObserver.disconnect();
			});
			waitObserver.observe(viewEl, { childList: true, subtree: true });
		}
	}

	private injectIcons(section: HTMLElement, getFile: () => TFile | null): void {
		section.querySelectorAll<HTMLElement>('.el-p').forEach(elP => {
			if (elP.querySelector('.pf-edit-btn')) return;
			// Skip the wrapper el-p for an embedded file — icons go on its inner paragraphs instead
			if (elP.querySelector('.internal-embed')) return;

			const btn = createEl('button', {
				cls: 'clickable-icon pf-edit-btn',
				attr: { 'aria-label': 'Edit paragraph' },
			});
			setIcon(btn, 'pencil');
			elP.appendChild(btn);

			btn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const file = this.resolveFile(elP, getFile);
				if (!file) return;
				void this.openPopup(elP, btn, file);
			});
		});
	}

	private resolveFile(elP: HTMLElement, getFile: () => TFile | null): TFile | null {
		const embed = elP.closest<HTMLElement>('.internal-embed');
		if (embed) {
			const src = embed.getAttribute('src');
			const sourcePath = getFile()?.path ?? '';
			if (src) {
				const resolved = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
				if (resolved) return resolved;
			}
		}
		return getFile();
	}

	private async openPopup(elP: HTMLElement, anchor: HTMLElement, file: TFile): Promise<void> {
		this.closePopup();

		const displayText = elP.querySelector('p')?.textContent?.trim() ?? '';
		if (!displayText) return;

		const markdown = await this.app.vault.read(file);
		const span = this.findSourceSpan(markdown, displayText);
		if (!span) return;

		const popup = createEl('div', { cls: 'pf-editor-popup' });
		const textarea = popup.createEl('textarea', { cls: 'pf-editor-textarea' });
		textarea.value = span.text;
		const footer = popup.createEl('div', { cls: 'pf-editor-footer' });
		footer.createEl('span', { cls: 'pf-editor-hint', text: '⇥ Tab or esc to close' });
		const okBtn = footer.createEl('button', { cls: 'mod-cta pf-editor-ok', text: 'OK' });

		this.positionPopup(popup, anchor);
		activeDocument.body.appendChild(popup);
		this.popup = popup;

		const resize = () => {
			textarea.setCssProps({ '--pf-textarea-height': 'auto' });
			textarea.setCssProps({ '--pf-textarea-height': textarea.scrollHeight + 'px' });
		};
		textarea.addEventListener('input', resize);
		window.requestAnimationFrame(resize);

		textarea.focus();

		const save = async () => {
			if (textarea.value === span.text) return;
			const current = await this.app.vault.read(file);
			const fresh = this.findSourceSpan(current, displayText);
			if (!fresh) return;
			await this.app.vault.modify(
				file,
				current.slice(0, fresh.start) + textarea.value + current.slice(fresh.end),
			);
		};

		okBtn.addEventListener('mousedown', (e: MouseEvent) => {
			e.preventDefault(); // prevent textarea blur from firing first
			void save().then(() => this.closePopup());
		});

		textarea.addEventListener('blur', () => {
			void save().then(() => this.closePopup());
		});

		textarea.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				void save().then(() => this.closePopup());
			}
		});
	}

	private positionPopup(popup: HTMLElement, anchor: HTMLElement): void {
		const rect = anchor.getBoundingClientRect();
		const width = 420;
		const margin = 8;

		let left = rect.left;
		if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
		left = Math.max(margin, left);

		const top = rect.bottom + 6;
		popup.setCssProps({
			'--pf-popup-top': top + 'px',
			'--pf-popup-left': left + 'px',
		});

		// Flip above if popup would extend past the bottom of the viewport
		window.requestAnimationFrame(() => {
			const ph = popup.getBoundingClientRect().height;
			if (top + ph > window.innerHeight - margin) {
				popup.setCssProps({ '--pf-popup-top': (rect.top - ph - 6) + 'px' });
			}
		});
	}

	private findSourceSpan(markdown: string, displayText: string): SourceSpan | null {
		const target = this.normalize(displayText);
		// Match paragraph blocks: consecutive non-empty lines
		const re = /\S[^\n]*(?:\n(?!\n)[^\n]*)*/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(markdown)) !== null) {
			if (this.normalize(m[0]) === target) {
				return { start: m.index, end: m.index + m[0].length, text: m[0] };
			}
		}
		return null;
	}

	private normalize(text: string): string {
		return this.stripInline(text).replace(/\s+/g, ' ').trim();
	}

	private stripInline(text: string): string {
		return text
			.replace(/\*\*(.+?)\*\*/gs, '$1')
			.replace(/\*(.+?)\*/gs, '$1')
			.replace(/`([^`]+)`/g, '$1')
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			.replace(/\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, page, alias) => alias ?? page)
			.replace(/==(.+?)==/gs, '$1')
			.replace(/~~(.+?)~~/gs, '$1');
	}

	closePopup(): void {
		this.popup?.remove();
		this.popup = null;
	}

	destroy(): void {
		this.closePopup();
		this.sectionObserver?.disconnect();
		this.sectionObserver = null;
	}
}
