import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  KnowledgeBase,
  KbSource,
  CreateKnowledgeBaseInput,
  ImportResult,
  IngestResult,
  CompileResult,
  QueryResult,
  LintResult,
  AuditCorrection,
  SourceFileType,
} from './types';
import type { DatabaseManager } from '../../platform/store/types';
import { KbLlmCaller } from './llm-caller';
import { WikiEngine } from './wiki-engine';
import { KbRetriever } from './retriever';
import { extractContent, detectFileType } from './content-extractor';
import { getAicoBotDir } from '../config.service';
import { getConversation } from '../conversation.service';

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: KnowledgeBaseService | null = null;

export function setKnowledgeBaseService(dbManager: DatabaseManager): void {
  instance = new KnowledgeBaseService(dbManager);
}

export function getKnowledgeBaseService(): KnowledgeBaseService {
  if (!instance) {
    throw new Error('KnowledgeBaseService not initialized. Call setKnowledgeBaseService() first.');
  }
  return instance;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const KB_MIGRATIONS = [
  {
    version: 1,
    description: 'Create knowledge base tables',
    up(db: Database.Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_bases (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          icon TEXT NOT NULL DEFAULT '',
          source_count INTEGER NOT NULL DEFAULT 0,
          page_count INTEGER NOT NULL DEFAULT 0,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kb_sources (
          id TEXT PRIMARY KEY,
          kb_id TEXT NOT NULL,
          original_path TEXT NOT NULL,
          stored_name TEXT NOT NULL,
          file_type TEXT NOT NULL,
          file_size INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          error_message TEXT NOT NULL DEFAULT '',
          ingested_at TEXT,
          compiled_at TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS kb_conversations (
          id TEXT PRIMARY KEY,
          kb_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          original_length INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_kb_sources_kb_id ON kb_sources(kb_id);
        CREATE INDEX IF NOT EXISTS idx_kb_conversations_kb_id ON kb_conversations(kb_id);
      `);
    },
  },
];

// ---------------------------------------------------------------------------
// KB Subdirectories
// ---------------------------------------------------------------------------

const KB_SUBDIRS = [
  'raw',
  'wiki',
  'audit',
  path.join('wiki', 'concepts'),
  path.join('wiki', 'entities'),
  path.join('wiki', 'summaries'),
  path.join('wiki', 'conversations'),
];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class KnowledgeBaseService {
  private dbManager: DatabaseManager;
  private db: Database.Database;

  private constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
    this.db = dbManager.getAppDatabase();
    dbManager.runMigrations(this.db, 'knowledge_base', KB_MIGRATIONS);
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  getKbPath(id: string): string {
    return path.join(getAicoBotDir(), 'knowledge-bases', id);
  }

  ensureKbDirectories(kbPath: string): void {
    for (const subdir of KB_SUBDIRS) {
      const dir = path.join(kbPath, subdir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  listKnowledgeBases(): KnowledgeBase[] {
    const rows = this.db
      .prepare('SELECT * FROM knowledge_bases ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;

    return rows.map(this.rowToKb);
  }

  getKnowledgeBase(id: string): KnowledgeBase | null {
    const row = this.db
      .prepare('SELECT * FROM knowledge_bases WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    return row ? this.rowToKb(row) : null;
  }

  createKnowledgeBase(input: CreateKnowledgeBaseInput): KnowledgeBase {
    const existing = this.db.prepare('SELECT id FROM knowledge_bases WHERE name = ?').get(input.name);
    if (existing) {
      throw new Error('已有该知识库，请修改知识库名称');
    }

    const id = crypto.randomUUID();
    const now = this.now();

    const kbPath = this.getKbPath(id);
    this.ensureKbDirectories(kbPath);

    this.db.prepare(
      `INSERT INTO knowledge_bases (id, name, description, icon, source_count, page_count, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, 1, ?, ?)`,
    ).run(id, input.name, input.description ?? '', input.icon ?? '', now, now);

    return {
      id,
      name: input.name,
      description: input.description ?? '',
      icon: input.icon ?? '',
      sourceCount: 0,
      pageCount: 0,
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateKnowledgeBase(
    id: string,
    updates: Partial<Pick<KnowledgeBase, 'name' | 'description' | 'icon' | 'isEnabled'>>,
  ): KnowledgeBase | null {
    const existing = this.getKnowledgeBase(id);
    if (!existing) return null;

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      params.push(updates.description);
    }
    if (updates.icon !== undefined) {
      setClauses.push('icon = ?');
      params.push(updates.icon);
    }
    if (updates.isEnabled !== undefined) {
      setClauses.push('is_enabled = ?');
      params.push(updates.isEnabled ? 1 : 0);
    }

    if (setClauses.length === 0) return existing;

    setClauses.push('updated_at = ?');
    params.push(this.now());
    params.push(id);

    this.db.prepare(
      `UPDATE knowledge_bases SET ${setClauses.join(', ')} WHERE id = ?`,
    ).run(...params);

    return this.getKnowledgeBase(id);
  }

  deleteKnowledgeBase(id: string): void {
    this.db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id);

    const kbPath = this.getKbPath(id);
    if (fs.existsSync(kbPath)) {
      fs.rmSync(kbPath, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Source management
  // ---------------------------------------------------------------------------

  async importFiles(kbId: string, filePaths: string[]): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, failed: 0, errors: [] };
    const kbPath = this.getKbPath(kbId);
    const rawDir = path.join(kbPath, 'raw');

    if (!fs.existsSync(rawDir)) {
      fs.mkdirSync(rawDir, { recursive: true });
    }

    for (const filePath of filePaths) {
      try {
        if (!fs.existsSync(filePath)) {
          result.failed++;
          result.errors.push({ file: filePath, error: 'File not found' });
          continue;
        }

        const fileStat = fs.statSync(filePath);
        if (fileStat.size > 10 * 1024 * 1024) {
          const fileName = path.basename(filePath);
          const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1);
          result.failed++;
          result.errors.push({ file: fileName, error: '大于10MB，请修改为markdown格式' });
          continue;
        }

        const ext = path.extname(filePath).toLowerCase();
        let fileType: SourceFileType;
        try {
          fileType = detectFileType(ext);
        } catch {
          result.failed++;
          result.errors.push({ file: filePath, error: `Unsupported file type: ${ext}` });
          continue;
        }

        const originalBasename = path.basename(filePath);

        // Avoid name collision
        let storedName = originalBasename;
        let destPath = path.join(rawDir, storedName);
        if (fs.existsSync(destPath)) {
          storedName = `${path.basename(filePath, ext)}_${Date.now()}${ext}`;
          destPath = path.join(rawDir, storedName);
        }

        fs.cpSync(filePath, destPath);
        const stat = fs.statSync(destPath);

        const now = this.now();
        this.db.prepare(
          `INSERT INTO kb_sources (id, kb_id, original_path, stored_name, file_type, file_size, status, error_message, ingested_at, compiled_at, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', '', NULL, NULL, '{}', ?)`,
        ).run(
          crypto.randomUUID(),
          kbId,
          filePath,
          storedName,
          fileType,
          stat.size,
          now,
        );

        this.db.prepare(
          'UPDATE knowledge_bases SET source_count = source_count + 1, updated_at = ? WHERE id = ?',
        ).run(now, kbId);

        result.imported++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result.failed++;
        result.errors.push({ file: filePath, error: message });
      }
    }

    return result;
  }

  async importFolder(kbId: string, folderPath: string): Promise<ImportResult> {
    if (!fs.existsSync(folderPath)) {
      return { imported: 0, failed: 0, errors: [{ file: folderPath, error: 'Directory not found' }] };
    }

    const SUPPORTED_EXTENSIONS = new Set([
      '.md', '.markdown', '.pdf', '.html', '.htm', '.txt',
      '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs',
      '.java', '.cpp', '.c', '.h', '.css', '.json',
      '.yaml', '.yml', '.xml', '.sh', '.bash', '.sql',
      '.vue', '.svelte',
    ]);

    const filePaths: string[] = [];
    const collectFiles = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          collectFiles(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            filePaths.push(fullPath);
          }
        }
      }
    };
    collectFiles(folderPath);

    if (filePaths.length === 0) {
      return { imported: 0, failed: 0, errors: [{ file: folderPath, error: 'No supported files found in folder' }] };
    }

    return this.importFiles(kbId, filePaths);
  }

  removeSource(kbId: string, sourceId: string): void {
    const source = this.db
      .prepare('SELECT * FROM kb_sources WHERE id = ? AND kb_id = ?')
      .get(sourceId, kbId) as Record<string, unknown> | undefined;

    if (!source) return;

    const rawPath = path.join(this.getKbPath(kbId), 'raw', source.stored_name as string);
    if (fs.existsSync(rawPath)) {
      fs.rmSync(rawPath);
    }

    this.db.prepare('DELETE FROM kb_sources WHERE id = ?').run(sourceId);

    const now = this.now();
    this.db.prepare(
      'UPDATE knowledge_bases SET source_count = MAX(source_count - 1, 0), updated_at = ? WHERE id = ?',
    ).run(now, kbId);
  }

  listSources(kbId: string): KbSource[] {
    const rows = this.db
      .prepare('SELECT * FROM kb_sources WHERE kb_id = ? ORDER BY created_at DESC')
      .all(kbId) as Array<Record<string, unknown>>;

    return rows.map(this.rowToSource);
  }

  // ---------------------------------------------------------------------------
  // Conversation precipitation
  // ---------------------------------------------------------------------------

  async saveConversationToKb(
    kbId: string,
    spaceId: string,
    conversationId: string,
  ): Promise<{ summary: string }> {
    const conversation = getConversation(spaceId, conversationId);
    if (!conversation || conversation.messages.length === 0) {
      throw new Error(`Conversation not found or empty: ${conversationId}`);
    }

    const messagesText = conversation.messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    const llm = await KbLlmCaller.create();
    const summary = await llm.chat([
      {
        role: 'system',
        content: [
          'You are a knowledge base summarizer. Read the conversation and produce a structured summary.',
          'Focus on decisions made, problems solved, and key insights discussed.',
          'Output markdown format with headers for topics discussed.',
        ].join('\n'),
      },
      { role: 'user', content: messagesText },
    ]);

    const id = crypto.randomUUID();
    const now = this.now();
    const kbPath = this.getKbPath(kbId);
    const convDir = path.join(kbPath, 'wiki', 'conversations');

    if (!fs.existsSync(convDir)) {
      fs.mkdirSync(convDir, { recursive: true });
    }

    const frontmatter = [
      '---',
      `title: "${conversation.title.replace(/"/g, '\\"')}"`,
      'type: conversation',
      `created: ${now.slice(0, 10)}`,
      `updated: ${now.slice(0, 10)}`,
      `sources: ["${conversationId}"]`,
      `tags: ["precipitated", "${spaceId}"]`,
      '---',
    ].join('\n');

    const mdPath = path.join(convDir, `${id}.md`);
    fs.writeFileSync(mdPath, `${frontmatter}\n\n${summary}`, 'utf-8');

    this.db.prepare(
      `INSERT INTO kb_conversations (id, kb_id, space_id, conversation_id, summary, original_length, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'compiled', ?)`,
    ).run(id, kbId, spaceId, conversationId, summary, messagesText.length, now);

    this.db.prepare(
      'UPDATE knowledge_bases SET source_count = source_count + 1, updated_at = ? WHERE id = ?',
    ).run(now, kbId);

    return { summary };
  }

  // ---------------------------------------------------------------------------
  // Wiki operations
  // ---------------------------------------------------------------------------

  private async createWikiEngine(kbId: string): Promise<WikiEngine> {
    const llm = await KbLlmCaller.create();
    const kbPath = this.getKbPath(kbId);
    return new WikiEngine(kbPath, llm);
  }

  /**
   * Cross-link all wiki pages without LLM — just scans titles and injects wikilinks.
   */
  crossLinkAllPages(kbId: string): void {
    const kbPath = this.getKbPath(kbId);
    const engine = new WikiEngine(kbPath, null as unknown as KbLlmCaller);
    engine.crossLinkAllPages();
  }

  async ingest(kbId: string, sourceId: string, signal?: AbortSignal, skipIndexUpdate = false): Promise<IngestResult> {
    const sourceRow = this.db
      .prepare('SELECT * FROM kb_sources WHERE id = ? AND kb_id = ?')
      .get(sourceId, kbId) as Record<string, unknown> | undefined;

    if (!sourceRow) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    const source = this.rowToSource(sourceRow);
    const rawPath = path.join(this.getKbPath(kbId), 'raw', source.storedName);

    if (!fs.existsSync(rawPath)) {
      throw new Error(`Raw file not found: ${rawPath}`);
    }

    const { text } = await extractContent(rawPath);
    const engine = await this.createWikiEngine(kbId);

    this.db.prepare("UPDATE kb_sources SET status = 'ingesting' WHERE id = ?").run(sourceId);

    try {
      const result = await engine.ingest(source, text, undefined, signal, skipIndexUpdate);

      const now = this.now();
      this.db.prepare(
        "UPDATE kb_sources SET status = 'compiled', ingested_at = ?, compiled_at = ? WHERE id = ?",
      ).run(now, now, sourceId);

      this.recountPages(kbId);

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== '提取已取消') {
        this.db.prepare(
          "UPDATE kb_sources SET status = 'error', error_message = ? WHERE id = ?",
        ).run(message, sourceId);
      }
      throw err;
    }
  }

  async ingestIncremental(kbId: string, signal?: AbortSignal): Promise<IngestResult & { errors: string[] }> {
    const sources = this.listSources(kbId);
    const toIngest = sources.filter((s) => s.status === 'pending');

    if (toIngest.length === 0) {
      return { pagesCreated: 0, pagesUpdated: 0, conceptsCount: 0, entitiesCount: 0, summaryCreated: false, errors: [], newPages: [] };
    }

    const total: IngestResult & { errors: string[] } = {
      pagesCreated: 0, pagesUpdated: 0, conceptsCount: 0, entitiesCount: 0,
      summaryCreated: false, errors: [], newPages: [],
    };

    for (const source of toIngest) {
      try {
        const result = await this.ingest(kbId, source.id, signal, true);
        total.pagesCreated += result.pagesCreated;
        total.pagesUpdated += result.pagesUpdated;
        total.conceptsCount += result.conceptsCount;
        total.entitiesCount += result.entitiesCount;
        if (result.summaryCreated) total.summaryCreated = true;
        total.newPages.push(...result.newPages);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        total.errors.push(`${source.storedName}: ${message}`);
      }
    }

    // Append new pages to existing index instead of rebuilding
    if (total.newPages.length > 0) {
      const kbPath = this.getKbPath(kbId);
      const engine = new WikiEngine(kbPath, null as unknown as KbLlmCaller);
      engine.appendIndex(total.newPages as Array<{ title: string; kind: 'concept' | 'entity' | 'summary' | 'conversation'; desc: string }>);
      engine.crossLinkAllPages();
    }

    this.recountPages(kbId);
    return total;
  }

  async ingestAll(kbId: string): Promise<IngestResult & { errors: string[] }> {
    const sources = this.listSources(kbId);
    const toIngest = sources.filter((s) => s.status !== 'ingesting');

    const total: IngestResult & { errors: string[] } = {
      pagesCreated: 0,
      pagesUpdated: 0,
      conceptsCount: 0,
      entitiesCount: 0,
      summaryCreated: false,
      errors: [],
      newPages: [],
    };

    if (toIngest.length === 0) {
      return total;
    }

    for (const source of toIngest) {
      try {
        const result = await this.ingest(kbId, source.id);
        total.pagesCreated += result.pagesCreated;
        total.pagesUpdated += result.pagesUpdated;
        total.conceptsCount += result.conceptsCount;
        total.entitiesCount += result.entitiesCount;
        if (result.summaryCreated) total.summaryCreated = true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        total.errors.push(`${source.storedName}: ${message}`);
      }
    }

    return total;
  }

  async recompile(kbId: string): Promise<IngestResult & { errors: string[] }> {
    const kbPath = this.getKbPath(kbId);
    const wikiDir = path.join(kbPath, 'wiki');
    if (fs.existsSync(wikiDir)) {
      fs.rmSync(wikiDir, { recursive: true });
    }

    const sources = this.listSources(kbId);

    const total: IngestResult & { errors: string[] } = {
      pagesCreated: 0,
      pagesUpdated: 0,
      conceptsCount: 0,
      entitiesCount: 0,
      summaryCreated: false,
      errors: [],
      newPages: [],
    };

    if (sources.length === 0) {
      return total;
    }

    for (const source of sources) {
      try {
        const result = await this.ingest(kbId, source.id);
        total.pagesCreated += result.pagesCreated;
        total.pagesUpdated += result.pagesUpdated;
        total.conceptsCount += result.conceptsCount;
        total.entitiesCount += result.entitiesCount;
        if (result.summaryCreated) total.summaryCreated = true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        total.errors.push(`${source.storedName}: ${message}`);
      }
    }

    return total;
  }

  async compile(kbId: string): Promise<CompileResult> {
    const engine = await this.createWikiEngine(kbId);
    return engine.compile();
  }

  async query(kbId: string, question: string): Promise<QueryResult> {
    const engine = await this.createWikiEngine(kbId);
    return engine.query(question);
  }

  saveQueryResult(kbId: string, question: string, answer: string, citedPages: string[]): void {
    const kbPath = this.getKbPath(kbId);
    const engine = new WikiEngine(kbPath, null as unknown as KbLlmCaller);
    engine.saveQueryResult(question, answer, citedPages);
    this.recountPages(kbId);
  }

  async lint(kbId: string): Promise<LintResult> {
    const engine = await this.createWikiEngine(kbId);
    const existingSourceIds = new Set(this.listSources(kbId).map((s) => s.id));
    return engine.lint(existingSourceIds);
  }

  async generateReport(kbId: string): Promise<string> {
    const engine = await this.createWikiEngine(kbId);
    return engine.generateReport();
  }

  async loadReport(kbId: string): Promise<string | null> {
    const engine = await this.createWikiEngine(kbId);
    return engine.loadReport();
  }

  async audit(kbId: string, correction: AuditCorrection): Promise<void> {
    const engine = await this.createWikiEngine(kbId);
    await engine.audit(correction);
  }

  // ---------------------------------------------------------------------------
  // Chat retrieval
  // ---------------------------------------------------------------------------

  async retrieveForChat(kbId: string, userMessage: string): Promise<string | null> {
    const engine = await this.createWikiEngine(kbId);
    const retriever = new KbRetriever(engine);
    return retriever.retrieve(userMessage);
  }

  // ---------------------------------------------------------------------------
  // Page & conversation listing
  // ---------------------------------------------------------------------------

  listConversations(kbId: string): Array<Record<string, unknown>> {
    const db = this.dbManager.getAppDatabase();
    return db
      .prepare('SELECT * FROM kb_conversations WHERE kb_id = ? ORDER BY created_at DESC')
      .all(kbId) as Array<Record<string, unknown>>;
  }

  resetIngestingSources(kbId: string): void {
    // Previously compiled files (ingested_at is set) should revert to 'compiled', not 'pending'
    this.db.prepare(
      "UPDATE kb_sources SET status = 'compiled', error_message = '' WHERE kb_id = ? AND status = 'ingesting' AND ingested_at IS NOT NULL",
    ).run(kbId);
    this.db.prepare(
      "UPDATE kb_sources SET status = 'pending', error_message = '' WHERE kb_id = ? AND status = 'ingesting' AND ingested_at IS NULL",
    ).run(kbId);
  }

  recountPages(kbId: string): void {
    const count = this.listWikiPages(kbId).length;
    this.db.prepare(
      'UPDATE knowledge_bases SET page_count = ?, updated_at = ? WHERE id = ?',
    ).run(count, this.now(), kbId);
  }

  listWikiPages(kbId: string): Array<{ title: string; path: string; type: string }> {
    const kbPath = this.getKbPath(kbId);
    const wikiDir = path.join(kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) return [];
    const pages: Array<{ title: string; path: string; type: string }> = [];
    const subdirs = ['concepts', 'entities', 'summaries', 'conversations'];
    for (const subdir of subdirs) {
      const dir = path.join(wikiDir, subdir);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const relPath = path.join(subdir, file);
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        const typeMatch = content.match(/^type:\s*(.+)$/m);
        pages.push({
          title: titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, ''),
          path: relPath,
          type: typeMatch ? typeMatch[1].trim() : subdir.replace(/s$/, ''),
        });
      }
    }
    return pages;
  }

  getGraphData(kbId: string): { nodes: Array<{ id: string; title: string; type: string; tags: string[] }>; links: Array<{ source: string; target: string }> } {
    const pages = this.listWikiPages(kbId);
    const kbPath = this.getKbPath(kbId);
    const wikiDir = path.join(kbPath, 'wiki');

    interface PageNode {
      id: string;
      title: string;
      type: string;
      tags: string[];
      filePath: string;
    }

    const pageNodes: PageNode[] = pages.map((p) => {
      const fullPath = path.join(kbPath, 'wiki', p.path);
      const tags: string[] = [];
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const tagMatch = content.match(/^tags:\s*\[(.+?)\]/m);
        if (tagMatch) {
          for (const t of tagMatch[1].split(',')) {
            const cleaned = t.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
            if (cleaned) tags.push(cleaned);
          }
        }
      }
      return { id: p.path, title: p.title, type: p.type, tags, filePath: fullPath };
    });

    // Add index.md as a node
    const indexPath = path.join(wikiDir, 'index.md');
    const indexNode: PageNode | null = fs.existsSync(indexPath)
      ? { id: 'index', title: 'index', type: 'index', tags: [], filePath: indexPath }
      : null;
    if (indexNode) pageNodes.push(indexNode);

    const links: Array<{ source: string; target: string }> = [];
    const linkSet = new Set<string>();

    // 1. Tag nodes: each unique tag becomes a small node, pages link to their tags
    const allTags = new Set<string>();
    for (const node of pageNodes) {
      for (const tag of node.tags) allTags.add(tag);
    }
    const tagNodes: PageNode[] = Array.from(allTags).map((tag) => ({
      id: `__tag__${tag}`,
      title: tag,
      type: 'tag',
      tags: [],
      filePath: '',
    }));
    for (const node of pageNodes) {
      for (const tag of node.tags) {
        const tagId = `__tag__${tag}`;
        const key = [node.id, tagId].sort().join('|||');
        if (!linkSet.has(key)) {
          linkSet.add(key);
          links.push({ source: node.id, target: tagId });
        }
      }
    }

    // 2. Same-title cross-type links: pages with identical titles but different types should be connected
    const titleToNodes = new Map<string, PageNode[]>();
    for (const node of pageNodes) {
      const key = node.title.toLowerCase().trim();
      if (!titleToNodes.has(key)) titleToNodes.set(key, []);
      titleToNodes.get(key)!.push(node);
    }
    for (const [, nodesWithTitle] of Array.from(titleToNodes)) {
      for (let i = 0; i < nodesWithTitle.length; i++) {
        for (let j = i + 1; j < nodesWithTitle.length; j++) {
          if (nodesWithTitle[i].type === nodesWithTitle[j].type) continue;
          const key = [nodesWithTitle[i].id, nodesWithTitle[j].id].sort().join('|||');
          if (!linkSet.has(key)) {
            linkSet.add(key);
            links.push({ source: nodesWithTitle[i].id, target: nodesWithTitle[j].id });
          }
        }
      }
    }

    // 3. Wikilink-based connections (page → page)
    // titleMap maps lowercase title → array of node ids (handles same-title different-type pages)
    const titleMap = new Map<string, string[]>();
    for (const n of pageNodes) {
      const key = n.title.toLowerCase().trim();
      if (!titleMap.has(key)) titleMap.set(key, []);
      titleMap.get(key)!.push(n.id);
    }
    for (const node of pageNodes) {
      if (!fs.existsSync(node.filePath)) continue;
      const content = fs.readFileSync(node.filePath, 'utf-8');
      const matches = content.matchAll(/\[\[([^\[\]]+)\]\]/g);
      for (const match of matches) {
        const target = match[1].split('|')[0].trim();
        const matchedIds = titleMap.get(target.toLowerCase());
        if (matchedIds) {
          for (const targetId of matchedIds) {
            if (targetId === node.id) continue;
            const key = [node.id, targetId].sort().join('|||');
            if (!linkSet.has(key)) {
              linkSet.add(key);
              links.push({ source: node.id, target: targetId });
            }
          }
        }
      }
    }

    // 4. Index connects to all other page nodes
    if (indexNode) {
      for (const node of pageNodes) {
        if (node.id === 'index') continue;
        const key = ['index', node.id].sort().join('|||');
        if (!linkSet.has(key)) {
          linkSet.add(key);
          links.push({ source: 'index', target: node.id });
        }
      }
    }

    const nodes = [...pageNodes, ...tagNodes];
    return { nodes, links };
  }

  readWikiPage(kbId: string, pagePath: string): string {
    const kbPath = this.getKbPath(kbId);
    const fullPath = path.join(kbPath, 'wiki', pagePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Wiki page not found: ${pagePath}`);
    }
    return fs.readFileSync(fullPath, 'utf-8');
  }

  updateWikiPage(kbId: string, pagePath: string, content: string): void {
    const kbPath = this.getKbPath(kbId);
    const fullPath = path.join(kbPath, 'wiki', pagePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Wiki page not found: ${pagePath}`);
    }
    fs.writeFileSync(fullPath, content, 'utf-8');
    const reportPath = path.join(kbPath, 'wiki', '_report.md');
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  }

  deleteWikiPage(kbId: string, pagePath: string): void {
    const kbPath = this.getKbPath(kbId);
    const fullPath = path.join(kbPath, 'wiki', pagePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Wiki page not found: ${pagePath}`);
    }
    fs.unlinkSync(fullPath);

    // Rebuild index.md and update page_count since the graph is derived from wiki files on disk
    try {
      const wikiDir = path.join(kbPath, 'wiki');
      if (fs.existsSync(wikiDir)) {
        const engine = new WikiEngine(kbPath, null as unknown as KbLlmCaller);
        engine.updateIndex();
        engine.crossLinkAllPages();
      }
      const updatedCount = this.listWikiPages(kbId).length;
      this.db.prepare(
        'UPDATE knowledge_bases SET page_count = ?, updated_at = ? WHERE id = ?',
      ).run(updatedCount, this.now(), kbId);
    } catch (err) {
      console.error('[KB] Failed to rebuild index after page deletion:', err);
    }
  }

  getPageLinks(kbId: string, pagePath: string): { outgoing: string[]; incoming: string[] } {
    const kbPath = this.getKbPath(kbId);
    const wikiDir = path.join(kbPath, 'wiki');
    if (!fs.existsSync(wikiDir)) return { outgoing: [], incoming: [] };

    const targetFullPath = path.resolve(wikiDir, pagePath);
    if (!fs.existsSync(targetFullPath)) {
      throw new Error(`Wiki page not found: ${pagePath}`);
    }

    const pageContent = fs.readFileSync(targetFullPath, 'utf-8');
    const titleMatch = pageContent.match(/^title:\s*"?([^"\n]+)"?/m);
    const thisTitle = titleMatch ? titleMatch[1].trim() : '';
    const skipTargets = new Set<string>(['log', '_report', ...thisTitle ? [thisTitle] : []]);

    const outgoing = Array.from(pageContent.matchAll(/\[\[([^\]]+)\]\]/g))
      .map((m) => m[1].split('|')[0].trim())
      .filter((t) => !skipTargets.has(t.toLowerCase()));

    const incoming: string[] = [];
    const mdFiles = this.readdirRecursive(wikiDir, '.md');
    for (const fp of mdFiles) {
      if (fp === targetFullPath) continue;
      const raw = fs.readFileSync(fp, 'utf-8');
      const otherTitleMatch = raw.match(/^title:\s*"?([^"\n]+)"?/m);
      const otherTitle = otherTitleMatch ? otherTitleMatch[1].trim() : path.basename(fp, '.md');
      if (skipTargets.has(otherTitle.toLowerCase())) continue;
      const links = Array.from(raw.matchAll(/\[\[([^\]]+)\]\]/g)).map((m) => m[1]);
      if (links.length > 0 && thisTitle && links.includes(thisTitle)) {
        incoming.push(otherTitle);
      }
    }
    return { outgoing, incoming };
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

  readSourceFile(kbId: string, sourceId: string): { text: string; isText: boolean; fileName: string } {
    const sourceRow = this.db
      .prepare('SELECT * FROM kb_sources WHERE id = ? AND kb_id = ?')
      .get(sourceId, kbId) as Record<string, unknown> | undefined;

    if (!sourceRow) throw new Error('Source not found');

    const fileName = (sourceRow.stored_name as string) || (sourceRow.original_path as string) || sourceId;
    const rawPath = path.join(this.getKbPath(kbId), 'raw', sourceRow.stored_name as string);
    if (!fs.existsSync(rawPath)) throw new Error('Source file not found');

    const fileType = sourceRow.file_type as string;
    if (fileType === 'pdf') {
      const stat = fs.statSync(rawPath);
      return { text: `[PDF] ${(sourceRow.original_path as string)}\nSize: ${(stat.size / 1024).toFixed(1)} KB`, isText: false, fileName };
    }

    return { text: fs.readFileSync(rawPath, 'utf-8'), isText: true, fileName };
  }

  getSourceFilePath(kbId: string, sourceId: string): string {
    const sourceRow = this.db
      .prepare('SELECT * FROM kb_sources WHERE id = ? AND kb_id = ?')
      .get(sourceId, kbId) as Record<string, unknown> | undefined;

    if (!sourceRow) throw new Error('Source not found');

    const rawPath = path.join(this.getKbPath(kbId), 'raw', sourceRow.stored_name as string);
    if (!fs.existsSync(rawPath)) throw new Error('Source file not found');
    return rawPath;
  }

  // ---------------------------------------------------------------------------
  // Row mappers
  // ---------------------------------------------------------------------------

  private rowToKb(row: Record<string, unknown>): KnowledgeBase {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      icon: row.icon as string,
      sourceCount: row.source_count as number,
      pageCount: row.page_count as number,
      isEnabled: (row.is_enabled as number) === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private rowToSource(row: Record<string, unknown>): KbSource {
    return {
      id: row.id as string,
      kbId: row.kb_id as string,
      originalPath: row.original_path as string,
      storedName: row.stored_name as string,
      fileType: row.file_type as SourceFileType,
      fileSize: row.file_size as number,
      status: row.status as KbSource['status'],
      errorMessage: row.error_message as string,
      ingestedAt: row.ingested_at as string | null,
      compiledAt: row.compiled_at as string | null,
      metadataJson: row.metadata_json as string,
      createdAt: row.created_at as string,
    };
  }
}
