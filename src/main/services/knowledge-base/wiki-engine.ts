import type {
  WikiPage,
  IngestResult,
  CompileResult,
  QueryResult,
  LintResult,
  LintIssue,
  LintIssueType,
  AuditCorrection,
  KbSource,
} from './types';
import { KbLlmCaller } from './llm-caller';
import { getAicoBotDir } from '../config.service';
import fs from 'node:fs';
import path from 'node:path';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
  'if', 'while', 'about', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'they', 'them', 'their', 'what', 'which', 'who',
]);

// Chinese function words — single characters that carry no semantic meaning
const CHINESE_STOP_CHARS = new Set(
  '的了是在有不和与也很都而却能可要会就将及或被把给让向从到得着过这那哪个什么怎么为什么吗吧呢啊哦嗯呀啦嘛嘛哈么些种样条件个位次回遍场份篇段节级层类组批套系列号版款代'
    .split('')
);

// Chinese function-word bigrams — composed entirely of stop chars, no retrieval value
const CHINESE_STOP_BIGRAMS = new Set([
  '的是', '是了', '的了', '是在', '是在', '是有', '的也', '和也',
  '也能', '也可', '是也', '是不', '不是', '的有', '和有', '与有',
  '的了', '的是', '也能', '也可', '会也', '将会', '也会', '也有',
  '在也', '在有', '是不是', '能不能', '会不会', '可不可以',
]);

const WIKI_SUBDIRS = ['concepts', 'entities', 'summaries', 'conversations'] as const;

const SUBDIR_TO_KIND: Record<string, PageKind> = {
  concepts: 'concept',
  entities: 'entity',
  summaries: 'summary',
  conversations: 'conversation',
};

type PageKind = 'concept' | 'entity' | 'summary' | 'conversation';

// --- Analysis Phase Types (compact, no full content) ---

interface AnalysisReport {
  docTitle: string;
  docType: string;
  briefSummary: string;
  keyPoints: string[];
  entities: Array<{ name: string; type: string; isNew: boolean; relatedExisting: string[]; brief: string }>;
  concepts: Array<{ name: string; isNew: boolean; relatedExisting: string[]; brief: string }>;
  contradictions: Array<{ existingPage: string; issue: string; suggestedAction: string }>;
  newPages: string[];
  pagesToModify: Array<{ page: string; reason: string }>;
}

interface IngestLlmOutput {
  docTitle: string;
  docType: string;
  summary: string;
  keyPoints: string[];
  concepts: Array<{ title?: string; content?: string; tags?: string[]; difficulty?: string; brief?: string }>;
  entities: Array<{ title?: string; content?: string; tags?: string[]; entityType?: string; brief?: string }>;
}

interface CompileSuggestion {
  action: 'split' | 'merge';
  target: string;
  reason: string;
}

interface FrontmatterData {
  title: string;
  type: PageKind;
  created: string;
  updated: string;
  sources: string[];
  tags: string[];
  difficulty?: string;
  entityType?: string;
}

interface TitleCacheEntry {
  path: string;
  title: string;
}

export class WikiEngine {
  private kbPath: string;
  private llm: KbLlmCaller;
  private titleCache: Map<string, TitleCacheEntry> | null;

  // --- Inverted index cache ---
  private indexCache: Map<string, { pageKey: string; field: 'title' | 'tag' | 'body' }[]> | null = null;
  private pageMetaCache: Map<string, { path: string; title: string; type: PageKind; tags: string[] }> | null = null;

  // --- Synonym expansion cache ---
  private synonymCache: string[][] | null = null;

  constructor(kbPath: string, llm: KbLlmCaller) {
    this.kbPath = kbPath;
    this.llm = llm;
    this.titleCache = null;
  }

  // ---------------------------------------------------------------------------
  // Ingest
  // ---------------------------------------------------------------------------

  private static MAX_INPUT_CHARS = 12000;

  // ===========================================================================
  // Phase 1: Analysis — compact, memory-safe
  // ===========================================================================

  private readExistingWikiIndex(): string {
    const indexPath = path.join(this.kbPath, 'wiki', 'index.md');
    if (fs.existsSync(indexPath)) {
      const full = fs.readFileSync(indexPath, 'utf-8');
      return full.length > 3000 ? full.slice(0, 3000) + '\n...(truncated)' : full;
    }
    return '';
  }

  /**
   * Build a title→{path, title} cache from all wiki .md files.
   * Used by findPagePath, readExistingPageContent, and readExistingPageTitles.
   * Only rebuilt when null (called once per ingest).
   */
  private buildTitleCache(): Map<string, TitleCacheEntry> {
    const wikiDir = path.join(this.kbPath, 'wiki');
    const cache = new Map<string, TitleCacheEntry>();
    if (!fs.existsSync(wikiDir)) return cache;

    for (const filePath of this.readdirRecursive(wikiDir, '.md')) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');
      cache.set(title.toLowerCase(), { path: filePath, title });
    }
    return cache;
  }

  private readExistingPageTitles(): string[] {
    if (!this.titleCache) {
      this.titleCache = this.buildTitleCache();
    }
    return Array.from(this.titleCache.values()).map((e) => e.title);
  }

  /**
   * Phase 1: Analyze document and existing wiki. Compact output — no full page content.
   * This call should stay under ~15KB total (input + response) to avoid memory pressure.
   */
  private async analyzeDocument(content: string, existingIndex: string, existingTitles: string[], signal?: AbortSignal): Promise<AnalysisReport> {
    const existingHint = existingTitles.length > 0
      ? `Existing wiki pages: ${existingTitles.slice(0, 40).join(', ')}`
      : 'No existing wiki pages.';

    const prompt = [
      'You are a senior knowledge engineer. Analyze this document against the existing wiki.',
      '',
      existingHint,
      '',
      '## Output ONLY valid JSON (keep it compact — NO full page content, just analysis):',
      '{',
      '  "docTitle": "document title",',
      '  "docType": "paper|report|article|tutorial|spec|docs|thesis|manual|other",',
      '  "briefSummary": "300-600 char overview of the document\'s core content and key conclusions",',
      '  "keyPoints": ["5-8 factual bullet points"],',
      '  "entities": [',
      '    {"name": "...", "type": "technology|organization|dataset|system|person|...", "isNew": true, "relatedExisting": ["existing page title if related"], "brief": "1-2 sentence description"}',
      '  ],',
      '  "concepts": [',
      '    {"name": "...", "isNew": true, "relatedExisting": ["..."], "brief": "1-2 sentence description"}',
      '  ],',
      '  "contradictions": [{"existingPage": "...", "issue": "...", "suggestedAction": "..."}],',
      '  "newPages": ["list of new wiki page titles to create"],',
      '  "pagesToModify": [{"page": "...", "reason": "..."}]',
      '}',
    ].join('\n');

    const result = await this.llm.chatWithJson<AnalysisReport>([
      { role: 'system', content: prompt },
      { role: 'user', content },
    ], 4096, signal);

    const r = {
      docTitle: result.docTitle || '',
      docType: result.docType || 'document',
      briefSummary: result.briefSummary || '',
      keyPoints: result.keyPoints || [],
      entities: result.entities || [],
      concepts: result.concepts || [],
      contradictions: result.contradictions || [],
      newPages: result.newPages || [],
      pagesToModify: result.pagesToModify || [],
    };
    console.log(`[WikiEngine] Phase 1: concepts=${r.concepts.length}, entities=${r.entities.length}, title="${r.docTitle}"`);
    if (r.concepts.length > 0) {
      console.log(`[WikiEngine]   concepts: ${r.concepts.map((c) => c.name).join(', ')}`);
    }
    if (r.entities.length > 0) {
      console.log(`[WikiEngine]   entities: ${r.entities.map((e) => e.name).join(', ')}`);
    }
    return r;
  }

  // ===========================================================================
  // Phase 2: Generation — based on analysis report
  // ===========================================================================

  private async generateWikiPages(
    analysis: AnalysisReport,
    sourceMaterial: string,
    existingTitles: string[],
    signal?: AbortSignal,
  ): Promise<IngestLlmOutput> {
    const titlesHint = existingTitles.length > 0
      ? `Existing pages for [[Wikilink]]: ${existingTitles.slice(0, 30).join(', ')}`
      : 'No existing pages.';

    // --- Call 1: Summary ---
    const summaryResult = await this.llm.chatWithJson<{
      summary: string;
      keyPoints: string[];
    }>([
      {
        role: 'system',
        content: [
          'Generate a wiki summary page for a document.',
          'Output ONLY JSON: {"summary": "...", "keyPoints": ["...", "..."]}',
          `Existing pages for [[Wikilink]]: ${existingTitles.slice(0, 30).join(', ')}`,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Document: ${analysis.docTitle}`,
          `Brief analysis: ${analysis.briefSummary}`,
          '',
          'Source material:',
          sourceMaterial.slice(0, 8000),
          '',
          'Summary (1000-2000 chars) sections: ## Overview, ## Core Content, ## Key Findings, ## Significance',
          'Include specific data and facts. Rich markdown with headers, lists, tables.',
        ].join('\n'),
      },
    ], 4096, signal);

    // --- Per-concept generation (one LLM call each) ---
    const concepts: IngestLlmOutput['concepts'] = [];
    for (const concept of analysis.concepts ?? []) {
      if (signal?.aborted) throw new Error('提取已取消');
      try {
        const existingContent = !concept.isNew && concept.relatedExisting.length > 0
          ? this.readExistingPageContent(concept.relatedExisting[0])
          : '';

        const result = await this.llm.chatWithJson<{
          title: string;
          content: string;
          tags: string[];
          difficulty: string;
        }>([
          {
            role: 'system',
            content: [
              concept.isNew
                ? 'Generate a NEW wiki concept page. Output ONLY JSON: {"title": "...", "content": "... (1000-2000 chars, markdown with ## Definition, ## How It Works, ## Why It Matters, ## Connections)", "tags": [...], "difficulty": "beginner|intermediate|advanced"}'
                : 'UPDATE an existing wiki concept page. Output ONLY JSON: {"title": "...", "content": "... (200-500 chars, NEW information from this source only, to APPEND)", "tags": [...], "difficulty": "beginner|intermediate|advanced"}',
              '',
              `Existing pages for [[Wikilink]]: ${titlesHint}`,
              '',
              'CRITICAL: "content" MUST be detailed markdown with headers and paragraphs — NOT a brief description.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Document: ${analysis.docTitle}`,
              `Brief analysis: ${analysis.briefSummary}`,
              '',
              'Source material:',
              sourceMaterial.slice(0, 12000),
              '',
              `## Concept: ${concept.name}`,
              concept.isNew ? '(NEW — create full wiki page)' : `(UPDATE existing: ${concept.relatedExisting.join(', ')})`,
              `Brief: ${concept.brief}`,
              existingContent ? `\nExisting page content:\n${existingContent.slice(0, 3000)}\n\nGenerate ONLY new/different information not already covered above.` : '',
            ].join('\n'),
          },
        ], 4096, signal);
        concepts.push(result);
        console.log(`[WikiEngine] Phase 2: generated concept "${result.title || concept.name}" (${(result.content || '').length} chars)`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WikiEngine] Failed to generate concept "${concept.name}": ${msg}`);
        concepts.push({ title: concept.name, content: '', tags: [], difficulty: undefined });
      }
    }

    // --- Per-entity generation (one LLM call each) ---
    const entities: IngestLlmOutput['entities'] = [];
    for (const entity of analysis.entities ?? []) {
      if (signal?.aborted) throw new Error('提取已取消');
      try {
        const existingContent = !entity.isNew && entity.relatedExisting.length > 0
          ? this.readExistingPageContent(entity.relatedExisting[0])
          : '';

        const result = await this.llm.chatWithJson<{
          title: string;
          content: string;
          tags: string[];
          entityType: string;
        }>([
          {
            role: 'system',
            content: [
              entity.isNew
                ? 'Generate a NEW wiki entity page. Output ONLY JSON: {"title": "...", "content": "... (800-1500 chars, markdown with ## Overview, ## Specifications, ## References)", "tags": [...], "entityType": "technology|organization|dataset|system|person"}'
                : 'UPDATE an existing wiki entity page. Output ONLY JSON: {"title": "...", "content": "... (200-500 chars, NEW information from this source only, to APPEND)", "tags": [...], "entityType": "technology|organization|dataset|system|person"}',
              '',
              `Existing pages for [[Wikilink]]: ${titlesHint}`,
              '',
              'CRITICAL: "content" MUST be detailed markdown with headers and paragraphs — NOT a brief description.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Document: ${analysis.docTitle}`,
              `Brief analysis: ${analysis.briefSummary}`,
              '',
              'Source material:',
              sourceMaterial.slice(0, 12000),
              '',
              `## Entity: ${entity.name}`,
              entity.isNew ? '(NEW — create full wiki page)' : `(UPDATE existing: ${entity.relatedExisting.join(', ')})`,
              `Brief: ${entity.brief}`,
              existingContent ? `\nExisting page content:\n${existingContent.slice(0, 3000)}\n\nGenerate ONLY new/different information not already covered above.` : '',
            ].join('\n'),
          },
        ], 4096, signal);
        entities.push(result);
        console.log(`[WikiEngine] Phase 2: generated entity "${result.title || entity.name}" (${(result.content || '').length} chars)`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WikiEngine] Failed to generate entity "${entity.name}": ${msg}`);
        entities.push({ title: entity.name, content: '', tags: [], entityType: undefined });
      }
    }

    return {
      docTitle: analysis.docTitle,
      docType: analysis.docType,
      summary: summaryResult.summary || '',
      keyPoints: summaryResult.keyPoints || [],
      concepts,
      entities,
    };
  }

  private readExistingPageContent(title: string): string {
    const filePath = this.findPagePath(title);
    if (!filePath) return '';
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { body } = this.parseFrontmatter(raw);
    return body;
  }

  private async generateReviewItems(
    contradictions: AnalysisReport['contradictions'],
  ): Promise<Array<{ type: string; page: string; description: string; suggestedFix: string }>> {
    if (!contradictions?.length) return [];

    try {
      return await this.llm.chatWithJson<Array<{ type: string; page: string; description: string; suggestedFix: string }>>([{
        role: 'system',
        content: [
          'For each contradiction found during analysis, generate a review item.',
          `Contradictions: ${JSON.stringify(contradictions)}`,
          '',
          'Output ONLY JSON array: [{"type": "contradiction", "page": "...", "description": "...", "suggestedFix": "..."}]',
        ].join('\n'),
      }], 1024);
    } catch {
      return contradictions.map((c) => ({
        type: 'contradiction',
        page: c.existingPage,
        description: c.issue,
        suggestedFix: c.suggestedAction,
      }));
    }
  }

  // ===========================================================================
  // Ingest Orchestrator
  // ===========================================================================

  async ingest(
    source: KbSource,
    content: string,
    onProgress?: (chunkIndex: number, totalChunks: number) => void,
    signal?: AbortSignal,
    skipIndexUpdate = false,
  ): Promise<IngestResult> {
    const result: IngestResult = {
      pagesCreated: 0, pagesUpdated: 0,
      conceptsCount: 0, entitiesCount: 0, summaryCreated: false, errors: [], newPages: [],
    };

    try {
      // Skip files with too little content — LLM can't produce meaningful analysis
      if (content.trim().length < 50) {
        throw new Error(`File content too short (${content.trim().length} chars), minimum 50 required`);
      }

      const today = new Date().toISOString().slice(0, 10);

      // Truncate large documents
      let inputContent = content;
      if (content.length > WikiEngine.MAX_INPUT_CHARS) {
        inputContent = content.slice(0, WikiEngine.MAX_INPUT_CHARS) + '\n\n[... truncated ...]';
      }

      // --- Phase 1: Analysis (compact, one small LLM call) ---
      const existingIndex = this.readExistingWikiIndex();
      const existingTitles = this.readExistingPageTitles();
      const analysis = await this.analyzeDocument(inputContent, existingIndex, existingTitles, signal);

      // Release input content — no longer needed after analysis
      void inputContent;

      // --- Phase 2: Generation (1 summary call + per-concept/entity calls) ---
      const generation = await this.generateWikiPages(analysis, content, existingTitles, signal);

      // --- Write wiki pages ---
      const docTitle = analysis.docTitle || source.storedName;
      const docType = analysis.docType || 'document';

      // Summary
      const summaryDir = path.join(this.kbPath, 'wiki', 'summaries');
      fs.mkdirSync(summaryDir, { recursive: true });
      const summaryPath = path.join(summaryDir, `${source.storedName}-summary.md`);
      const summaryTags = [docType, ...(generation.keyPoints?.slice(0, 3).map((p) => p.slice(0, 20).toLowerCase()) ?? [])];
      const summaryFrontmatter = this.buildFrontmatter({
        title: `${docTitle} - Summary`,
        type: 'summary',
        created: today, updated: today,
        sources: [source.id],
        tags: summaryTags,
      });
      const keyPointsSection = generation.keyPoints?.length
        ? `\n\n## Key Points\n${generation.keyPoints.map((p) => `- ${p}`).join('\n')}`
        : '';
      fs.writeFileSync(summaryPath, `${summaryFrontmatter}\n${this.truncateContent(generation.summary)}${keyPointsSection}`, 'utf-8');
      result.summaryCreated = true;
      result.pagesCreated++;
      result.newPages.push({ title: `${docTitle} - Summary`, kind: 'summary', desc: docTitle });

      // Concepts + Entities
      const allTitles = [
        ...(generation.concepts ?? []).map((c) => c.title || '').filter(Boolean),
        ...(generation.entities ?? []).map((e) => e.title || '').filter(Boolean),
        ...existingTitles,
      ];

      // Build lookup from Phase 1 analysis: concept/entity name → {isNew, relatedExisting}
      const conceptMeta = new Map<string, { isNew: boolean; relatedExisting: string[] }>();
      for (const c of analysis.concepts) conceptMeta.set(c.name.toLowerCase(), { isNew: c.isNew, relatedExisting: c.relatedExisting });
      const entityMeta = new Map<string, { isNew: boolean; relatedExisting: string[] }>();
      for (const e of analysis.entities) entityMeta.set(e.name.toLowerCase(), { isNew: e.isNew, relatedExisting: e.relatedExisting });

      const conceptsDir = path.join(this.kbPath, 'wiki', 'concepts');
      fs.mkdirSync(conceptsDir, { recursive: true });
      for (const concept of generation.concepts ?? []) {
        try {
          const conceptContent = concept.content || `# ${concept.title}\n\n${concept.brief || ''}`;
          const conceptTags = Array.isArray(concept.tags) ? concept.tags : [];
          const conceptTitle = concept.title || 'Untitled Concept';
          if (conceptContent.trim().length < 50) {
            console.warn(`[WikiEngine] Skipping concept "${conceptTitle}": content too short (${conceptContent.trim().length} chars)`);
            continue;
          }

          // Check if this is an update to an existing page
          const meta = conceptMeta.get(conceptTitle.toLowerCase());
          if (meta && !meta.isNew && meta.relatedExisting.length > 0) {
            const existingPath = this.findPagePath(meta.relatedExisting[0]);
            if (existingPath) {
              this.updateExistingPage(existingPath, conceptContent, source.id, today, conceptTags);
              result.conceptsCount++;
              result.pagesUpdated++;
              console.log(`[WikiEngine] Updated concept "${conceptTitle}" → ${meta.relatedExisting[0]}`);
              continue;
            }
          }

          // Create new page
          const slug = this.slugify(conceptTitle);
          const conceptPath = path.join(conceptsDir, `${slug}.md`);
          const fm = this.buildFrontmatter({
            title: conceptTitle, type: 'concept',
            created: today, updated: today,
            sources: [source.id],
            tags: conceptTags, difficulty: concept.difficulty,
          });
          const bodyWithLinks = this.injectWikilinks(this.truncateContent(conceptContent), allTitles);
          fs.writeFileSync(conceptPath, `${fm}\n${bodyWithLinks}`, 'utf-8');
          result.conceptsCount++;
          result.pagesCreated++;
          result.newPages.push({ title: conceptTitle, kind: 'concept', desc: concept.content.slice(0, 80) });
        } catch (writeErr: unknown) {
          const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          console.error(`[WikiEngine] Failed to write concept "${concept.title}": ${msg}`);
          result.errors.push(`concept "${concept.title}": ${msg}`);
        }
      }

      const entitiesDir = path.join(this.kbPath, 'wiki', 'entities');
      fs.mkdirSync(entitiesDir, { recursive: true });
      for (const entity of generation.entities ?? []) {
        try {
          const entityContent = entity.content || `# ${entity.title}\n\n${entity.brief || ''}`;
          const entityTags = Array.isArray(entity.tags) ? entity.tags : [];
          const entityTitle = entity.title || 'Untitled Entity';
          if (entityContent.trim().length < 50) {
            console.warn(`[WikiEngine] Skipping entity "${entityTitle}": content too short (${entityContent.trim().length} chars)`);
            continue;
          }

          // Check if this is an update to an existing page
          const meta = entityMeta.get(entityTitle.toLowerCase());
          if (meta && !meta.isNew && meta.relatedExisting.length > 0) {
            const existingPath = this.findPagePath(meta.relatedExisting[0]);
            if (existingPath) {
              this.updateExistingPage(existingPath, entityContent, source.id, today, entityTags);
              result.entitiesCount++;
              result.pagesUpdated++;
              console.log(`[WikiEngine] Updated entity "${entityTitle}" → ${meta.relatedExisting[0]}`);
              continue;
            }
          }

          // Create new page
          const slug = this.slugify(entityTitle);
          const entityPath = path.join(entitiesDir, `${slug}.md`);
          const fm = this.buildFrontmatter({
            title: entityTitle, type: 'entity',
            created: today, updated: today,
            sources: [source.id],
            tags: entityTags, entityType: entity.entityType,
          });
          const bodyWithLinks = this.injectWikilinks(this.truncateContent(entityContent), allTitles);
          fs.writeFileSync(entityPath, `${fm}\n${bodyWithLinks}`, 'utf-8');
          result.entitiesCount++;
          result.pagesCreated++;
          result.newPages.push({ title: entityTitle, kind: 'entity', desc: entity.description.slice(0, 80) });
        } catch (writeErr: unknown) {
          const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          console.error(`[WikiEngine] Failed to write entity "${entity.title}": ${msg}`);
          result.errors.push(`entity "${entity.title}": ${msg}`);
        }
      }

      // Review items
      if (analysis.contradictions?.length > 0) {
        const reviewItems = await this.generateReviewItems(analysis.contradictions);
        this.appendReviewItems(source, reviewItems);
      }

      if (!skipIndexUpdate) this.updateIndex();
      console.log(`[WikiEngine] Ingest done: summary=${result.summaryCreated}, concepts=${result.conceptsCount}, entities=${result.entitiesCount}, pages=${result.pagesCreated}, updated=${result.pagesUpdated}`);
      this.appendLog('ingest', `${source.storedName} → ${docTitle}`, `created=${result.pagesCreated}, updated=${result.pagesUpdated}, concepts=${result.conceptsCount}, entities=${result.entitiesCount}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === '提取已取消') throw err;
      if (result.pagesCreated === 0) {
        throw new Error(`Ingest failed: ${message}`);
      }
      // Partial success — record error but don't throw
      result.errors.push(`Partial failure: ${message}`);
    }

    return result;
  }

  private appendReviewItems(
    source: KbSource,
    reviewItems: Array<{ type: string; page: string; description: string; suggestedFix: string }>,
  ): void {
    if (!reviewItems?.length) return;
    const reviewDir = path.join(this.kbPath, 'wiki', '_review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reviewPath = path.join(reviewDir, `${today}-${source.storedName}.md`);
    const lines: string[] = [
      '---',
      `title: "Review: ${source.storedName}"`,
      `created: ${today}`,
      `source: ${source.id}`,
      '---',
      '',
      `# Review Items for ${source.storedName}`,
      '',
      ...reviewItems.map((item, i) => [
        `## ${i + 1}. [${item.type}] ${item.page}`,
        '', `**Issue**: ${item.description}`, '', `**Suggested Fix**: ${item.suggestedFix}`, '',
      ].join('\n')),
    ];
    fs.writeFileSync(reviewPath, lines.join('\n'), 'utf-8');
  }

  // ---------------------------------------------------------------------------
  // Compile
  // ---------------------------------------------------------------------------

  async compile(): Promise<CompileResult> {
    const result: CompileResult = {
      splitsPerformed: 0,
      mergesPerformed: 0,
      indexRebuilt: false,
      issuesFound: 0,
    };

    const allPages = this.readAllWikiPages();

    if (allPages.length === 0) {
      return result;
    }

    const pageSummaries = allPages.map((p) => {
      const wordCount = p.content.split(/\s+/).filter(Boolean).length;
      const content = p.content.length > 3000 ? p.content.slice(0, 3000) + '\n... (truncated)' : p.content;
      return `### ${p.title} (${p.type})\nPath: ${p.path}\nWords: ${wordCount}\n${content}\n---`;
    });

    const suggestions: CompileSuggestion[] = await this.llm.chatWithJson<CompileSuggestion[]>([
      {
        role: 'system',
        content: [
          'You are a wiki compiler. Analyze the provided wiki pages and suggest improvements.',
          'Look for:',
          '- Pages that should be split (>2000 characters)',
          '- Near-duplicate pages that should be merged',
          '- Missing wikilinks between related pages',
          'Output ONLY valid JSON: [{"action": "split"|"merge", "target": "page title", "reason": "..."}]',
        ].join('\n'),
      },
      {
        role: 'user',
        content: pageSummaries.join('\n\n'),
      },
    ]);

    result.issuesFound = suggestions.length;

    for (const suggestion of suggestions) {
      try {
        if (suggestion.action === 'split') {
          this.splitPage(suggestion.target);
          result.splitsPerformed++;
        } else if (suggestion.action === 'merge') {
          this.mergeDuplicates(suggestion.target);
          result.mergesPerformed++;
        }
      } catch {
        // Best-effort: continue with remaining suggestions
      }
    }

    this.updateIndex();
    result.indexRebuilt = true;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  async query(question: string): Promise<QueryResult> {
    const relevantPages = this.findRelevantPages(question, 5);

    if (relevantPages.length === 0) {
      return { answer: 'No relevant information found.', citedPages: [] };
    }

    const context = relevantPages
      .map((p) => `## ${p.title}\n${p.content}`)
      .join('\n\n');

    const answer = await this.llm.chat([
      {
        role: 'system',
        content:
          'Answer the question based ONLY on the provided wiki content. Cite pages using [[Page Title]] format.',
      },
      { role: 'user', content: `Question: ${question}\n\nWiki content:\n${context}` },
    ]);

    const citations = this.extractCitations(answer);
    // Strip wikilink syntax from display answer: [[Title|alias]] → Title
    const displayAnswer = answer.replace(/\[\[([^\[\]]+)\]\]/g, (_, content) => content.split('|')[0].trim());
    this.appendLog('query', question.slice(0, 80), `cited: [${citations.join(', ')}]`);
    return { answer: displayAnswer, citedPages: citations };
  }

  /**
   * File a query answer back into the wiki as a new page.
   * This follows the LLM Wiki pattern: good answers compound in the knowledge base.
   */
  saveQueryResult(question: string, answer: string, citedPages: string[]): void {
    const today = new Date().toISOString().slice(0, 10);
    const queryDir = path.join(this.kbPath, 'wiki', 'summaries');
    fs.mkdirSync(queryDir, { recursive: true });

    const slug = this.slugify(question.slice(0, 60));
    const filePath = path.join(queryDir, `query-${slug}.md`);

    const fm = this.buildFrontmatter({
      title: `Q: ${question.slice(0, 80)}`,
      type: 'summary',
      created: today, updated: today,
      sources: citedPages,
      tags: ['query', 'generated'],
    });

    fs.writeFileSync(filePath, `${fm}\n\n## Question\n${question}\n\n## Answer\n${answer}`, 'utf-8');
    this.updateIndex();
    this.appendLog('query-save', question.slice(0, 80));
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  async generateReport(): Promise<string> {
    const report = await this.buildReport();
    const reportPath = path.join(this.kbPath, 'wiki', '_report.md');
    fs.writeFileSync(reportPath, report, 'utf-8');
    this.appendLog('report', `generated and cached, ${report.length} chars`);
    return report;
  }

  loadReport(): string | null {
    const reportPath = path.join(this.kbPath, 'wiki', '_report.md');
    if (!fs.existsSync(reportPath)) return null;
    return fs.readFileSync(reportPath, 'utf-8');
  }

  private clearReportCache(): void {
    const reportPath = path.join(this.kbPath, 'wiki', '_report.md');
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
    this.invalidateSearchIndex();
  }

  private invalidateSearchIndex(): void {
    this.indexCache = null;
    this.pageMetaCache = null;
  }

  // ---------------------------------------------------------------------------
  // Synonym expansion
  // ---------------------------------------------------------------------------

  /**
   * Load synonym groups from global and per-KB synonym files.
   * Format: JSON array of string arrays, each inner array is a group of equivalent terms.
   * Example: [["波束赋形", "波束成形", "beamforming"], ["恒模约束", "CM约束"]]
   */
  private loadSynonyms(): string[][] {
    if (this.synonymCache) return this.synonymCache;

    this.synonymCache = [];

    // Global synonyms: ~/.aico-bot/synonyms.json
    const globalPath = path.join(getAicoBotDir(), 'synonyms.json');
    if (fs.existsSync(globalPath)) {
      try {
        const raw = fs.readFileSync(globalPath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const group of data) {
            if (Array.isArray(group) && group.length >= 2 && group.every((t: unknown) => typeof t === 'string')) {
              this.synonymCache.push(group);
            }
          }
        }
      } catch { /* ignore malformed file */ }
    }

    // Per-KB synonyms: <kbPath>/synonyms.json
    const kbSynonymPath = path.join(this.kbPath, 'synonyms.json');
    if (fs.existsSync(kbSynonymPath)) {
      try {
        const raw = fs.readFileSync(kbSynonymPath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const group of data) {
            if (Array.isArray(group) && group.length >= 2 && group.every((t: unknown) => typeof t === 'string')) {
              this.synonymCache.push(group);
            }
          }
        }
      } catch { /* ignore malformed file */ }
    }

    return this.synonymCache;
  }

  /**
   * Check if a synonym term matches the query.
   * English terms use word-boundary matching to avoid "reforming" matching "forming".
   * Chinese terms use substring matching (characters are natural word boundaries).
   */
  private synonymMatchesQuery(term: string, queryLower: string): boolean {
    if (/[a-zA-Z0-9]/.test(term)) {
      const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(queryLower);
    }
    return queryLower.includes(term.toLowerCase());
  }

  /**
   * Build weighted keywords: original keywords (1.0) + synonym-expanded keywords (0.8).
   * Expanded terms are tokenized through extractKeywords and deduplicated against originals.
   */
  private buildWeightedKeywords(query: string): Array<{ term: string; weight: number }> {
    const originalKeywords = this.extractKeywords(query);
    const result: Array<{ term: string; weight: number }> = originalKeywords.map((t) => ({ term: t, weight: 1.0 }));

    const groups = this.loadSynonyms();
    if (groups.length === 0) return result;

    const queryLower = query.toLowerCase();
    const originalSet = new Set(originalKeywords);

    for (const group of groups) {
      let matched = false;
      for (const term of group) {
        if (this.synonymMatchesQuery(term, queryLower)) {
          matched = true;
          break;
        }
      }
      if (matched) {
        for (const term of group) {
          if (!this.synonymMatchesQuery(term, queryLower)) {
            const expanded = this.extractKeywords(term);
            for (const kw of expanded) {
              if (!originalSet.has(kw)) {
                originalSet.add(kw);
                result.push({ term: kw, weight: 0.8 });
              }
            }
          }
        }
      }
    }

    return result;
  }

  private ensureSearchIndex(): void {
    if (this.indexCache) return;

    const wikiDir = path.join(this.kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) return;

    this.indexCache = new Map();
    this.pageMetaCache = new Map();

    const mdFiles = this.readdirRecursive(wikiDir, '.md');

    for (const filePath of mdFiles) {
      const fileName = path.basename(filePath, '.md');
      if (fileName === 'index' || fileName === 'log' || fileName === '_report') continue;
      const relPath = path.relative(this.kbPath, filePath).replace(/\\/g, '/');
      if (relPath.startsWith('wiki/_review/')) continue;

      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');
      const type = (frontmatter['type'] as PageKind) ?? 'concept';
      const tags = (frontmatter['tags'] as string[]) ?? [];
      const pageKey = title.toLowerCase();

      this.pageMetaCache.set(pageKey, { path: filePath, title, type, tags });

      const addTerms = (text: string, field: 'title' | 'tag' | 'body') => {
        for (const term of this.extractDocumentTerms(text)) {
          const entries = this.indexCache.get(term) || [];
          entries.push({ pageKey, field });
          this.indexCache.set(term, entries);
        }
      };

      addTerms(title, 'title');
      for (const tag of tags) addTerms(tag, 'tag');
      addTerms(body, 'body');
    }
  }

  private extractDocumentTerms(text: string): string[] {
    const terms: string[] = [];
    const lower = text.toLowerCase();

    const englishWords = lower.match(/[a-z0-9]{2,}/g) || [];
    terms.push(...englishWords.filter((w) => !STOP_WORDS.has(w)));

    const chineseSegments = text.match(/[一-鿿]+/g) || [];
    for (const seg of chineseSegments) {
      if (seg.length <= 4) {
        terms.push(seg.toLowerCase());
        continue;
      }

      for (let i = 0; i < seg.length - 1; i++) {
        const bigram = seg.slice(i, i + 2).toLowerCase();
        if (
          CHINESE_STOP_BIGRAMS.has(bigram) ||
          (CHINESE_STOP_CHARS.has(bigram[0]) && CHINESE_STOP_CHARS.has(bigram[1]))
        ) {
          continue;
        }
        terms.push(bigram);
      }

      for (let i = 0; i <= seg.length - 3; i++) {
        const trigram = seg.slice(i, i + 3).toLowerCase();
        if (!CHINESE_STOP_CHARS.has(trigram[0]) && !CHINESE_STOP_CHARS.has(trigram[2])) {
          terms.push(trigram);
        }
      }
    }

    return terms;
  }

  private async buildReport(): Promise<string> {
    const allPages = this.readAllWikiPages();
    const skipPrefixes = ['index.md', 'log.md', '_review'];
    const pages = allPages.filter((p) => {
      const fileName = path.basename(p.path, '.md');
      const dir = p.path.includes('_review');
      return !skipPrefixes.some((s) => fileName === s || p.path.includes(`/${s}`) || p.path.includes(`\\${s}`)) && !dir;
    });

    if (pages.length === 0) {
      return '# 知识报告\n\n知识库中暂无有效页面，无法生成报告。';
    }

    const summaries = pages.map((p) => {
      const snippet = p.content.length > 300 ? p.content.slice(0, 300) + '...' : p.content;
      return `[${p.type}] ${p.title}\nTags: ${p.tags.join(', ') || 'none'}\n${snippet}`;
    }).join('\n\n---\n\n');

    const prompt = [
      {
        role: 'system',
        content: `你是一个知识库分析专家。基于以下 wiki 页面内容，生成一份专业的知识库分析报告。

要求：
1. 使用中文
2. Markdown 格式，结构清晰
3. 分为以下三个章节，每个章节用 ## 二级标题：

## 知识概览
- 用 2-3 句话概括知识库的核心主题和研究方向
- 列出涵盖的主要领域（用列表形式，每项一行，格式：- **领域名**：一句话说明）

## 知识结构分析
- 识别知识库中的核心概念及其层次关系
- 描述主要知识脉络和概念之间的关联
- 用列表展示关键概念节点（格式：- **概念**：简要说明其在知识体系中的角色）

## 知识覆盖度评估
- 列出已充分覆盖的领域（格式：- ✅ **领域**：覆盖情况说明）
- 列出覆盖不足或缺失的领域（格式：- ⚠️ **领域**：缺失说明 + 建议补充方向）

4. 语言专业、简洁，避免空话套话
5. 所有描述必须基于提供的页面内容，不要编造`,
      },
      {
        role: 'user',
        content: `知识库包含 ${pages.length} 个页面，其中 ${pages.filter(p => p.type === 'summary').length} 个文档摘要、${pages.filter(p => p.type === 'concept').length} 个概念页、${pages.filter(p => p.type === 'entity').length} 个实体页。内容如下：\n\n${summaries}`,
      },
    ];

    const report = await this.llm.chat(prompt, 4000);
    this.appendLog('report', `generated, ${report.length} chars`);
    return report;
  }

  // ---------------------------------------------------------------------------
  // Lint
  // ---------------------------------------------------------------------------

  async lint(existingSourceIds?: Set<string>): Promise<LintResult> {
    const wikiDir = path.join(this.kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) {
      return { issues: [], totalPages: 0, healthScore: 100 };
    }

    const mdFiles = this.readdirRecursive(wikiDir, '.md');
    const issues: LintIssue[] = [];
    const pageInfo: Array<{
      filePath: string;
      title: string;
      type: string;
      body: string;
      hasFrontmatter: boolean;
      raw: string;
      sources: string[];
    }> = [];

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? '';
      const type = (frontmatter['type'] as string) ?? '';
      const hasFrontmatter = raw.startsWith('---');
      const sources = Array.isArray(frontmatter['sources']) ? (frontmatter['sources'] as string[]) : [];
      pageInfo.push({ filePath, title, type, body, hasFrontmatter, raw, sources });
    }

    const skipFiles = new Set(['wiki/index.md', 'wiki/log.md', 'wiki/_report.md', 'wiki\\index.md', 'wiki\\log.md', 'wiki\\_report.md']);
    const isSkipped = (relPath: string) => {
      const normalized = relPath.replace(/\\/g, '/');
      return skipFiles.has(normalized) || normalized.startsWith('wiki/_review/');
    };

    // 1. Missing or incomplete frontmatter
    for (const p of pageInfo) {
      const relPath = path.relative(this.kbPath, p.filePath);
      if (isSkipped(relPath)) continue;
      if (!p.hasFrontmatter) {
        issues.push({
          type: 'missing_frontmatter',
          severity: 'warning',
          file: relPath,
          detail: 'Page has no frontmatter',
        });
      } else if (!p.title) {
        issues.push({
          type: 'missing_frontmatter',
          severity: 'warning',
          file: relPath,
          detail: 'Frontmatter is missing "title" field',
        });
      }
    }

    // 2. Empty tags
    for (const p of pageInfo) {
      const relPath = path.relative(this.kbPath, p.filePath);
      if (isSkipped(relPath)) continue;
      if (!p.hasFrontmatter) continue;
      const raw = p.raw;
      const endIndex = raw.indexOf('---', 3);
      if (endIndex === -1) continue;
      const yamlBlock = raw.slice(3, endIndex);
      const tagsMatch = yamlBlock.match(/tags:\s*\[([^\]]*)\]/);
      const tagsEmpty = !tagsMatch || tagsMatch[1].trim().length === 0;
      const noTagsKey = !yamlBlock.includes('tags:');
      if (noTagsKey || tagsEmpty) {
        const relPath = path.relative(this.kbPath, p.filePath);
        issues.push({
          type: 'empty_tags',
          severity: 'warning',
          file: relPath,
          detail: 'Page has no tags assigned',
        });
      }
    }

    // 3. Empty or undersized body
    for (const p of pageInfo) {
      const relPath = path.relative(this.kbPath, p.filePath);
      if (isSkipped(relPath)) continue;
      const bodyLen = p.body.trim().length;
      if (bodyLen < 100) {
        const relPath = path.relative(this.kbPath, p.filePath);
        issues.push({
          type: bodyLen === 0 ? 'empty_body' : 'undersized_page',
          severity: bodyLen === 0 ? 'error' : 'warning',
          file: relPath,
          detail: bodyLen === 0
            ? 'Page body is empty'
            : `Page body is too short (${bodyLen} chars, minimum 100)`,
        });
      }
    }

    // 4. Oversized pages (>1500 lines)
    for (const p of pageInfo) {
      const lineCount = p.raw.split('\n').length;
      if (lineCount > 1500) {
        const relPath = path.relative(this.kbPath, p.filePath);
        issues.push({
          type: 'oversized_page',
          severity: 'warning',
          file: relPath,
          detail: `Page has ${lineCount} lines (threshold: 1500)`,
        });
      }
    }

    // 5. Missing source references
    if (existingSourceIds) {
      for (const p of pageInfo) {
        const relPath = path.relative(this.kbPath, p.filePath);
        if (isSkipped(relPath) || !p.hasFrontmatter) continue;
        const missing = p.sources.filter((s) => !existingSourceIds.has(s));
        if (missing.length > 0) {
          issues.push({
            type: 'missing_source',
            severity: 'warning',
            file: relPath,
            detail: `${missing.length} source(s) no longer exist: ${missing.join(', ')}`,
          });
        }
      }
    }

    // 6. Duplicate titles — similar titles with same type
    const titled = pageInfo.filter((p) => p.title.length > 0);
    for (let i = 0; i < titled.length; i++) {
      for (let j = i + 1; j < titled.length; j++) {
        const a = titled[i];
        const b = titled[j];
        if (a.type !== b.type || a.type === '') continue;
        const sim = this.titleSimilarity(a.title, b.title);
        if (sim > 0.7) {
          const relA = path.relative(this.kbPath, a.filePath);
          const relB = path.relative(this.kbPath, b.filePath);
          issues.push({
            type: 'duplicate_title',
            severity: 'warning',
            file: relA,
            detail: `Similar title to "${b.title}" (similarity: ${(sim * 100).toFixed(0)}%)`,
            relatedFile: relB,
          });
        }
      }
    }

    const totalPages = pageInfo.filter((p) => !isSkipped(path.relative(this.kbPath, p.filePath))).length;
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    const penalty = errors * 8 + warnings * 2;
    const healthScore = Math.max(0, Math.min(100, 100 - penalty));
    this.appendLog('lint', `health=${healthScore}, issues=${issues.length}`, `errors=${errors}, warnings=${warnings}, total=${totalPages}`);
    return { issues, totalPages, healthScore };
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  async audit(correction: AuditCorrection): Promise<void> {
    const auditDir = path.join(this.kbPath, 'audit', 'corrections');
    fs.mkdirSync(auditDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const fileName = `${date}-${correction.type}.md`;
    const filePath = path.join(auditDir, fileName);

    const frontmatter = this.buildFrontmatter({
      title: `Audit: ${correction.targetPage}`,
      type: 'conversation',
      created: date,
      updated: date,
      sources: [],
      tags: ['audit', correction.type],
    });

    const body = [
      `## Target Page`,
      `[[${correction.targetPage}]]`,
      ``,
      `## Type`,
      `${correction.type}`,
      ``,
      `## Description`,
      `${correction.description}`,
      ``,
      `## Suggested Fix`,
      correction.suggestedFix ?? 'No fix suggested',
    ].join('\n');

    fs.writeFileSync(filePath, `${frontmatter}\n${body}`, 'utf-8');

    // Try to apply correction via LLM if a target page exists and a fix is suggested
    if (correction.suggestedFix) {
      const targetPath = this.findPagePath(correction.targetPage);
      if (targetPath && fs.existsSync(targetPath)) {
        try {
          const currentContent = fs.readFileSync(targetPath, 'utf-8');
          const updated = await this.llm.chat([
            {
              role: 'system',
              content: [
                'You are a wiki editor. Apply the described correction to the wiki page.',
                'Return the COMPLETE updated page content (including frontmatter). Do NOT add any explanation outside the page content.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: `Current page:\n${currentContent}\n\nCorrection:\n${correction.description}\n\nSuggested fix:\n${correction.suggestedFix}`,
            },
          ]);

          fs.writeFileSync(targetPath, updated, 'utf-8');
        } catch {
          // Best-effort LLM application
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Relevance search (V2: index-based multi-hop)
  // ---------------------------------------------------------------------------

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Extract keywords from a query string, handling both English and Chinese text.
   *
   * Strategy:
   * - English words: extract as-is (length >= 2, skip stop words)
   * - Chinese short segments (<=4 chars): keep whole as a keyword
   * - Chinese long segments (>4 chars):
   *   1. Generate bigrams, filter out noise (stop-char pairs)
   *   2. Generate trigrams as higher-precision alternatives
   *   3. Deduplicate: if a trigram covers a bigram, drop the bigram
   *      (e.g. "抗干扰" covers "抗干" at the same position → drop "抗干")
   */
  private extractKeywords(query: string): string[] {
    const keywords: string[] = [];
    const lower = query.toLowerCase();

    // Extract English/numeric words
    const englishWords = lower.match(/[a-z0-9]{2,}/g) || [];
    keywords.push(...englishWords.filter((w) => !STOP_WORDS.has(w)));

    // Extract Chinese character sequences
    const chineseSegments = query.match(/[一-鿿]+/g) || [];
    for (const seg of chineseSegments) {
      if (seg.length <= 4) {
        keywords.push(seg.toLowerCase());
        continue;
      }

      // Long segment: generate bigrams and trigrams
      const bigrams: string[] = [];
      const trigrams: string[] = [];

      for (let i = 0; i < seg.length - 1; i++) {
        const bigram = seg.slice(i, i + 2).toLowerCase();
        // Filter: skip if both chars are stop chars, or the bigram is in stop list
        if (
          CHINESE_STOP_BIGRAMS.has(bigram) ||
          (CHINESE_STOP_CHARS.has(bigram[0]) && CHINESE_STOP_CHARS.has(bigram[1]))
        ) {
          continue;
        }
        bigrams.push(bigram);
      }

      for (let i = 0; i <= seg.length - 3; i++) {
        const trigram = seg.slice(i, i + 3).toLowerCase();
        // Only keep trigrams that start and end with non-stop chars
        if (!CHINESE_STOP_CHARS.has(trigram[0]) && !CHINESE_STOP_CHARS.has(trigram[2])) {
          trigrams.push(trigram);
        }
      }

      // Deduplicate: mark bigrams that are covered by a trigram
      const coveredByTrigram = new Set<number>();
      for (const tri of trigrams) {
        const triStart = seg.toLowerCase().indexOf(tri);
        if (triStart === -1) continue;
        // This trigram covers bigrams at position triStart and triStart+1
        for (let offset = 0; offset <= 1; offset++) {
          coveredByTrigram.add(triStart + offset);
        }
      }

      for (let i = 0; i < bigrams.length; i++) {
        if (!coveredByTrigram.has(i)) {
          keywords.push(bigrams[i]);
        }
      }
      keywords.push(...trigrams);
    }

    return keywords;
  }

  findRelevantPages(query: string, topK: number): WikiPage[] {
    const weightedKeywords = this.buildWeightedKeywords(query);
    if (weightedKeywords.length === 0) return [];

    this.ensureSearchIndex();
    if (!this.indexCache || !this.pageMetaCache) return [];

    // --- Hop 1: Score pages using inverted index (no file I/O) ---
    const scoreMap = new Map<string, number>();

    for (const kw of weightedKeywords) {
      const entries = this.indexCache.get(kw.term);
      if (!entries) continue;
      const bodyHitCount = new Map<string, number>();
      for (const entry of entries) {
        if (entry.field === 'body') {
          const hits = (bodyHitCount.get(entry.pageKey) ?? 0) + 1;
          if (hits > 3) continue;
          bodyHitCount.set(entry.pageKey, hits);
        }
        let fieldWeight: number;
        if (entry.field === 'title') fieldWeight = 2.0;
        else if (entry.field === 'tag') fieldWeight = 1.0;
        else fieldWeight = 0.2;
        const score = fieldWeight * kw.weight;
        const current = scoreMap.get(entry.pageKey) ?? 0;
        scoreMap.set(entry.pageKey, current + score);
      }
    }

    // --- Hop 2: Follow wikilinks from high-score pages (read only top 8 bodies) ---
    const allTitles = Array.from(this.pageMetaCache.keys());
    const hop1Pages = Array.from(scoreMap.entries())
      .filter(([_, score]) => score >= 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    const visitedLinks = new Set<string>();
    for (const [pageKey] of hop1Pages) {
      const meta = this.pageMetaCache.get(pageKey);
      if (!meta) continue;
      const raw = fs.readFileSync(meta.path, 'utf-8');
      const { body } = this.parseFrontmatter(raw);
      const linkMatches = Array.from(body.matchAll(/\[\[([^\[\]]+)\]\]/g));
      for (const match of linkMatches) {
        const linkTarget = match[1].split('|')[0].trim().toLowerCase();
        if (visitedLinks.has(linkTarget)) continue;
        visitedLinks.add(linkTarget);
        let target = this.pageMetaCache.get(linkTarget);
        if (!target && !scoreMap.has(linkTarget)) {
          for (const [t] of allTitles) {
            if (t === pageKey) continue;
            if (this.fuzzyTitleMatch(linkTarget, allTitles)) {
              target = this.pageMetaCache.get(t);
              break;
            }
          }
        }
        if (target && linkTarget !== pageKey) {
          const linkerScore = scoreMap.get(pageKey) ?? 0;
          const inheritedScore = linkerScore * 0.3;
          const current = scoreMap.get(linkTarget) ?? 0;
          scoreMap.set(linkTarget, Math.max(current, inheritedScore));
        }
      }
    }

    // --- Build results ---
    const results: Array<{ page: WikiPage; score: number }> = [];
    for (const [pageKey, score] of scoreMap.entries()) {
      const meta = this.pageMetaCache.get(pageKey);
      if (!meta) continue;
      results.push({
        page: {
          title: meta.title,
          type: meta.type,
          path: meta.path,
          content: '',
          sources: [],
          tags: meta.tags,
        },
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK).map((r) => r.page);
  }

  // ---------------------------------------------------------------------------
  // Index rebuild
  // ---------------------------------------------------------------------------

  /**
   * Cross-link all wiki pages: scan every page for references to other page titles
   * and inject [[wikilinks]] where found. Runs after all ingestion is complete.
   */
  crossLinkAllPages(): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) return;

    const mdFiles = this.readdirRecursive(wikiDir, '.md');
    // Build title → { filePath, title } map
    const titleToPage = new Map<string, { filePath: string; title: string }>();
    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');
      titleToPage.set(title.toLowerCase(), { filePath, title });
    }

    // For each page, find references to other titles and inject wikilinks
    // First pass: exact match; second pass: fuzzy word-overlap match
    for (const filePath of mdFiles) {
      let content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(content);
      const currentPageTitle = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');

      let newBody = body;
      let changed = false;

      // Pass 1: Exact match
      for (const [lowerTitle, pageInfo] of Array.from(titleToPage)) {
        if (pageInfo.title === currentPageTitle) continue;
        if (pageInfo.title.length < 3) continue;

        const escaped = pageInfo.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`, 'i');
        if (regex.test(newBody)) {
          newBody = newBody.replace(regex, `[[${pageInfo.title}]]`);
          changed = true;
        }
      }

      // Pass 2: Fuzzy match for titles not yet linked
      const linkedTitles = new Set<string>();
      const linkRegex = /\[\[([^\[\]]+)\]\]/g;
      for (const match of newBody.matchAll(linkRegex)) {
        linkedTitles.add(match[1].split('|')[0].trim().toLowerCase());
      }
      for (const [lowerTitle, pageInfo] of Array.from(titleToPage)) {
        if (pageInfo.title === currentPageTitle) continue;
        if (linkedTitles.has(lowerTitle)) continue;
        if (pageInfo.title.length < 3) continue;
        if (this.fuzzyTitleMatch(pageInfo.title, [currentPageTitle])) continue;
        // Only inject if the fuzzy match appears in the body
        const titleLower = pageInfo.title.toLowerCase();
        const words = titleLower.split(/[\s\-_|()]+/).filter((w) => w.length > 2);
        for (const word of words) {
          const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`, 'i');
          if (regex.test(newBody)) {
            newBody = newBody.replace(regex, `[[${pageInfo.title}]]`);
            changed = true;
            break;
          }
        }
      }

      // Remove dead wikilinks (targets that no longer exist)
      const deadRegex = /\[\[([^\[\]]+)\]\]/g;
      const cleanedBody = newBody.replace(deadRegex, (match, target: string) => {
        const cleanTarget = target.split('|')[0].trim().toLowerCase();
        return titleToPage.has(cleanTarget) ? match : cleanTarget;
      });
      const bodyChanged = cleanedBody !== newBody || changed;

      if (bodyChanged) {
        // Reconstruct file with original frontmatter + updated body
        const fmEnd = content.indexOf('---', 3);
        const fmBlock = fmEnd !== -1 ? content.slice(0, fmEnd + 3) : '';
        fs.writeFileSync(filePath, `${fmBlock}\n${cleanedBody}`, 'utf-8');
      }
    }
  }

  updateIndex(): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    this.clearReportCache();

    const categories: Record<PageKind, Array<{ title: string; desc: string }>> = {
      concept: [],
      entity: [],
      summary: [],
      conversation: [],
    };

    for (const subdir of WIKI_SUBDIRS) {
      const dirPath = path.join(wikiDir, subdir);
      if (!fs.existsSync(dirPath)) continue;

      const kind = SUBDIR_TO_KIND[subdir];
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const { frontmatter, body } = this.parseFrontmatter(raw);
        const title = (frontmatter['title'] as string) ?? path.basename(file, '.md');
        const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
        const desc = firstLine.replace(/\[\[[^\]]*\]\]/g, '').replace(/^#+\s*/, '').trim().slice(0, 100);

        if (categories[kind]) {
          categories[kind].push({ title, desc });
        }
      }
    }

    const sections: string[] = ['# Wiki Index', ''];
    const typeLabels: Record<PageKind, string> = {
      concept: 'Concepts',
      entity: 'Entities',
      summary: 'Summaries',
      conversation: 'Conversations',
    };

    const allKinds: PageKind[] = ['concept', 'entity', 'summary', 'conversation'];
    for (const kind of allKinds) {
      const entries = categories[kind];
      if (entries.length === 0) continue;
      sections.push(`## ${typeLabels[kind]}`, '');
      for (const entry of entries) {
        sections.push(`- [[${entry.title}]] — ${entry.desc}`);
      }
      sections.push('');
    }

    fs.writeFileSync(path.join(wikiDir, 'index.md'), sections.join('\n'), 'utf-8');
  }

  /**
   * Incremental index update: only append newly created pages to existing index.md,
   * avoiding a full rebuild. Duplicates are skipped.
   */
  appendIndex(newPages: Array<{ title: string; kind: PageKind; desc: string }>): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    this.clearReportCache();
    const indexPath = path.join(wikiDir, 'index.md');

    // Read existing index to check which titles are already listed
    const existingTitles = new Set<string>();
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf-8');
      for (const match of content.matchAll(/\[\[([^\[\]]+)\]\]/g)) {
        existingTitles.add(match[1].split('|')[0].trim().toLowerCase());
      }
    }

    // Group new pages by kind
    const byKind = new Map<PageKind, Array<{ title: string; desc: string }>>();
    for (const p of newPages) {
      if (existingTitles.has(p.title.toLowerCase())) continue;
      if (!byKind.has(p.kind)) byKind.set(p.kind, []);
      byKind.get(p.kind)!.push({ title: p.title, desc: p.desc });
    }

    if (byKind.size === 0) return;

    const typeLabels: Record<PageKind, string> = {
      concept: 'Concepts',
      entity: 'Entities',
      summary: 'Summaries',
      conversation: 'Conversations',
    };

    // If index doesn't exist, create it from scratch
    if (!fs.existsSync(indexPath)) {
      this.updateIndex();
      return;
    }

    // Append new sections to existing index
    const additions: string[] = [];
    for (const [kind, entries] of Array.from(byKind)) {
      additions.push(`## ${typeLabels[kind]}`, '');
      for (const entry of entries) {
        additions.push(`- [[${entry.title}]] — ${entry.desc}`);
      }
      additions.push('');
    }

    const existing = fs.readFileSync(indexPath, 'utf-8');
    fs.writeFileSync(indexPath, existing + '\n' + additions.join('\n'), 'utf-8');
  }

  // ---------------------------------------------------------------------------
  // Operation log (chronological record of all wiki operations)
  // ---------------------------------------------------------------------------

  appendLog(operation: string, description: string, details?: string): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    const logPath = path.join(wikiDir, 'log.md');
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const lines: string[] = [`## [${timestamp}] ${operation} | ${description}`];
    if (details) lines.push('', details);
    lines.push('');
    const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
    fs.writeFileSync(logPath, existing + lines.join('\n'), 'utf-8');
  }

  /**
   * Append new content to an existing wiki page, merging tags/sources.
   * Adds a timestamped update section instead of overwriting.
   */
  private updateExistingPage(
    existingPath: string,
    newContent: string,
    sourceId: string,
    today: string,
    newTags: string[],
  ): void {
    const raw = fs.readFileSync(existingPath, 'utf-8');
    const { frontmatter, body } = this.parseFrontmatter(raw);
    const title = (frontmatter['title'] as string) ?? path.basename(existingPath, '.md');

    const existingTags = Array.isArray(frontmatter['tags']) ? (frontmatter['tags'] as string[]) : [];
    const mergedTags = [...new Set([...existingTags, ...newTags.filter(Boolean)])];

    const existingSources = Array.isArray(frontmatter['sources']) ? (frontmatter['sources'] as string[]) : [];
    const mergedSources = [...new Set([...existingSources, sourceId])];

    const updateSection = `\n\n---\n## Update [${today}]\n${newContent}`;
    const newBody = body + updateSection;

    const fm = this.buildFrontmatter({
      title,
      type: (frontmatter['type'] as PageKind) ?? 'concept',
      created: (frontmatter['created'] as string) ?? today,
      updated: today,
      sources: mergedSources,
      tags: mergedTags,
      difficulty: (frontmatter['difficulty'] as string) ?? undefined,
      entityType: (frontmatter['entity_type'] as string) ?? undefined,
    });

    fs.writeFileSync(existingPath, `${fm}\n${newBody}`, 'utf-8');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
  } {
    const frontmatter: Record<string, unknown> = {};

    if (!content.startsWith('---')) {
      return { frontmatter, body: content };
    }

    const endIndex = content.indexOf('---', 3);
    if (endIndex === -1) {
      return { frontmatter, body: content };
    }

    const yamlBlock = content.slice(3, endIndex).trim();
    const body = content.slice(endIndex + 3).trimStart();

    for (const line of yamlBlock.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();

      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        // Parse array: [item1, item2]
        const items = rawValue
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        frontmatter[key] = items;
      } else if (rawValue === 'true' || rawValue === 'false') {
        frontmatter[key] = rawValue === 'true';
      } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
        frontmatter[key] = Number(rawValue);
      } else {
        frontmatter[key] = rawValue.replace(/^['"]|['"]$/g, '');
      }
    }

    return { frontmatter, body };
  }

  slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  private static MAX_CONTENT_LENGTH = 5000;

  private truncateContent(text: string): string {
    if (text.length <= WikiEngine.MAX_CONTENT_LENGTH) return text;
    return text.slice(0, WikiEngine.MAX_CONTENT_LENGTH - 3) + '...';
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildFrontmatter(data: FrontmatterData): string {
    const tagsStr = data.tags.length > 0
      ? `[${data.tags.map((t) => `"${t}"`).join(', ')}]`
      : '[]';
    const sourcesStr = data.sources.length > 0
      ? `[${data.sources.map((s) => `"${s}"`).join(', ')}]`
      : '[]';
    const lines: string[] = [
      '---',
      `title: "${data.title.replace(/"/g, '\\"')}"`,
      `type: ${data.type}`,
      `created: ${data.created}`,
      `updated: ${data.updated}`,
      `sources: ${sourcesStr}`,
      `tags: ${tagsStr}`,
    ];
    if (data.difficulty) lines.push(`difficulty: ${data.difficulty}`);
    if (data.entityType) lines.push(`entity_type: ${data.entityType}`);
    lines.push('---');
    return lines.join('\n');
  }

  private injectWikilinks(content: string, allTitles: string[]): string {
    let result = content;
    for (const title of allTitles) {
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?<!\\[\\[)${escaped}(?!\\]\\])`, 'i');
      result = result.replace(regex, `[[${title}]]`);
    }
    return result;
  }

  private readAllWikiPages(): WikiPage[] {
    const wikiDir = path.join(this.kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) return [];

    const pages: WikiPage[] = [];
    const mdFiles = this.readdirRecursive(wikiDir, '.md');

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');
      const type = (frontmatter['type'] as PageKind) ?? 'concept';
      const sources = (frontmatter['sources'] as string[]) ?? [];
      const tags = (frontmatter['tags'] as string[]) ?? [];
      pages.push({ title, type, path: filePath, content: body, sources, tags });
    }

    return pages;
  }

  private splitPage(targetTitle: string): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    const mdFiles = this.readdirRecursive(wikiDir, '.md');

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');

      if (title !== targetTitle) continue;

      // Split body on ## headings
      const sections = body.split(/^## .+$/m).filter((s) => s.trim().length > 0);
      if (sections.length <= 1) return;

      const dirName = this.slugify(targetTitle);
      const parentDir = path.dirname(filePath);
      const subDir = path.join(parentDir, dirName);
      fs.mkdirSync(subDir, { recursive: true });

      const today = new Date().toISOString().slice(0, 10);

      // Move original to index.md and replace body with a hub linking to sub-pages
      const subPageTitles: string[] = [];
      for (let i = 0; i < sections.length; i++) {
        const firstLine = sections[i].split('\n').find((l) => l.trim().length > 0) ?? `Section ${i + 1}`;
        const sectionTitle = `${targetTitle} — ${firstLine.slice(0, 60)}`;
        subPageTitles.push(sectionTitle);
        const slug = this.slugify(`${targetTitle}-${i}`);
        const subPath = path.join(subDir, `${slug}.md`);
        const fm = this.buildFrontmatter({
          title: sectionTitle,
          type: (frontmatter['type'] as PageKind) ?? 'concept',
          created: today,
          updated: today,
          sources: (frontmatter['sources'] as string[]) ?? [],
          tags: (frontmatter['tags'] as string[]) ?? [],
        });
        fs.writeFileSync(subPath, `${fm}\n${sections[i].trim()}`, 'utf-8');
      }

      const hubBody = [
        `This topic has been split into sub-pages:`,
        '',
        ...subPageTitles.map((t) => `- [[${t}]]`),
      ].join('\n');

      const hubFm = this.buildFrontmatter({
        title: targetTitle,
        type: (frontmatter['type'] as PageKind) ?? 'concept',
        created: (frontmatter['created'] as string) ?? today,
        updated: today,
        sources: (frontmatter['sources'] as string[]) ?? [],
        tags: (frontmatter['tags'] as string[]) ?? [],
      });

      fs.writeFileSync(filePath, `${hubFm}\n${hubBody}`, 'utf-8');
      return;
    }
  }

  private mergeDuplicates(targetTitle: string): void {
    const wikiDir = path.join(this.kbPath, 'wiki');
    const mdFiles = this.readdirRecursive(wikiDir, '.md');

    const matches: Array<{ filePath: string; title: string; body: string; frontmatter: Record<string, unknown> }> = [];

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = this.parseFrontmatter(raw);
      const title = (frontmatter['title'] as string) ?? path.basename(filePath, '.md');

      if (title === targetTitle) {
        matches.push({ filePath, title, body, frontmatter });
      }
    }

    if (matches.length <= 1) return;

    // Keep the most complete version (longest body)
    matches.sort((a, b) => b.body.length - a.body.length);
    const primary = matches[0];
    const today = new Date().toISOString().slice(0, 10);

    // Merge unique content from others
    const mergedSections = new Set(primary.body.split('\n'));
    for (let i = 1; i < matches.length; i++) {
      for (const line of matches[i].body.split('\n')) {
        mergedSections.add(line);
      }
      // Remove duplicate file
      fs.unlinkSync(matches[i].filePath);
    }

    const mergedBody = Array.from(mergedSections).join('\n');
    const fm = this.buildFrontmatter({
      title: targetTitle,
      type: (primary.frontmatter['type'] as PageKind) ?? 'concept',
      created: (primary.frontmatter['created'] as string) ?? today,
      updated: today,
      sources: (primary.frontmatter['sources'] as string[]) ?? [],
      tags: (primary.frontmatter['tags'] as string[]) ?? [],
    });

    fs.writeFileSync(primary.filePath, `${fm}\n${mergedBody}`, 'utf-8');
  }

  private extractCitations(text: string): string[] {
    const matches = text.matchAll(/\[\[([^\]]+)\]\]/g);
    return Array.from(matches, (m) => m[1]);
  }

  /**
   * Check if a wikilink target roughly matches any existing page title.
   * Uses word-overlap ratio: shared words / total unique words.
   */
  private fuzzyTitleMatch(target: string, allTitles: string[]): boolean {
    const targetLower = target.toLowerCase();
    const targetWords = new Set(targetLower.split(/[\s\-_|()]+/).filter((w) => w.length > 1));
    if (targetWords.size === 0) return false;
    for (const title of allTitles) {
      const titleLower = title.toLowerCase();
      if (targetLower === titleLower) continue;
      const titleWords = new Set(titleLower.split(/[\s\-_|()]+/).filter((w) => w.length > 1));
      let overlap = 0;
      for (const w of targetWords) {
        if (titleWords.has(w)) overlap++;
      }
      const union = targetWords.size + titleWords.size - overlap;
      if (union === 0) continue;
      if (overlap / union >= 0.6) return true;
    }
    return false;
  }

  /**
   * Jaccard similarity between two titles based on character bigrams.
   */
  private titleSimilarity(a: string, b: string): number {
    const bigrams = (s: string) => {
      const set = new Set<string>();
      const lower = s.toLowerCase();
      for (let i = 0; i < lower.length - 1; i++) {
        set.add(lower.slice(i, i + 2));
      }
      return set;
    };
    const sa = bigrams(a);
    const sb = bigrams(b);
    if (sa.size === 0 && sb.size === 0) return 0;
    let intersection = 0;
    for (const bg of sa) {
      if (sb.has(bg)) intersection++;
    }
    return intersection / (sa.size + sb.size - intersection);
  }

  /**
   * Find a wiki page by title. Uses case-insensitive exact match first,
   * then falls back to substring/contains fuzzy matching.
   */
  private findPagePath(title: string): string | undefined {
    if (!title) return undefined;
    if (!this.titleCache) {
      this.titleCache = this.buildTitleCache();
    }
    if (this.titleCache.size === 0) return undefined;

    // 1. Exact case-insensitive match
    const exact = this.titleCache.get(title.toLowerCase());
    if (exact) return exact.path;

    // 2. Fuzzy: check if existing title contains search term or vice versa
    const lowerSearch = title.toLowerCase();
    let bestMatch: TitleCacheEntry | undefined;
    let bestScore = 0;
    for (const entry of this.titleCache.values()) {
      const lowerTitle = entry.title.toLowerCase();
      if (lowerTitle === lowerSearch) { bestMatch = entry; break; }
      if (lowerTitle.includes(lowerSearch) || lowerSearch.includes(lowerTitle)) {
        const score = Math.min(lowerTitle.length, lowerSearch.length);
        if (score > bestScore) { bestScore = score; bestMatch = entry; }
      }
    }
    return bestMatch?.path;
  }

  private readdirRecursive(dir: string, extension: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.readdirRecursive(fullPath, extension));
      } else if (entry.name.endsWith(extension)) {
        results.push(fullPath);
      }
    }

    return results;
  }
}
