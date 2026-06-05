// Block-level paragraph filter for rendered markdown (a .markdown-preview-section).
// Used by reading mode and by Live Preview embeds — both render the same
// .el-p / .el-ul / .el-ol block structure. Lists are filtered per-item; other
// blocks are filtered whole. Runs of hidden blocks/items collapse into a
// clickable ellipsis, and matched substrings are highlighted.

// Section children that aren't filterable content.
function isNonContent(el: Element): boolean {
	return el.classList.contains('markdown-preview-pusher') || el.classList.contains('mod-header');
}

function highlightTextNodes(el: Node, q: string): void {
	if (el.nodeType === Node.TEXT_NODE) {
		const text = el.textContent ?? '';
		const lower = text.toLowerCase();
		if (!lower.includes(q)) return;
		const frag = activeDocument.createDocumentFragment();
		let last = 0;
		let i = lower.indexOf(q, 0);
		while (i !== -1) {
			if (i > last) frag.appendChild(activeDocument.createTextNode(text.slice(last, i)));
			const span = activeDocument.createElement('span');
			span.className = 'pf-highlight';
			span.textContent = text.slice(i, i + q.length);
			frag.appendChild(span);
			last = i + q.length;
			i = lower.indexOf(q, last);
		}
		if (last < text.length) frag.appendChild(activeDocument.createTextNode(text.slice(last)));
		el.parentNode?.replaceChild(frag, el);
	} else if (el.nodeType === Node.ELEMENT_NODE) {
		const elem = el as Element;
		if (elem.classList.contains('pf-highlight')) return;
		// Don't descend into nested lists — each <li> highlights its own text at
		// its own level (see filterList).
		if (elem.tagName === 'UL' || elem.tagName === 'OL') return;
		Array.from(el.childNodes).forEach(child => highlightTextNodes(child, q));
	}
}

function clearHighlights(root: HTMLElement): void {
	root.querySelectorAll('.pf-highlight').forEach(span => {
		const parent = span.parentNode;
		if (!parent) return;
		parent.replaceChild(activeDocument.createTextNode(span.textContent ?? ''), span);
		parent.normalize();
	});
}

// Collapse each run of consecutive hidden items into one clickable ellipsis.
// A <div> (not <li>) is used inside lists so ordered-list numbering is
// unaffected and it carries no bullet marker.
function insertEllipsisRuns(container: HTMLElement, items: HTMLElement[]): void {
	let i = 0;
	while (i < items.length) {
		if (items[i]!.classList.contains('pf-no-match')) {
			let end = i;
			while (end < items.length && items[end]!.classList.contains('pf-no-match')) end++;
			const dot = createEl('div', { cls: 'pf-ellipsis', text: '···' });
			if (end < items.length) container.insertBefore(dot, items[end]!);
			else container.appendChild(dot);
			i = end;
		} else {
			i++;
		}
	}
}

// An <li>'s own text, excluding any nested sub-lists.
function liOwnText(li: HTMLElement): string {
	let text = '';
	li.childNodes.forEach(node => {
		if (node.nodeType === Node.ELEMENT_NODE) {
			const tag = (node as Element).tagName;
			if (tag === 'UL' || tag === 'OL') return;
		}
		text += node.textContent ?? '';
	});
	return text;
}

// Filter a single list per-item. An item is kept if its own text matches OR any
// descendant item matches (so ancestors stay visible for context). Returns true
// if anything in the list (or its descendants) was kept.
function filterList(list: HTMLElement, q: string): boolean {
	const items = Array.from(list.children).filter(
		c => c.tagName === 'LI' && !c.classList.contains('pf-ellipsis'),
	) as HTMLElement[];

	let anyKept = false;
	for (const li of items) {
		const ownMatch = liOwnText(li).toLowerCase().includes(q);
		const nestedLists = Array.from(li.children).filter(
			c => c.tagName === 'UL' || c.tagName === 'OL',
		) as HTMLElement[];
		let childKept = false;
		for (const nested of nestedLists) {
			if (filterList(nested, q)) childKept = true;
		}

		const kept = ownMatch || childKept;
		li.classList.toggle('pf-no-match', !kept);
		if (kept) {
			anyKept = true;
			if (ownMatch) highlightTextNodes(li, q); // own text only (UL/OL skipped)
		}
	}

	insertEllipsisRuns(list, items);
	return anyKept;
}

// Remove all filter artifacts from a section.
export function clearBlockFilter(section: HTMLElement): void {
	clearHighlights(section);
	section.querySelectorAll('.pf-ellipsis').forEach(el => el.remove());
	section.classList.remove('pf-filtering');
	section.querySelectorAll('.pf-no-match').forEach(el => el.classList.remove('pf-no-match'));
}

// Filter a rendered section in place. An empty query clears the filter.
// Returns true if any block was kept (used when recursing into embeds).
export function applyBlockFilter(section: HTMLElement, query: string): boolean {
	const q = query.trim().toLowerCase();

	clearHighlights(section);
	section.querySelectorAll('.pf-ellipsis').forEach(el => el.remove());

	if (!q) {
		section.classList.remove('pf-filtering');
		section.querySelectorAll('.pf-no-match').forEach(el => el.classList.remove('pf-no-match'));
		return true;
	}

	section.classList.add('pf-filtering');
	const blocks = Array.from(section.children).filter(
		c => c.tagName === 'DIV' && !isNonContent(c),
	) as HTMLElement[];

	blocks.forEach(el => {
		// A note embed (![[page]]) is filtered by recursing into its own rendered
		// section, so its non-matching paragraphs collapse like the host page.
		// Kept only if something inside matched. (Media/image embeds lack the
		// .markdown-embed class and fall through to the block path below.)
		const embed = el.matches('.internal-embed.markdown-embed')
			? el
			: el.querySelector<HTMLElement>('.internal-embed.markdown-embed');
		if (embed) {
			const inner = embed.querySelector<HTMLElement>('.markdown-preview-section');
			const kept = inner
				? applyBlockFilter(inner, q)
				: (el.textContent?.toLowerCase() ?? '').includes(q);
			el.classList.toggle('pf-no-match', !kept);
		} else if (el.classList.contains('el-ul') || el.classList.contains('el-ol')) {
			// List blocks filter per-item to match Live Preview's line granularity.
			const list = el.querySelector<HTMLElement>('ul, ol');
			const anyKept = list ? filterList(list, q) : false;
			el.classList.toggle('pf-no-match', !anyKept);
		} else {
			const text = el.textContent?.toLowerCase() ?? '';
			const matches = text.includes(q);
			el.classList.toggle('pf-no-match', !matches);
			if (matches) highlightTextNodes(el, q);
		}
	});

	insertEllipsisRuns(section, blocks);
	return blocks.some(b => !b.classList.contains('pf-no-match'));
}
