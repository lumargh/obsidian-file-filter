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
			this.sectionObserver = new MutationObserver(() => {
				this.injectIcons(section, getFile);
				onMutation?.();
			});
			this.sectionObserver.observe(section, { childList: true });
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

			const btn = createEl('button', {
				cls: 'clickable-icon pf-edit-btn',
				attr: { 'aria-label': 'Edit paragraph' },
			});
			setIcon(btn, 'pencil');
			elP.appendChild(btn);

			btn.addEventListener('click', async (e) => {
				e.preventDefault();
				e.stopPropagation();
				const file = getFile();
				if (!file) return;
				await this.openPopup(elP, btn, file);
			});
		});
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
		footer.createEl('span', { cls: 'pf-editor-hint', text: '⇥ Tab to close' });
		const okBtn = footer.createEl('button', { cls: 'mod-cta pf-editor-ok', text: 'OK' });

		this.positionPopup(popup, anchor);
		document.body.appendChild(popup);
		this.popup = popup;

		const resize = () => {
			textarea.style.height = 'auto';
			textarea.style.height = textarea.scrollHeight + 'px';
		};
		textarea.addEventListener('input', resize);
		requestAnimationFrame(resize);

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

		okBtn.addEventListener('mousedown', async (e: MouseEvent) => {
			e.preventDefault(); // prevent textarea blur from firing first
			await save();
			this.closePopup();
		});

		textarea.addEventListener('blur', async () => {
			await save();
			this.closePopup();
		});

		textarea.addEventListener('keydown', async (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				await save();
				this.closePopup();
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

		popup.style.position = 'fixed';
		popup.style.width = width + 'px';
		popup.style.top = (rect.bottom + 6) + 'px';
		popup.style.left = left + 'px';

		// Flip above if popup would extend past the bottom of the viewport
		requestAnimationFrame(() => {
			const ph = popup.getBoundingClientRect().height;
			if (parseFloat(popup.style.top) + ph > window.innerHeight - margin) {
				popup.style.top = (rect.top - ph - 6) + 'px';
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
