/**
 * Knowledge Base IPC Handlers
 */

import { wrapIpcHandle } from './ipc-logger';
import { getKnowledgeBaseService } from '../services/knowledge-base/knowledge-base.service';
import { getMainWindow, onMainWindowChange } from '../services/window.service';
import type { BrowserWindow } from 'electron';
import type {
  CreateKnowledgeBaseInput,
  AuditCorrection,
  IngestResult,
} from '../services/knowledge-base/types';
import {
  KB_LIST,
  KB_GET,
  KB_CREATE,
  KB_UPDATE,
  KB_DELETE,
  KB_IMPORT_FILES,
  KB_IMPORT_FOLDER,
  KB_REMOVE_SOURCE,
  KB_LIST_SOURCES,
  KB_SAVE_CONVERSATION,
  KB_LIST_CONVERSATIONS,
  KB_INGEST,
  KB_INGEST_ALL,
  KB_INGEST_INCREMENTAL,
  KB_INGEST_CANCEL,
  KB_RECOMPILE,
  KB_COMPILE,
  KB_QUERY,
  KB_SAVE_QUERY,
  KB_LINT,
  KB_GENERATE_REPORT,
  KB_LOAD_REPORT,
  KB_AUDIT,
  KB_LIST_PAGES,
  KB_READ_PAGE,
  KB_READ_SOURCE,
  KB_UPDATE_PAGE,
  KB_GET_PAGE_LINKS,
  KB_DELETE_PAGE,
  KB_OPEN_SOURCE_BROWSER,
  KB_OPEN_SOURCE_DEFAULT,
  KB_SELECT_FILE,
  KB_SELECT_FOLDER,
  KB_EVENT_INGEST_PROGRESS,
  KB_GET_GRAPH,
} from '../../shared/constants/knowledge-base';
import { dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function registerKnowledgeBaseHandlers(): void {
  // Track main window for sending events
  let mainWindow: BrowserWindow | null = null;
  onMainWindowChange((win) => { mainWindow = win; });

  // Per-kbId abort controllers for cancellation
  const activeControllers = new Map<string, AbortController>();

  function sendProgress(data: { current: number; total: number; fileName: string; sourceId?: string; completedSourceId?: string }): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(KB_EVENT_INGEST_PROGRESS, data);
    }
  }

  // === KB CRUD ===

  wrapIpcHandle(KB_LIST, async () => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.listKnowledgeBases();
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_GET, async (_event, id: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.getKnowledgeBase(id);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_CREATE, async (_event, input: CreateKnowledgeBaseInput) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.createKnowledgeBase(input);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_UPDATE, async (_event, id: string, updates: Partial<CreateKnowledgeBaseInput>) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.updateKnowledgeBase(id, updates);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_DELETE, async (_event, id: string) => {
    try {
      const svc = getKnowledgeBaseService();
      svc.deleteKnowledgeBase(id);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // === Source file management ===

  wrapIpcHandle(KB_IMPORT_FILES, async (_event, kbId: string, filePaths: string[]) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = await svc.importFiles(kbId, filePaths);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_IMPORT_FOLDER, async (_event, kbId: string, folderPath: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = await svc.importFolder(kbId, folderPath);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_REMOVE_SOURCE, async (_event, kbId: string, sourceId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      svc.removeSource(kbId, sourceId);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_LIST_SOURCES, async (_event, kbId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.listSources(kbId);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // === Conversation precipitation ===

  wrapIpcHandle(KB_SAVE_CONVERSATION, async (_event, kbId: string, spaceId: string, conversationId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = await svc.saveConversationToKb(kbId, spaceId, conversationId);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_LIST_CONVERSATIONS, async (_event, kbId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.listConversations(kbId);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // === Wiki operations ===

  wrapIpcHandle(KB_INGEST, async (_event, kbId: string, sourceId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = await svc.ingest(kbId, sourceId);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_INGEST_ALL, async (_event, kbId: string) => {
    const controller = new AbortController();
    activeControllers.set(kbId, controller);
    const signal = controller.signal;

    try {
      const svc = getKnowledgeBaseService();
      const sources = svc.listSources(kbId);

      if (sources.length === 0) {
        return { success: false, error: 'NO_NEW_FILES', data: null };
      }

      const toIngest = sources.filter((s) => s.status !== 'ingesting');

      const total: IngestResult = {
        pagesCreated: 0, pagesUpdated: 0, conceptsCount: 0, entitiesCount: 0,
        summaryCreated: false, errors: [], newPages: [],
      };

      for (let i = 0; i < toIngest.length; i++) {
        if (signal.aborted) break;
        const source = toIngest[i];
        sendProgress({ current: i + 1, total: toIngest.length, fileName: source.storedName, sourceId: source.id });
        try {
          const result = await svc.ingest(kbId, source.id, signal);
          total.pagesCreated += result.pagesCreated;
          total.pagesUpdated += result.pagesUpdated;
          total.conceptsCount += result.conceptsCount;
          total.entitiesCount += result.entitiesCount;
          if (result.summaryCreated) total.summaryCreated = true;
          sendProgress({ current: i + 1, total: toIngest.length, fileName: source.storedName, completedSourceId: source.id });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === '提取已取消') {
            total.errors.push(`${source.storedName}提取失败，用户取消提取`);
            break;
          }
          total.errors.push(`${source.storedName}: ${message}`);
        }
        if (global.gc) global.gc();
      }

      sendProgress({ current: 0, total: 0, fileName: '' });

      if (!signal.aborted) {
        try {
          await svc.compile(kbId);
        } catch {
          // Compile is an optimization step, failure should not block or report as ingest error
        }

        svc.crossLinkAllPages(kbId);
        svc.recountPages(kbId);
        svc.clearReportCache(kbId);
      }

      return { success: true, data: total };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    } finally {
      activeControllers.delete(kbId);
    }
  });

  wrapIpcHandle(KB_INGEST_INCREMENTAL, async (_event, kbId: string) => {
    const controller = new AbortController();
    activeControllers.set(kbId, controller);
    const signal = controller.signal;

    try {
      const svc = getKnowledgeBaseService();
      const sources = svc.listSources(kbId);
      const toIngest = sources.filter((s) => s.status === 'pending');

      if (toIngest.length === 0) {
        return { success: false, error: 'NO_NEW_FILES', data: null };
      }

      const total: IngestResult & { errors: string[] } = {
        pagesCreated: 0, pagesUpdated: 0, conceptsCount: 0, entitiesCount: 0,
        summaryCreated: false, errors: [], newPages: [],
      };

      for (let i = 0; i < toIngest.length; i++) {
        if (signal.aborted) break;
        const source = toIngest[i];
        sendProgress({ current: i + 1, total: toIngest.length, fileName: source.storedName, sourceId: source.id });
        try {
          const result = await svc.ingest(kbId, source.id, signal, true);
          total.pagesCreated += result.pagesCreated;
          total.pagesUpdated += result.pagesUpdated;
          total.conceptsCount += result.conceptsCount;
          total.entitiesCount += result.entitiesCount;
          if (result.summaryCreated) total.summaryCreated = true;
          total.newPages.push(...result.newPages);
          sendProgress({ current: i + 1, total: toIngest.length, fileName: source.storedName, completedSourceId: source.id });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === '提取已取消') {
            total.errors.push(`${source.storedName}提取失败，用户取消提取`);
            break;
          }
          total.errors.push(`${source.storedName}: ${message}`);
        }
        if (global.gc) global.gc();
      }

      sendProgress({ current: 0, total: 0, fileName: '' });

      if (!signal.aborted) {
        // Append new pages to existing index instead of rebuilding
        if (total.newPages.length > 0) {
          const { WikiEngine } = await import('../services/knowledge-base/wiki-engine');
          const kbPath = svc.getKbPath(kbId);
          const engine = new WikiEngine(kbPath, null as unknown as import('../services/knowledge-base/llm-caller').KbLlmCaller);
          engine.appendIndex(total.newPages as Array<{ title: string; kind: 'concept' | 'entity' | 'summary' | 'conversation'; desc: string }>);
          engine.crossLinkAllPages();
        }
        svc.recountPages(kbId);
        svc.clearReportCache(kbId);
      }

      return { success: true, data: total };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    } finally {
      activeControllers.delete(kbId);
    }
  });

  wrapIpcHandle(KB_INGEST_CANCEL, async (_event, kbId: string) => {
    const controller = activeControllers.get(kbId);
    if (controller) {
      controller.abort();
      activeControllers.delete(kbId);
    }
    const svc = getKnowledgeBaseService();
    svc.resetIngestingSources(kbId);
    return { success: true, data: null };
  });

  wrapIpcHandle(KB_RECOMPILE, async (_event, kbId: string) => {
    const controller = new AbortController();
    activeControllers.set(kbId, controller);
    const signal = controller.signal;

    try {
      const svc = getKnowledgeBaseService();
      console.log('[KB_RECOMPILE] Starting recompile, clearing generated content...');
      svc.clearGeneratedContent(kbId);
      console.log('[KB_RECOMPILE] Content cleared, resetting source statuses...');
      svc.resetSourceStatuses(kbId);
      const sources = svc.listSources(kbId);
      console.log(`[KB_RECOMPILE] Sources loaded: ${sources.length} files`);
      const total: IngestResult = {
        pagesCreated: 0, pagesUpdated: 0, conceptsCount: 0, entitiesCount: 0,
        summaryCreated: false, errors: [], newPages: [],
      };

      for (let i = 0; i < sources.length; i++) {
        if (signal.aborted) break;
        const source = sources[i];
        sendProgress({ current: i + 1, total: sources.length, fileName: source.storedName, sourceId: source.id });
        try {
          const result = await svc.ingest(kbId, source.id, signal);
          total.pagesCreated += result.pagesCreated;
          total.pagesUpdated += result.pagesUpdated;
          total.conceptsCount += result.conceptsCount;
          total.entitiesCount += result.entitiesCount;
          if (result.summaryCreated) total.summaryCreated = true;
          sendProgress({ current: i + 1, total: sources.length, fileName: source.storedName, completedSourceId: source.id });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === '提取已取消') {
            total.errors.push(`${source.storedName}提取失败，用户取消提取`);
            break;
          }
          total.errors.push(`${source.storedName}: ${message}`);
        }
        if (global.gc) global.gc();
      }

      sendProgress({ current: 0, total: 0, fileName: '' });

      if (!signal.aborted) {
        try {
          await svc.compile(kbId);
        } catch {
          // Compile is an optimization step, failure should not block or report as ingest error
        }

        svc.crossLinkAllPages(kbId);
        svc.recountPages(kbId);
        svc.clearReportCache(kbId);
      }

      return { success: true, data: total };
    } catch (error: unknown) {
      const err = error as Error;
      console.error(`[KB_RECOMPILE] Error: ${err.message}`, err.stack);
      return { success: false, error: err.message };
    } finally {
      activeControllers.delete(kbId);
    }
  });

  wrapIpcHandle(KB_COMPILE, async (_event, kbId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      svc.crossLinkAllPages(kbId);
      svc.recountPages(kbId);
      return { success: true, data: { indexRebuilt: true, crossLinksApplied: true } };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_QUERY, async (_event, kbId: string, question: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = await svc.query(kbId, question);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_SAVE_QUERY, async (_event, kbId: string, question: string, answer: string, citedPages: string[]) => {
    try {
      const svc = getKnowledgeBaseService();
      svc.saveQueryResult(kbId, question, answer, citedPages);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_LINT, async (_event, kbId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = await svc.lint(kbId);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_GENERATE_REPORT, async (_event, kbId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = await svc.generateReport(kbId);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_LOAD_REPORT, async (_event, kbId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = await svc.loadReport(kbId);
      return { success: true, data: data ?? null };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_AUDIT, async (_event, kbId: string, correction: AuditCorrection) => {
    try {
      const svc = getKnowledgeBaseService();
      await svc.audit(kbId, correction);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // === Wiki page browsing ===

  wrapIpcHandle(KB_LIST_PAGES, async (_event, kbId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.listWikiPages(kbId);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_READ_PAGE, async (_event, kbId: string, pagePath: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.readWikiPage(kbId, pagePath);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_READ_SOURCE, async (_event, kbId: string, sourceId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.readSourceFile(kbId, sourceId);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_UPDATE_PAGE, async (_event, kbId: string, pagePath: string, content: string) => {
    try {
      const svc = getKnowledgeBaseService();
      svc.updateWikiPage(kbId, pagePath, content);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_GET_PAGE_LINKS, async (_event, kbId: string, pagePath: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.getPageLinks(kbId, pagePath);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_DELETE_PAGE, async (_event, kbId: string, pagePath: string) => {
    try {
      const svc = getKnowledgeBaseService();
      svc.deleteWikiPage(kbId, pagePath);
      svc.clearReportCache(kbId);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_OPEN_SOURCE_BROWSER, async (_event, kbId: string, sourceId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.readSourceFile(kbId, sourceId);

      const escaped = data.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${data.fileName}</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.6;background:#1a1a2e;color:#e0e0e0;}
pre{white-space:pre-wrap;word-break:break-word;background:#16213e;padding:1.5rem;border-radius:8px;font-size:14px;}
h1{font-size:18px;color:#0f3460;border-bottom:1px solid #0f3460;padding-bottom:0.5rem;}</style>
</head><body><h1>${data.fileName}</h1><pre>${escaped}</pre></body></html>`;

      const tmpDir = path.join(os.tmpdir(), 'aico-bot-preview');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `${Date.now()}.html`);
      fs.writeFileSync(tmpFile, html, 'utf-8');
      await shell.openExternal(`file://${tmpFile}`);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_OPEN_SOURCE_DEFAULT, async (_event, kbId: string, sourceId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const filePath = svc.getSourceFilePath(kbId, sourceId);
      await shell.openPath(filePath);
      return { success: true };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // === Knowledge graph ===

  wrapIpcHandle(KB_GET_GRAPH, async (_event, kbId: string) => {
    try {
      const svc = getKnowledgeBaseService();
      const data = svc.getGraphData(kbId);
      return { success: true, data };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  // === File selection dialogs ===

  wrapIpcHandle(KB_SELECT_FILE, async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Supported Files', extensions: ['md', 'markdown', 'txt', 'pdf', 'docx', 'html', 'htm', 'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'h', 'css', 'json', 'yaml', 'yml', 'xml', 'sh', 'sql'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      return { success: true, data: result.canceled ? [] : result.filePaths };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });

  wrapIpcHandle(KB_SELECT_FOLDER, async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
      });
      return { success: true, data: result.canceled ? null : result.filePaths[0] };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, error: err.message };
    }
  });
}
