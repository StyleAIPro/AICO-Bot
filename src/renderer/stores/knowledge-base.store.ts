import { create } from 'zustand';
import * as kbApi from '@/api/knowledge-base';

interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  icon: string;
  sourceCount: number;
  pageCount: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface KbSource {
  id: string;
  kbId: string;
  originalPath: string;
  storedName: string;
  fileType: string;
  fileSize: number;
  status: string;
  errorMessage: string;
}

interface WikiPage {
  title: string;
  path: string;
  type: string;
}

interface PendingPageExpand {
  kbId: string;
  pageTitle: string;
}

interface KnowledgeBaseState {
  knowledgeBases: KnowledgeBase[];
  currentKb: KnowledgeBase | null;
  sources: KbSource[];
  wikiPages: WikiPage[];
  loadingAction: string | null;
  loading: boolean;
  error: string | null;
  activeKnowledgeBaseIds: string[];
  ingestProgress: { current: number; total: number; fileName: string } | null;
  ingestingKbId: string | null;
  wikiUpdatedCounter: number;
  pendingPageExpand: PendingPageExpand | null;
  toggleActiveKb: (kbId: string) => void;
  onConversationCreated: (conversationId: string) => void;
  onConversationSwitched: (conversationId: string) => void;

  loadKnowledgeBases: () => Promise<void>;
  createKnowledgeBase: (input: { name: string; description?: string }) => Promise<void>;
  deleteKnowledgeBase: (id: string) => Promise<void>;
  selectKb: (kb: KnowledgeBase | null) => void;

  loadSources: (kbId: string) => Promise<void>;
  importFiles: (kbId: string) => Promise<void>;
  importFolder: (kbId: string) => Promise<void>;
  removeSource: (kbId: string, sourceId: string) => Promise<void>;

  loadWikiPages: (kbId: string) => Promise<void>;
  ingestAll: (kbId: string) => Promise<void>;
  ingestIncremental: (kbId: string) => Promise<void>;
  cancelIngest: () => Promise<void>;
  recompile: (kbId: string) => Promise<void>;
  compile: (kbId: string) => Promise<void>;
  query: (kbId: string, question: string) => Promise<{ answer: string; citedPages: string[] }>;
  lint: (kbId: string) => Promise<unknown>;
  generateReport: (kbId: string) => Promise<string | null>;
  loadReport: (kbId: string) => Promise<string | null>;
  setPendingPageExpand: (expand: PendingPageExpand | null) => void;
  clearPendingPageExpand: () => void;
  clearError: () => void;
}

export const useKnowledgeBaseStore = create<KnowledgeBaseState>()((set, get) => ({
  knowledgeBases: [],
  currentKb: null,
  sources: [],
  wikiPages: [],
  loadingAction: null,
  loading: false,
  error: null,
  activeKnowledgeBaseIds: [],
  ingestProgress: null,
  ingestingKbId: null,
  wikiUpdatedCounter: 0,
  pendingPageExpand: null,

  // Per-conversation KB selection: Map<conversationId, kbId[]>
  _conversationKbMap: new Map<string, string[]>(),
  _currentConversationId: null as string | null,

  loadKnowledgeBases: async () => {
    set({ loading: true, error: null });
    try {
      const res = await kbApi.kbList();
      if (res.success) {
        const kbs = res.data as KnowledgeBase[];
        const state = get();
        const activeIds = state.activeKnowledgeBaseIds;
        const hasConversation = !!state._currentConversationId;

        if (hasConversation && kbs.length > 0) {
          // A conversation is active — restore its per-conversation KB selection
          const convId = state._currentConversationId!;
          const saved = state._conversationKbMap.get(convId);
          let resolvedIds: string[];
          if (saved) {
            resolvedIds = saved.filter((id) => kbs.some((kb) => kb.id === id && kb.isEnabled));
          } else {
            resolvedIds = kbs.filter((kb) => kb.isEnabled).map((kb) => kb.id);
          }
          set({ knowledgeBases: kbs, activeKnowledgeBaseIds: resolvedIds, loadingAction: null, loading: false });
        } else if (activeIds.length === 0 && kbs.length > 0) {
          // No conversation active, no KBs selected — auto-select all
          set({ knowledgeBases: kbs, activeKnowledgeBaseIds: kbs.map((kb) => kb.id), loadingAction: null, loading: false });
        } else {
          set({ knowledgeBases: kbs, loadingAction: null, loading: false });
        }
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  createKnowledgeBase: async (input: { name: string; description?: string }) => {
    set({ loadingAction: 'create', loading: true, error: null });
    try {
      const res = await kbApi.kbCreate(input);
      if (res.success) {
        await get().loadKnowledgeBases();
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  deleteKnowledgeBase: async (id: string) => {
    set({ loadingAction: 'delete', loading: true, error: null });
    try {
      const res = await kbApi.kbDelete(id);
      if (res.success) {
        const { currentKb } = get();
        if (currentKb?.id === id) {
          set({ currentKb: null, sources: [], wikiPages: [] });
        }
        await get().loadKnowledgeBases();
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  selectKb: (kb: KnowledgeBase | null) => {
    set({ currentKb: kb, sources: [], wikiPages: [], error: null });
  },

  loadSources: async (kbId: string) => {
    set({ loading: true, loadingAction: null, error: null });
    try {
      const res = await kbApi.kbListSources(kbId);
      if (res.success) {
        set({ sources: (res.data as KbSource[]) ?? [], loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  importFiles: async (kbId: string) => {
    const fileRes = await kbApi.kbSelectFile();
    if (!fileRes.success || !fileRes.data || (fileRes.data as string[]).length === 0) return;
    const filePaths = fileRes.data as string[];
    set({ loadingAction: 'import', loading: true, error: null });
    try {
      const res = await kbApi.kbImportFiles(kbId, filePaths);
      if (res.success) {
        const data = res.data as { imported: number; failed: number; errors: Array<{ file: string; error: string }> };
        if (data.imported > 0) {
          await get().loadSources(kbId);
        }
        if (data.failed > 0 && data.errors.length > 0) {
          set({ loadingAction: null, loading: false, error: data.errors.map((e) => `${e.file}: ${e.error}`).join('\n') });
        } else {
          set({ loadingAction: null, loading: false });
        }
      } else {
        set({ loadingAction: null, loading: false, error: res.error ?? 'Unknown error' });
      }
    } catch (err: unknown) {
      set({ loadingAction: null, loading: false, error: (err as Error).message });
    }
  },

  importFolder: async (kbId: string) => {
    const folderRes = await kbApi.kbSelectFolder();
    if (!folderRes.success || !folderRes.data) return;
    const folderPath = folderRes.data as string;
    set({ loadingAction: 'importFolder', loading: true, error: null });
    try {
      const res = await kbApi.kbImportFolder(kbId, folderPath);
      if (res.success) {
        await get().loadSources(kbId);
        set({ loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  removeSource: async (kbId: string, sourceId: string) => {
    set({ loadingAction: 'removeSource', loading: true, error: null });
    try {
      const res = await kbApi.kbRemoveSource(kbId, sourceId);
      if (res.success) {
        await get().loadSources(kbId);
        set({ loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  loadWikiPages: async (kbId: string, skipLoadingActionClear = false) => {
    set({ loading: true, ...(skipLoadingActionClear ? {} : { loadingAction: null }), error: null });
    try {
      const res = await kbApi.kbListPages(kbId);
      if (res.success) {
        set({ wikiPages: (res.data as WikiPage[]) ?? [], ...(skipLoadingActionClear ? {} : { loadingAction: null }), loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', ...(skipLoadingClear ? {} : { loadingAction: null }), loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, ...(skipLoadingClear ? {} : { loadingAction: null }), loading: false });
    }
  },

  ingestAll: async (kbId: string) => {
    set({ loadingAction: 'fullIngest', loading: true, error: null, ingestProgress: null, ingestingKbId: kbId });
    try {
      const res = await kbApi.kbIngestAll(kbId);
      if (res.success) {
        const data = (res.data ?? {}) as Record<string, unknown>;
        const errors = (data.errors as string[] | undefined) ?? [];
        const pagesCreated = (data.pagesCreated as number) ?? 0;
        await Promise.all([get().loadWikiPages(kbId), get().loadSources(kbId)]);
        if (errors.length > 0 && pagesCreated === 0) {
          set({ error: errors.join('\n'), loadingAction: null, loading: false, ingestingKbId: null });
        } else if (errors.length > 0) {
          set({ error: `部分文件摄取失败: ${errors.join('\n')}`, loadingAction: null, loading: false, ingestingKbId: null });
        } else {
          set({ loadingAction: null, loading: false, ingestingKbId: null });
        }
      } else {
        if (res.error === 'NO_NEW_FILES') {
          set({ error: 'NO_NEW_FILES', loadingAction: null, loading: false, ingestingKbId: null });
        } else {
          set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false, ingestingKbId: null });
        }
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false, ingestingKbId: null });
    }
  },

  ingestIncremental: async (kbId: string) => {
    set({ loadingAction: 'ingest', loading: true, error: null, ingestProgress: null, ingestingKbId: kbId });
    try {
      const res = await kbApi.kbIngestIncremental(kbId);
      if (res.success) {
        const data = (res.data ?? {}) as Record<string, unknown>;
        const errors = (data.errors as string[] | undefined) ?? [];
        const pagesCreated = (data.pagesCreated as number) ?? 0;
        await Promise.all([get().loadWikiPages(kbId), get().loadSources(kbId)]);
        if (errors.length > 0 && pagesCreated === 0) {
          set({ error: errors.join('\n'), loadingAction: null, loading: false, ingestingKbId: null });
        } else if (errors.length > 0) {
          set({ error: `部分文件摄取失败: ${errors.join('\n')}`, loadingAction: null, loading: false, ingestingKbId: null });
        } else {
          set({ loadingAction: null, loading: false, ingestingKbId: null });
        }
      } else {
        if (res.error === 'NO_NEW_FILES') {
          set({ error: 'NO_NEW_FILES', loadingAction: null, loading: false, ingestingKbId: null });
        } else {
          set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false, ingestingKbId: null });
        }
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false, ingestingKbId: null });
    }
  },

  cancelIngest: async () => {
    const kbId = get().ingestingKbId;
    if (kbId) await kbApi.kbCancelIngest(kbId);
    set({ loadingAction: null, loading: false, ingestProgress: null, ingestingKbId: null });
    if (kbId) await get().loadSources(kbId);
  },

  recompile: async (kbId: string) => {
    set((state) => ({
      loadingAction: 'recompile' as const,
      loading: true,
      error: null,
      ingestProgress: null,
      ingestingKbId: kbId,
      wikiPages: [],
      sources: state.sources.map((s) => ({ ...s, status: 'pending' as const })),
    }));
    try {
      const res = await kbApi.kbRecompile(kbId);
      if (res.success) {
        const data = (res.data ?? {}) as Record<string, unknown>;
        const errors = (data.errors as string[] | undefined) ?? [];
        await Promise.all([get().loadWikiPages(kbId), get().loadSources(kbId)]);
        if (errors.length > 0) {
          set({ error: `部分文件摄取失败: ${errors.join('\n')}`, loadingAction: null, loading: false, ingestingKbId: null });
        } else {
          set({ loadingAction: null, loading: false, ingestingKbId: null });
        }
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false, ingestingKbId: null });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false, ingestingKbId: null });
    }
  },

  compile: async (kbId: string) => {
    set({ loadingAction: 'compile', loading: true, error: null });
    try {
      const res = await kbApi.kbCompile(kbId);
      if (res.success) {
        await Promise.all([get().loadWikiPages(kbId), get().loadSources(kbId)]);
        set({ loadingAction: null, loading: false });
      } else {
        set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      }
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
    }
  },

  query: async (kbId: string, question: string) => {
    set({ loadingAction: 'query', loading: true, error: null });
    try {
      const res = await kbApi.kbQuery(kbId, question);
      if (res.success) {
        set({ loadingAction: null, loading: false });
        return res.data as { answer: string; citedPages: string[] };
      }
      set({ error: res.error, loadingAction: null, loading: false });
      return { answer: '', citedPages: [] };
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
      return { answer: '', citedPages: [] };
    }
  },

  lint: async (kbId: string) => {
    set({ loadingAction: 'lint', loading: true, error: null });
    try {
      const res = await kbApi.kbLint(kbId);
      if (res.success) {
        set({ loadingAction: null, loading: false });
        return res.data;
      }
      set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      return undefined;
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
      return undefined;
    }
  },

  generateReport: async (kbId: string) => {
    set({ loadingAction: 'report', loading: true, error: null });
    try {
      const res = await kbApi.kbGenerateReport(kbId);
      if (res.success) {
        set({ loadingAction: null, loading: false });
        return res.data as string;
      }
      set({ error: res.error ?? 'Unknown error', loadingAction: null, loading: false });
      return null;
    } catch (err: unknown) {
      set({ error: (err as Error).message, loadingAction: null, loading: false });
      return null;
    }
  },

  loadReport: async (kbId: string) => {
    try {
      const res = await kbApi.kbLoadReport(kbId);
      if (res.success) {
        return res.data as string | null;
      }
      return null;
    } catch {
      return null;
    }
  },

  toggleActiveKb: (kbId: string) => {
    set((state) => {
      const ids = state.activeKnowledgeBaseIds;
      const newIds = ids.includes(kbId)
        ? ids.filter((id) => id !== kbId)
        : [...ids, kbId];
      // Persist to current conversation's selection in the map
      const newMap = new Map(state._conversationKbMap);
      if (state._currentConversationId) {
        newMap.set(state._currentConversationId, newIds);
      }
      return { activeKnowledgeBaseIds: newIds, _conversationKbMap: newMap };
    });
  },

  onConversationCreated: (conversationId: string) => {
    const { knowledgeBases, _conversationKbMap } = get();
    const enabledIds = knowledgeBases.filter((kb) => kb.isEnabled).map((kb) => kb.id);
    const newMap = new Map(_conversationKbMap);
    newMap.set(conversationId, enabledIds);
    set({ activeKnowledgeBaseIds: enabledIds, _conversationKbMap: newMap, _currentConversationId: conversationId });
  },

  onConversationSwitched: (conversationId: string) => {
    const { knowledgeBases, _conversationKbMap } = get();
    // If KBs haven't loaded yet, just set the conversation pointer.
    // loadKnowledgeBases will not auto-select (hasConversation check),
    // and we rely on the map being populated correctly once KBs load.
    // The selectConversation flow also calls loadKnowledgeBases if needed.
    const newMap = new Map(_conversationKbMap);
    if (knowledgeBases.length > 0) {
      const saved = _conversationKbMap.get(conversationId);
      let activeIds: string[];
      if (saved) {
        activeIds = saved.filter((id) => knowledgeBases.some((kb) => kb.id === id && kb.isEnabled));
      } else {
        activeIds = knowledgeBases.filter((kb) => kb.isEnabled).map((kb) => kb.id);
      }
      newMap.set(conversationId, activeIds);
      set({ activeKnowledgeBaseIds: activeIds, _conversationKbMap: newMap, _currentConversationId: conversationId });
    } else {
      // KBs not loaded yet — set pointer, will resolve after load
      set({ _currentConversationId: conversationId, _conversationKbMap: newMap });
    }
  },

  setPendingPageExpand: (expand) => set({ pendingPageExpand: expand }),
  clearPendingPageExpand: () => set({ pendingPageExpand: null }),

  clearError: () => {
    set({ error: null });
  },
}));

// Subscribe to ingest progress events from main process
if (typeof window !== 'undefined' && window.aicoBot) {
  window.aicoBot.onKbIngestProgress((data) => {
    const state = useKnowledgeBaseStore.getState();
    const updates: Partial<KnowledgeBaseState> = {
      ingestProgress: data.total > 0 ? { current: data.current, total: data.total, fileName: data.fileName } : null,
    };
    // Ingest finished — clear any stale 'ingesting' statuses
    if (data.total === 0) {
      const hasIngesting = state.sources.some((s) => s.status === 'ingesting');
      if (hasIngesting && state.currentKb) {
        state.loadSources(state.currentKb.id);
      }
    }
    if (data.sourceId && data.total > 0 && !data.completedSourceId) {
      updates.sources = state.sources.map((s) =>
        s.id === data.sourceId ? { ...s, status: 'ingesting' } : s,
      );
    }
    if (data.completedSourceId) {
      updates.sources = state.sources.map((s) =>
        s.id === data.completedSourceId ? { ...s, status: 'compiled' } : s,
      );
      updates.wikiUpdatedCounter = state.wikiUpdatedCounter + 1;
      if (state.currentKb) {
        state.loadWikiPages(state.currentKb.id, true);
      }
    }
    useKnowledgeBaseStore.setState(updates);
  });
}
