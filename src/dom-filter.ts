// Block-level paragraph filter for rendered markdown (a .markdown-preview-section).
// Used by reading mode and by Live Preview embeds — both render the same
// .el-p / .el-ul / .el-ol block structure. Lists are filtered per-item; other
// blocks are filtered whole. Runs of hidden blocks/items collapse into a
// clickable ellipsis, and matched substrings are highlighted.

// Section children that aren't filterable content.
function isNonContent(el: Element): boolean {
	return el.classList.contains('markdown-preview-pusher') || el.classList.contains('mod-header');
}

// Returns 1–6 for el-h1…el-h6, or 0 for non-header blocks.
function headerLevel(el: HTMLElement): number {
	for (let i = 1; i <= 6; i++) {
		if (el.classList.contains(`el-h${i}`)) return i;
	}
	return 0;
}

// Walk through blocks in order. For each visible block, un-hide any headers
// in the ancestor stack so that structural context is preserved.
function preserveAncestorHeaders(blocks: HTMLElement[]): void {
	// Each entry represents the most recent header seen at its nesting depth.
	const stack: Array<{ level: number; el: HTMLElement }> = [];

	for (const block of blocks) {
		const level = headerLevel(block);

		if (level > 0) {
			// Drop headers at the same or deeper level — they're siblings of this one.
			while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
				stack.pop();
			}
			stack.push({ level, el: block });
		}

		// Visible block (matched or header that already matched) → reveal its ancestors.
		if (!block.classList.contains('pf-no-match')) {
			for (const h of stack) {
				h.el.classList.remove('pf-no-match');
			}
		}
	}
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

// Ellipses are inserted independently at the section level and inside every
// nested list, so a single visual gap (e.g. several collapsed items spanning a
// list boundary or a chain of nested lists) can produce a stack of adjacent
// "···" markers. This pass walks the rendered section in document order and
// collapses each run of ellipses with no visible content between them into one,
// keeping the shallowest (least-indented) marker so it reads as a clean break.
function mergeAdjacentEllipses(section: HTMLElement): void {
	const runs: HTMLElement[][] = [];
	let current: HTMLElement[] = [];
	const flush = (): void => {
		if (current.length) {
			runs.push(current);
			current = [];
		}
	};

	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			if ((node.textContent ?? '').trim().length > 0) flush();
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const el = node as HTMLElement;

		// Hidden subtrees render nothing, so they neither break a run nor count.
		if (
			el.classList.contains('pf-no-match') ||
			el.classList.contains('pf-embed-hidden') ||
			el.classList.contains('pf-passthrough-content') ||
			el.style.display === 'none'
		) {
			return;
		}

		if (el.classList.contains('pf-ellipsis')) {
			current.push(el);
			return; // don't descend — its "···" text isn't real content
		}

		// Visible media counts as content even though it carries no text.
		if (el.tagName === 'IMG') {
			flush();
			return;
		}

		Array.from(el.childNodes).forEach(walk);
	};

	walk(section);
	flush();

	const listDepth = (el: HTMLElement): number => {
		let depth = 0;
		let p = el.parentElement;
		while (p && p !== section) {
			if (p.tagName === 'UL' || p.tagName === 'OL') depth++;
			p = p.parentElement;
		}
		return depth;
	};

	for (const run of runs) {
		if (run.length <= 1) continue;
		let keep = run[0]!;
		for (const e of run) {
			if (listDepth(e) < listDepth(keep)) keep = e;
		}
		for (const e of run) {
			if (e !== keep) e.remove();
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

// Hide an <li>'s own text content (everything that isn't a nested list) by
// wrapping it in an invisible span, leaving the nested <ul>/<ol> untouched.
function hideOwnContent(li: HTMLElement): void {
	if (li.querySelector(':scope > .pf-passthrough-content')) return; // already wrapped
	const nodes: Node[] = [];
	li.childNodes.forEach(node => {
		if (node.nodeType === Node.ELEMENT_NODE) {
			const tag = (node as Element).tagName;
			if (tag === 'UL' || tag === 'OL') return;
		}
		nodes.push(node);
	});
	if (nodes.length === 0) return;
	const wrapper = activeDocument.createElement('span');
	wrapper.className = 'pf-passthrough-content';
	wrapper.style.display = 'none';
	li.insertBefore(wrapper, nodes[0]!);
	nodes.forEach(n => wrapper.appendChild(n));
}

// Undo hideOwnContent — move nodes back out of the wrapper span.
function restoreOwnContent(li: HTMLElement): void {
	const wrapper = li.querySelector(':scope > .pf-passthrough-content');
	if (!wrapper) return;
	while (wrapper.firstChild) li.insertBefore(wrapper.firstChild, wrapper);
	wrapper.remove();
}

// Filter a single list per-item.
//  • ownMatch  → shown with highlighting; nested lists filtered recursively.
//  • childKept → own text hidden (passthrough), nested list kept visible.
//  • neither   → hidden entirely (pf-no-match).
// Returns true if any item is visible (matched or passthrough with visible content).
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

		if (ownMatch) {
			li.classList.remove('pf-no-match', 'pf-passthrough');
			anyKept = true;
			highlightTextNodes(li, q); // own text only (UL/OL skipped)
			for (const nested of nestedLists) filterList(nested, q);
		} else {
			let childKept = false;
			for (const nested of nestedLists) {
				if (filterList(nested, q)) childKept = true;
			}
			if (childKept) {
				li.classList.remove('pf-no-match');
				li.classList.add('pf-passthrough');
				hideOwnContent(li);
				anyKept = true;
			} else {
				li.classList.remove('pf-passthrough');
				li.classList.add('pf-no-match');
			}
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
	// Restore any passthrough items: unwrap hidden content and remove the class.
	section.querySelectorAll<HTMLElement>('li.pf-passthrough').forEach(li => {
		restoreOwnContent(li);
		li.classList.remove('pf-passthrough');
	});
}

// Filter a rendered section in place. An empty query clears the filter.
// Returns true if any block was kept (used when recursing into embeds).
export function applyBlockFilter(
	section: HTMLElement,
	query: string,
	opts: { preserveStructure?: boolean } = {},
): boolean {
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
				? applyBlockFilter(inner, q, opts)
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

	if (opts.preserveStructure) preserveAncestorHeaders(blocks);

	insertEllipsisRuns(section, blocks);
	// Collapse ellipses that ended up stacked across list/section boundaries.
	// Idempotent, so running it during embed recursion as well is harmless.
	mergeAdjacentEllipses(section);
	return blocks.some(b => !b.classList.contains('pf-no-match'));
}
