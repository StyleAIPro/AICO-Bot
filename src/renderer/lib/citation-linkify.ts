/**
 * Citation linkify — converts wiki citation markers in AI responses to clickable links.
 *
 * Citation format in AI responses:
 * - Inline: [1], [2], etc.
 * - Reference section:
 *   参考知识库文档：
 *   [1]知识库{知识库名称}-wiki页面标题
 *   [2]知识库{另一个知识库名称}-另一个wiki页面标题
 *
 * This module transforms:
 * - Reference lines → markdown links with #wiki/ fragment URL
 * - Inline [N] that have a matching reference → [N](#wiki/kbName/pageTitle)
 * - Unmatched [N] → left as plain text (streaming, ref section not yet arrived)
 */

import { useKnowledgeBaseStore } from '@/stores/knowledge-base.store';
import { useAppStore } from '@/stores/app.store';

// Regex for reference lines: [N]知识库{KB名称}-页面标题
const REF_LINE_RE = /^\[(\d+)\]知识库\{([^}]+)\}-(.+)$/gm;

// Regex for inline citation numbers: [N] not part of an existing markdown link
// Negative lookbehind: not preceded by [  (avoids matching inside [[wikilink]])
// Negative lookahead: not followed by ]( — avoids matching [N](url) already converted
const INLINE_CITE_RE = /(?<!\[)\[(\d+)\](?!\()/g;

const WIKI_HREF_PREFIX = '#wiki/';

/**
 * Pre-process markdown content to convert citation markers into clickable links.
 * Idempotent — safe to call on every content update during streaming.
 *
 * IMPORTANT: reference lines must be replaced FIRST (index-based), then inline
 * citations (regex-based). Doing inline first shifts indices and corrupts ref replacement.
 */
export function processCitationLinks(content: string): string {
  // 1. Parse reference section and build citation map
  const citationMap = new Map<number, { kbName: string; pageTitle: string }>();
  const refLines: { index: number; length: number; num: number; kbName: string; pageTitle: string }[] = [];

  REF_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_LINE_RE.exec(content)) !== null) {
    const num = parseInt(match[1], 10);
    const kbName = match[2].trim();
    const pageTitle = match[3].trim();
    citationMap.set(num, { kbName, pageTitle });
    refLines.push({
      index: match.index,
      length: match[0].length,
      num,
      kbName,
      pageTitle,
    });
  }

  if (citationMap.size === 0) return content;

  // 2. Replace reference lines FIRST (index-based, from end to start)
  let result = content;
  const sortedRefs = [...refLines].sort((a, b) => b.index - a.index);
  for (const ref of sortedRefs) {
    const href = `${WIKI_HREF_PREFIX}${encodeURIComponent(ref.kbName)}/${encodeURIComponent(ref.pageTitle)}`;
    const linkText = `知识库{${ref.kbName}}-${ref.pageTitle}`;
    const replacement = `[[${ref.num}] ${linkText}](${href})`;
    result = result.slice(0, ref.index) + replacement + result.slice(ref.index + ref.length);
  }

  // 3. Replace inline [N] SECOND (regex-based, position-independent)
  const inlineRe = new RegExp(INLINE_CITE_RE.source, INLINE_CITE_RE.flags);
  result = result.replace(inlineRe, (full, numStr) => {
    const num = parseInt(numStr, 10);
    const info = citationMap.get(num);
    if (!info) return full;
    const href = `${WIKI_HREF_PREFIX}${encodeURIComponent(info.kbName)}/${encodeURIComponent(info.pageTitle)}`;
    return `[[${numStr}]](${href})`;
  });

  return result;
}

/**
 * Parse a #wiki/ href to extract kbName and pageTitle.
 */
export function parseWikiHref(href: string): { kbName: string; pageTitle: string } | null {
  if (!href.startsWith(WIKI_HREF_PREFIX)) return null;
  const urlStr = href.slice(WIKI_HREF_PREFIX.length);
  const slashIdx = urlStr.indexOf('/');
  if (slashIdx <= 0) return null;
  return {
    kbName: decodeURIComponent(urlStr.slice(0, slashIdx)),
    pageTitle: decodeURIComponent(urlStr.slice(slashIdx + 1)),
  };
}

/**
 * Navigate from chat view to Knowledge Base page and expand a specific wiki page.
 */
export function navigateToWikiPage(kbName: string, pageTitle: string): void {
  console.log(`[CitationNav] navigateToWikiPage called: kbName="${kbName}", pageTitle="${pageTitle}"`);
  const store = useKnowledgeBaseStore.getState();

  const findKb = () => {
    const kbs = store.knowledgeBases;
    return kbs.find((kb) => kb.name === kbName) ?? kbs.find((kb) => kb.name.toLowerCase() === kbName.toLowerCase());
  };

  const kb = findKb();
  if (!kb) {
    store.loadKnowledgeBases().then(() => {
      const retryKb = findKb();
      if (retryKb) {
        useKnowledgeBaseStore.getState().selectKb(retryKb);
        useKnowledgeBaseStore.getState().setPendingPageExpand({ kbId: retryKb.id, pageTitle });
        useAppStore.getState().setView('knowledgeBase');
      } else {
        console.warn(`[CitationNav] KB not found: ${kbName}`);
      }
    });
    return;
  }

  store.selectKb(kb);
  store.setPendingPageExpand({ kbId: kb.id, pageTitle });
  useAppStore.getState().setView('knowledgeBase');
}
