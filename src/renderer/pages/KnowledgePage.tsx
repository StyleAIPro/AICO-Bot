import React, { useCallback, forwardRef, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  Library,
  Plus,
  Upload,
  FileText,
  Search,
  Trash2,
  RefreshCw,
  GitMerge,
  AlertTriangle,
  Loader2,
  ArrowLeft,
  Pencil,
  Save,
  X,
  ArrowUpLeft,
  ArrowDownLeft,
  CheckSquare,
  Square,
} from 'lucide-react';
import { useKnowledgeBaseStore } from '@/stores/knowledge-base.store';
import { KnowledgeGraph } from '@/components/knowledge-base/KnowledgeGraph';
import { useAppStore } from '@/stores/app.store';
import { useSpaceStore } from '@/stores/space.store';
import { Header } from '@/components/layout/Header';

function ReportContent({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="text-lg font-bold mb-4 pb-2 border-b border-border">{line.slice(2)}</h1>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="text-sm font-semibold mt-6 mb-3 text-primary">{line.slice(3)}</h2>);
    } else if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="text-sm font-medium mt-4 mb-2">{line.slice(4)}</h3>);
    } else if (line.startsWith('- ')) {
      elements.push(
        <div key={i} className="flex gap-2 text-sm leading-relaxed ml-1 mb-1">
          <span className="text-muted-foreground mt-0.5 select-none">•</span>
          <span dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(line.slice(2)) }} />
        </div>,
      );
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(
        <p key={i} className="text-sm leading-relaxed mb-1" dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(line) }} />,
      );
    }
  }

  return <div className="p-6">{elements}</div>;
}

function formatInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="text-xs bg-muted px-1 py-0.5 rounded">$1</code>');
}

/** Slugify a page title to match wiki page file paths. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s/()]+/g, '-')
    .replace(/[()[\]{}]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Find a wiki page matching the given title using multiple strategies. */
function findMatchingPage(
  pages: Array<{ title: string; path: string }>,
  pageTitle: string,
): { title: string; path: string } | undefined {
  // 1. Exact title match
  const exact = pages.find((pg) => pg.title === pageTitle);
  if (exact) return exact;

  // 2. Case-insensitive title match
  const ci = pages.find((pg) => pg.title.toLowerCase() === pageTitle.toLowerCase());
  if (ci) return ci;

  // 3. Path ends with slugified title
  const slug = slugify(pageTitle);
  const bySlug = pages.find((pg) => pg.path.toLowerCase().replace(/\.md$/, '').endsWith(slug));
  if (bySlug) return bySlug;

  // 4. Path contains key words from the title (last resort)
  const words = pageTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (words.length > 0) {
    const byWords = pages.find((pg) =>
      words.every((w) => pg.title.toLowerCase().includes(w) || pg.path.toLowerCase().includes(w.toLowerCase())),
    );
    if (byWords) return byWords;
  }

  return undefined;
}

interface KbCreateFormProps {
  loading: boolean;
  onCreate: (name: string, description: string) => void;
  onCancel: () => void;
}

const KbCreateForm = React.memo(forwardRef<HTMLInputElement, KbCreateFormProps>(function KbCreateForm(props, ref) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');

  useEffect(() => {
    setName('');
    setDesc('');
  }, []);

  const canSubmit = name.trim().length > 0 && !props.loading;

  return (
    <div className="px-6 py-4 border-b border-border bg-muted/30 flex-shrink-0">
      <div className="flex items-center gap-3">
        <input
          ref={ref}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('kb.namePlaceholder')}
          className="flex-1 px-3 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
          onKeyDown={(e) => e.key === 'Enter' && canSubmit && props.onCreate(name, desc)}
        />
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t('kb.descPlaceholder')}
          className="flex-1 px-3 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
          onKeyDown={(e) => e.key === 'Enter' && canSubmit && props.onCreate(name, desc)}
        />
        <button
          onClick={() => canSubmit && props.onCreate(name, desc)}
          disabled={!canSubmit}
          className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {t('kb.create')}
        </button>
        <button
          onClick={props.onCancel}
          className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('kb.cancel')}
        </button>
      </div>
    </div>
  );
}));

export function KnowledgePage() {
  const { t } = useTranslation();
  const currentSpace = useSpaceStore((state) => state.currentSpace);
  const { goBack } = useAppStore();
  const {
    knowledgeBases,
    currentKb,
    sources,
    wikiPages,
    loading,
    loadingAction,
    error,
    ingestProgress,
    ingestingKbId,
    loadKnowledgeBases,
    createKnowledgeBase,
    deleteKnowledgeBase,
    selectKb,
    loadSources,
    importFiles,
    importFolder,
    removeSource,
    loadWikiPages,
    ingestAll,
    ingestIncremental,
    cancelIngest,
    recompile,
    lint,
    generateReport,
    loadReport,
    query,
    clearError,
    wikiUpdatedCounter,
  } = useKnowledgeBaseStore();

  const [queryInput, setQueryInput] = useState('');
  const [lintResult, setLintResult] = useState<{ issues: Array<{ type: string; severity: string; file: string; detail: string; relatedFile?: string }>; totalPages: number; healthScore: number } | null>(null);
  const [queryAnswer, setQueryAnswer] = useState('');
  const [queryCited, setQueryCited] = useState<string[]>([]);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const hideCreateForm = useCallback(() => setShowCreateForm(false), []);

  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [pageContent, setPageContent] = useState('');
  const [activeTab, setActiveTab] = useState<'sources' | 'pages' | 'query' | 'index' | 'graph' | 'lint' | 'report'>('sources');
  const [editingPagePath, setEditingPagePath] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [pageLinks, setPageLinks] = useState<{ outgoing: string[]; incoming: string[] }>({ outgoing: [], incoming: [] });
  const [indexContent, setIndexContent] = useState('');
  const [editingDescKbId, setEditingDescKbId] = useState<string | null>(null);
  const [editDescValue, setEditDescValue] = useState('');
  const editDescRef = useRef<HTMLTextAreaElement>(null);

  const startEditDesc = useCallback((kbId: string, desc: string) => {
    setEditingDescKbId(kbId);
    setEditDescValue(desc || '');
  }, []);

  const saveEditDesc = useCallback(async (kbId: string, value: string) => {
    const trimmed = value.trim();
    try {
      const kbApi = await import('@/api/knowledge-base');
      await kbApi.kbUpdate(kbId, { description: trimmed });
    } catch { /* ignore */ }
    const { currentKb, knowledgeBases } = useKnowledgeBaseStore.getState();
    if (currentKb?.id === kbId) {
      useKnowledgeBaseStore.setState({ currentKb: { ...currentKb, description: trimmed || undefined } });
    }
    const idx = knowledgeBases.findIndex((kb) => kb.id === kbId);
    if (idx !== -1) {
      const updated = [...knowledgeBases];
      updated[idx] = { ...updated[idx], description: trimmed || undefined };
      useKnowledgeBaseStore.setState({ knowledgeBases: updated });
    }
    setEditingDescKbId(null);
    setEditDescValue('');
  }, []);

  useEffect(() => {
    if (editingDescKbId) {
      editDescRef.current?.focus();
    }
  }, [editingDescKbId]);
  const [graphData, setGraphData] = useState<{ nodes: Array<{ id: string; title: string; type: string; tags: string[] }>; links: Array<{ source: string; target: string }> } | null>(null);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState<'sources' | 'pages' | null>(null);
  const createNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadKnowledgeBases();
  }, [loadKnowledgeBases]);

  useEffect(() => {
    if (showCreateForm) {
      createNameRef.current?.focus();
    }
  }, [showCreateForm]);

  const resetWikiView = useCallback(() => {
    setGraphData(null);
    setLintResult(null);
    setReportContent(null);
    setQueryAnswer('');
    setQueryCited([]);
    setQueryInput('');
    setExpandedPage(null);
    setPageContent('');
    setPageLinks({ outgoing: [], incoming: [] });
    setEditingPagePath(null);
  }, []);

  useEffect(() => {
    if (currentKb) {
      // If navigating from a citation click, don't reset to sources tab
      const pending = useKnowledgeBaseStore.getState().pendingPageExpand;
      if (!pending) {
        setActiveTab('sources');
      }
      resetWikiView();
      loadSources(currentKb.id);
      loadWikiPages(currentKb.id).then(() => {
        const p = useKnowledgeBaseStore.getState().pendingPageExpand;
        if (p && p.kbId === currentKb.id) {
          const pages = useKnowledgeBaseStore.getState().wikiPages;
          const match = findMatchingPage(pages, p.pageTitle);
          if (match) {
            setActiveTab('pages');
            setExpandedPage(match.path);
            setEditingPagePath(null);
            setPageContent(t('kb.loading'));
            setPageLinks({ outgoing: [], incoming: [] });
            import('@/api/knowledge-base').then((kbApi) => {
              Promise.all([
                kbApi.kbReadPage(p.kbId, match.path),
                kbApi.kbGetPageLinks(p.kbId, match.path),
              ]).then(([pageRes, linksRes]) => {
                if (pageRes.success) setPageContent(pageRes.data as string);
                if (linksRes.success) setPageLinks(linksRes.data as { outgoing: string[]; incoming: string[] });
              });
            });
            useKnowledgeBaseStore.getState().clearPendingPageExpand();
          }
        }
      });
      (async () => {
        const cached = await loadReport(currentKb.id);
        setReportContent(cached);
      })();
    }
  }, [currentKb, loadSources, loadWikiPages, t]);

  useEffect(() => {
    if (wikiUpdatedCounter > 0) {
      setReportContent(null);
    }
  }, [wikiUpdatedCounter]);

  useEffect(() => {
    if (activeTab === 'report' && !reportContent && !ingestingKbId && currentKb && loadingAction !== 'report' && wikiPages.length > 0) {
      (async () => {
        const cached = await loadReport(currentKb.id);
        if (cached) {
          setReportContent(cached);
          return;
        }
        const result = await generateReport(currentKb.id);
        if (result) setReportContent(result);
      })();
    }
  }, [activeTab, reportContent, ingestingKbId, currentKb, loadingAction, loadReport, generateReport]);

  useEffect(() => {
    if (wikiUpdatedCounter > 0 && currentKb && activeTab === 'graph') {
      import('@/api/knowledge-base').then((kbApi) => {
        kbApi.kbGetGraph(currentKb.id).then((res) => {
          if (res.success) setGraphData(res.data as typeof graphData);
        });
      });
    }
  }, [wikiUpdatedCounter, currentKb, activeTab]);

  const handleCreateWithName = useCallback(async (name: string, description: string) => {
    if (!name.trim()) return;
    await createKnowledgeBase({ name: name.trim(), description: description.trim() || undefined });
    if (!useKnowledgeBaseStore.getState().error) {
      setShowCreateForm(false);
    }
  }, [createKnowledgeBase]);

  const handleDelete = async (id: string, name: string) => {
    const confirmed = window.confirm(t('kb.deleteConfirm', { name }));
    if (!confirmed) return;
    await deleteKnowledgeBase(id);
  };

  const handleQuery = async () => {
    if (!currentKb || !queryInput.trim()) return;
    setQueryAnswer('');
    setQueryCited([]);
    const result = await query(currentKb.id, queryInput.trim());
    setQueryAnswer(result.answer);
    setQueryCited(result.citedPages);
  };

  const handleBatchDeleteSources = async () => {
    if (!currentKb || selectedSources.size === 0) return;
    if (!window.confirm(t('kb.batchDeleteConfirm', { count: selectedSources.size }))) return;
    const kbId = currentKb.id;
    const ids = Array.from(selectedSources);
    const kbApi = await import('@/api/knowledge-base');
    for (const id of ids) {
      await kbApi.kbRemoveSource(kbId, id);
    }
    setSelectedSources(new Set());
    setBatchMode(null);
    loadSources(kbId);
    loadWikiPages(kbId);
  };

  const handleBatchDeletePages = async () => {
    if (!currentKb || selectedPages.size === 0) return;
    if (!window.confirm(t('kb.batchDeleteConfirm', { count: selectedPages.size }))) return;
    const kbId = currentKb.id;
    const paths = Array.from(selectedPages);
    const kbApi = await import('@/api/knowledge-base');
    for (const pagePath of paths) {
      await kbApi.kbDeletePage(kbId, pagePath);
    }
    setSelectedPages(new Set());
    setBatchMode(null);
    if (expandedPage && selectedPages.has(expandedPage)) {
      setExpandedPage(null);
      setPageContent('');
      setPageLinks({ outgoing: [], incoming: [] });
    }
    setGraphData(null);
    setReportContent(null);
    loadWikiPages(kbId);
  };

  const exitBatchMode = () => {
    setSelectedSources(new Set());
    setSelectedPages(new Set());
    setBatchMode(null);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header - same as SkillPage */}
      <Header
        spaceId={currentSpace?.id}
        left={
          <button
            onClick={() => goBack()}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            title={t('Back')}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        }
      />

      {/* Tab Bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <Library className="w-5 h-5 text-emerald-500" />
          <h1 className="text-lg font-semibold">{t('kb.title')}</h1>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('kb.create')}
        </button>
      </div>

      {showCreateForm && (
        <KbCreateForm
          key="kb-create-form"
          ref={createNameRef}
          loading={loading}
          onCreate={handleCreateWithName}
          onCancel={hideCreateForm}
        />
      )}

      {error && (
        <div className={`mx-6 mt-3 px-4 py-2 rounded-lg flex items-start justify-between gap-2 text-sm flex-shrink-0 max-h-32 overflow-y-auto ${
          error === 'NO_NEW_FILES' ? 'bg-muted/50 text-muted-foreground' : 'bg-destructive/10 text-destructive'
        }`}>
          <div className="flex items-start gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span className="whitespace-pre-line break-all">{error === 'NO_NEW_FILES' ? t('kb.noNewFiles') : error}</span>
          </div>
          <button onClick={clearError} className="flex-shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {ingestingKbId && (
        <div className="mx-6 mt-3 px-4 py-3 rounded-lg border border-border bg-muted/30 flex-shrink-0">
          {ingestProgress ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin text-primary" />
                  <span>{t('kb.ingesting', { current: ingestProgress.current, total: ingestProgress.total, fileName: ingestProgress.fileName })}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{ingestProgress.current}/{ingestProgress.total}</span>
                </div>
              </div>
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${(ingestProgress.current / ingestProgress.total) * 100}%` }}
                />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span>{t('kb.preparing')}</span>
            </div>
          )}
          <div className="mt-2 flex justify-end">
            <button
              onClick={() => cancelIngest()}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors px-2 py-0.5 rounded hover:bg-destructive/10"
            >
              {t('kb.cancelIngest')}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="w-72 flex-shrink-0 border-r border-border overflow-y-auto">
          <div className="p-3 space-y-1">
            {knowledgeBases.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-8">{t('kb.empty')}</div>
            ) : (
              knowledgeBases.map((kb) => (
                <button
                  key={kb.id}
                  onClick={() => editingDescKbId === kb.id ? undefined : selectKb(kb)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                    currentKb?.id === kb.id
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-secondary text-foreground'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium truncate">{kb.name}</span>
                    <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  </div>
                  {editingDescKbId === kb.id ? (
                    <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        ref={editDescRef}
                        value={editDescValue}
                        onChange={(e) => setEditDescValue(e.target.value)}
                        onBlur={() => saveEditDesc(kb.id, editDescValue)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') { e.preventDefault(); setEditingDescKbId(null); setEditDescValue(''); }
                        }}
                        rows={2}
                        className="w-full px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                  ) : (
                    <p
                      className="mt-1 text-xs text-muted-foreground line-clamp-2 cursor-text"
                      onDoubleClick={(e) => { e.stopPropagation(); startEditDesc(kb.id, kb.description || ''); }}
                    >
                      {kb.description || <span className="italic opacity-50">{t('kb.doubleClickEdit')}</span>}
                    </p>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!currentKb ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <BookOpen className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm">{t('kb.noKbSelected')}</p>
            </div>
          ) : (
            <div className="p-6 space-y-6">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-semibold">{currentKb.name}</h2>
                  {currentKb.description && (
                    <p className="text-sm text-muted-foreground mt-1">{currentKb.description}</p>
                  )}
                </div>
                <button
                  onClick={() => handleDelete(currentKb.id, currentKb.name)}
                  disabled={loading}
                  className="p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                  title={t('kb.delete')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => importFiles(currentKb.id)}
                  disabled={loadingAction === 'import'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  {loadingAction === 'import' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  {t('kb.importFiles')}
                </button>
                <button
                  onClick={() => ingestAll(currentKb.id)}
                  disabled={loadingAction === 'fullIngest' || loadingAction === 'ingest'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  {loadingAction === 'fullIngest' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  {t('kb.fullIngest')}
                </button>
                <button
                  onClick={() => ingestIncremental(currentKb.id)}
                  disabled={loadingAction === 'ingest' || loadingAction === 'fullIngest'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  {loadingAction === 'ingest' ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
                  {t('kb.incrementalIngest')}
                </button>
                <button
                  onClick={() => {
                    if (!window.confirm(t('kb.recompileConfirm'))) return;
                    resetWikiView();
                    recompile(currentKb.id);
                  }}
                  disabled={loadingAction === 'recompile'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors disabled:opacity-50"
                >
                  {loadingAction === 'recompile' ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />}
                  {t('kb.recompile')}
                </button>
                <button
                  onClick={async () => {
                    if (!currentKb) return;
                    setLintResult(null);
                    setActiveTab('lint');
                    const data = await lint(currentKb.id);
                    setLintResult(data as typeof lintResult);
                  }}
                  disabled={loadingAction === 'lint'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  {loadingAction === 'lint' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  {t('kb.lint')}
                </button>
              </div>

              <div className="flex items-center justify-between border-b border-border">
                <div className="flex gap-1">
                  <button
                    onClick={() => setActiveTab('sources')}
                    className={`px-3 py-2 text-sm transition-colors ${
                      activeTab === 'sources'
                        ? 'border-b-2 border-primary text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('kb.sources')} ({sources.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('pages')}
                    className={`px-3 py-2 text-sm transition-colors ${
                      activeTab === 'pages'
                        ? 'border-b-2 border-primary text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('kb.wikiPages')} ({wikiPages.length})
                  </button>
                  <button
                    onClick={() => {
                      setActiveTab('index');
                      setIndexContent(t('kb.loading'));
                      const kbId = currentKb!.id;
                      (async () => {
                        try {
                          const kbApi = await import('@/api/knowledge-base');
                          const res = await kbApi.kbReadPage(kbId, 'index.md');
                          if (res.success) setIndexContent(res.data as string);
                          else setIndexContent('');
                        } catch {
                          setIndexContent('');
                        }
                      })();
                    }}
                    className={`px-3 py-2 text-sm transition-colors ${
                      activeTab === 'index'
                        ? 'border-b-2 border-primary text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('kb.viewIndex')}
                  </button>
                  <button
                    onClick={() => {
                      setActiveTab('graph');
                      if (!graphData) {
                        const kbId = currentKb!.id;
                        (async () => {
                          try {
                            const kbApi = await import('@/api/knowledge-base');
                            const res = await kbApi.kbGetGraph(kbId);
                            if (res.success) setGraphData(res.data as typeof graphData);
                          } catch { /* ignore */ }
                        })();
                      }
                    }}
                    className={`px-3 py-2 text-sm transition-colors ${
                      activeTab === 'graph'
                        ? 'border-b-2 border-primary text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('kb.knowledgeGraph')}
                  </button>
                  <button
                    onClick={() => setActiveTab('report')}
                    className={`px-3 py-2 text-sm transition-colors ${
                      activeTab === 'report'
                        ? 'border-b-2 border-primary text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {loadingAction === 'report' ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : <FileText className="w-3.5 h-3.5 inline" />}
                    <span className="ml-1">{t('kb.report')}</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('query')}
                    className={`px-3 py-2 text-sm transition-colors ${
                      activeTab === 'query'
                        ? 'border-b-2 border-primary text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('kb.query')}
                  </button>
                  <button
                    onClick={() => setActiveTab('lint')}
                    className={`px-3 py-2 text-sm transition-colors ${
                      activeTab === 'lint'
                        ? 'border-b-2 border-primary text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('kb.lint')}
                  </button>
                </div>
                {(activeTab === 'sources' && sources.length > 0 || activeTab === 'pages' && wikiPages.length > 0) && (
                  batchMode === activeTab ? (
                    <div className="flex items-center gap-2 pr-2">
                      <button
                        onClick={() => {
                          const items = activeTab === 'sources' ? sources : wikiPages;
                          const key = activeTab === 'sources' ? 'id' : 'path';
                          const setter = activeTab === 'sources' ? setSelectedSources : setSelectedPages;
                          const current = activeTab === 'sources' ? selectedSources : selectedPages;
                          if (current.size === items.length) {
                            setter(new Set());
                          } else {
                            setter(new Set(items.map((i: any) => i[key])));
                          }
                        }}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {activeTab === 'sources'
                          ? (selectedSources.size === sources.length && sources.length > 0)
                          : (selectedPages.size === wikiPages.length && wikiPages.length > 0)
                        }
                        <CheckSquare className="w-3.5 h-3.5" />
                        全选
                      </button>
                      <span className="text-xs text-destructive">{t('kb.selectedCount', { count: activeTab === 'sources' ? selectedSources.size : selectedPages.size })}</span>
                      <button
                        onClick={activeTab === 'sources' ? handleBatchDeleteSources : handleBatchDeletePages}
                        disabled={activeTab === 'sources' ? selectedSources.size === 0 : selectedPages.size === 0}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-destructive bg-destructive/10 rounded hover:bg-destructive/20 transition-colors disabled:opacity-50"
                      >
                        <Trash2 className="w-3 h-3" />
                        {t('kb.batchDelete')}
                      </button>
                      <button
                        onClick={exitBatchMode}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {t('kb.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setBatchMode(activeTab);
                        setSelectedSources(new Set());
                        setSelectedPages(new Set());
                      }}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors pr-2"
                    >
                      <Trash2 className="w-3 h-3" />
                      {t('kb.batchDelete')}
                    </button>
                  )
                )}
              </div>

              {activeTab === 'sources' && (
                <div>
                  {sources.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-8">
                      {t('kb.noSources')}
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {sources.map((source) => (
                        <div key={source.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-secondary transition-colors">
                          {batchMode === 'sources' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedSources((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(source.id)) next.delete(source.id);
                                  else next.add(source.id);
                                  return next;
                                });
                              }}
                              className="flex-shrink-0 text-muted-foreground hover:text-primary transition-colors"
                            >
                              {selectedSources.has(source.id) ? <CheckSquare className="w-4 h-4 text-primary" /> : <Square className="w-4 h-4" />}
                            </button>
                          )}
                          <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <button
                            className="text-sm flex-1 truncate text-left hover:text-primary transition-colors"
                            onClick={() => {
                              const kbId = currentKb!.id;
                              const sid = source.id;
                              (async () => {
                                try {
                                  const kbApi = await import('@/api/knowledge-base');
                                  await kbApi.kbOpenSourceDefault(kbId, sid);
                                } catch { /* ignore */ }
                              })();
                            }}
                          >
                            {source.storedName || source.originalPath}
                          </button>
                          <span className="text-xs text-muted-foreground">{source.fileType}</span>
                          <span className="text-xs text-muted-foreground">{formatFileSize(source.fileSize)}</span>
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                              source.status === 'compiled'
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : source.status === 'error'
                                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                  : source.status === 'ingesting'
                                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                    : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                            }`}
                          >
                            {t(`kb.status.${source.status}`)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'pages' && (
                <div>
                  {wikiPages.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-8">
                      {t('kb.noPages')}
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {wikiPages.map((page) => (
                        <div key={page.path} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-secondary transition-colors">
                          {batchMode === 'pages' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedPages((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(page.path)) next.delete(page.path);
                                  else next.add(page.path);
                                  return next;
                                });
                              }}
                              className="flex-shrink-0 text-muted-foreground hover:text-primary transition-colors"
                            >
                              {selectedPages.has(page.path) ? <CheckSquare className="w-4 h-4 text-primary" /> : <Square className="w-4 h-4" />}
                            </button>
                          )}
                          <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <button
                            className="text-sm flex-1 truncate text-left hover:text-primary transition-colors"
                            onClick={() => {
                              if (expandedPage === page.path) {
                                setExpandedPage(null);
                                setPageContent('');
                                setEditingPagePath(null);
                                setPageLinks({ outgoing: [], incoming: [] });
                                return;
                              }
                              setExpandedPage(page.path);
                              setEditingPagePath(null);
                              setPageContent(t('kb.loading'));
                              setPageLinks({ outgoing: [], incoming: [] });
                              (async () => {
                                try {
                                  const kbApi = await import('@/api/knowledge-base');
                                  const [pageRes, linksRes] = await Promise.all([
                                    kbApi.kbReadPage(currentKb!.id, page.path),
                                    kbApi.kbGetPageLinks(currentKb!.id, page.path),
                                  ]);
                                  if (pageRes.success) setPageContent(pageRes.data as string);
                                  else setPageContent(`Error: ${pageRes.error}`);
                                  if (linksRes.success) setPageLinks(linksRes.data as { outgoing: string[]; incoming: string[] });
                                } catch {
                                  setPageContent('Failed to load page');
                                }
                              })();
                            }}
                          >
                            {page.title}
                          </button>
                          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">
                            {page.type}
                          </span>
                          {expandedPage === page.path && editingPagePath !== page.path && (
                            <button
                              onClick={() => {
                                setEditingPagePath(page.path);
                                setEditContent(pageContent);
                                setSaveStatus(null);
                              }}
                              className="p-1 text-muted-foreground hover:text-primary transition-colors"
                              title={t('kb.editPage')}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {expandedPage === page.path && (
                            <div className="mx-3 mb-2 p-4 bg-muted/30 rounded-lg border border-border">
                              {editingPagePath === page.path ? (
                                <div className="space-y-3">
                                  <textarea
                                    value={editContent}
                                    onChange={(e) => setEditContent(e.target.value)}
                                    className="w-full h-80 px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-y font-mono"
                                  />
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => {
                                        const kbId = currentKb!.id;
                                        const pagePath = page.path;
                                        const content = editContent;
                                        (async () => {
                                          try {
                                            const kbApi = await import('@/api/knowledge-base');
                                            const res = await kbApi.kbUpdatePage(kbId, pagePath, content);
                                            if (res.success) {
                                              setPageContent(content);
                                              setEditingPagePath(null);
                                              setSaveStatus(t('kb.saveSuccess'));
                                              setTimeout(() => setSaveStatus(null), 2000);
                                            } else {
                                              setSaveStatus(`${t('kb.saveFailed')}: ${res.error}`);
                                            }
                                          } catch {
                                            setSaveStatus(t('kb.saveFailed'));
                                          }
                                        })();
                                      }}
                                      className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                                    >
                                      <Save className="w-3.5 h-3.5" />
                                      {t('kb.savePage')}
                                    </button>
                                    <button
                                      onClick={() => {
                                        setEditingPagePath(null);
                                        setEditContent('');
                                        setSaveStatus(null);
                                      }}
                                      className="flex items-center gap-1 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                      {t('kb.cancelEdit')}
                                    </button>
                                    {saveStatus && (
                                      <span className="text-xs text-muted-foreground">{saveStatus}</span>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <pre className="whitespace-pre-wrap text-sm leading-relaxed max-h-96 overflow-y-auto">{pageContent}</pre>
                                  {(pageLinks.outgoing.length > 0 || pageLinks.incoming.length > 0) && (
                                    <div className="mt-3 pt-3 border-t border-border space-y-2">
                                      {pageLinks.outgoing.length > 0 && (
                                        <div className="flex items-start gap-2">
                                          <ArrowUpLeft className="w-3.5 h-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                                          <div>
                                            <span className="text-xs text-muted-foreground">{t('kb.outgoingLinks')}</span>
                                            <div className="flex flex-wrap gap-1 mt-1">
                                              {pageLinks.outgoing.map((link) => (
                                                <span key={link} className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded">{link}</span>
                                              ))}
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                      {pageLinks.incoming.length > 0 && (
                                        <div className="flex items-start gap-2">
                                          <ArrowDownLeft className="w-3.5 h-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                                          <div>
                                            <span className="text-xs text-muted-foreground">{t('kb.incomingLinks')}</span>
                                            <div className="flex flex-wrap gap-1 mt-1">
                                              {pageLinks.incoming.map((link) => (
                                                <span key={link} className="text-xs px-2 py-0.5 bg-muted rounded text-muted-foreground">{link}</span>
                                              ))}
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'index' && (
                <div className="max-h-[60vh] overflow-y-auto">
                  {!indexContent || indexContent === t('kb.loading') ? (
                    wikiPages.length === 0 ? (
                      <div className="text-sm text-muted-foreground text-center py-12">
                        {t('kb.noWikiForIndex')}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-12">
                        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground mb-3" />
                        <span className="text-sm text-muted-foreground">{t('kb.loading')}</span>
                      </div>
                    )
                  ) : (() => {
                    const lines = indexContent.trim().split('\n');
                    const groups: Array<{ heading: string; items: Array<{ title: string; desc: string }> }> = [];
                    let currentHeading = '';
                    let currentItems: Array<{ title: string; desc: string }> = [];
                    for (const line of lines) {
                      const trimmed = line.trim();
                      if (!trimmed) continue;
                      if (trimmed.startsWith('## ')) {
                        if (currentItems.length > 0) groups.push({ heading: currentHeading, items: [...currentItems] });
                        currentHeading = trimmed.slice(3);
                        currentItems = [];
                      } else if (trimmed.startsWith('# ')) {
                        continue;
                      } else if (trimmed.startsWith('- ')) {
                        const match = trimmed.slice(2).match(/^\[\[([^\]]+)\]\]\s*[—\-–]\s*(.*)/);
                        if (match) currentItems.push({ title: match[1], desc: match[2] || '' });
                      }
                    }
                    if (currentItems.length > 0) groups.push({ heading: currentHeading, items: [...currentItems] });
                    return groups.length === 0 ? (
                      <pre className="text-sm text-muted-foreground whitespace-pre-wrap break-words px-2">{indexContent}</pre>
                    ) : (
                      <div className="space-y-5 px-1">
                        {groups.map((group) => (
                          <div key={group.heading}>
                            <div className="text-xs font-medium text-muted-foreground mb-1.5 tracking-wide">{group.heading} ({group.items.length})</div>
                            <div className="space-y-0.5">
                              {group.items.map((item) => {
                                const page = wikiPages.find((p) => p.title === item.title);
                                return (
                                  <div
                                    key={item.title}
                                    className="flex items-baseline gap-1.5 px-2 py-1 rounded hover:bg-secondary transition-colors cursor-pointer text-sm group"
                                    onClick={() => {
                                      if (page) {
                                        setActiveTab('pages');
                                        setExpandedPage(page.path);
                                        setEditingPagePath(null);
                                        setPageContent(t('kb.loading'));
                                        setPageLinks({ outgoing: [], incoming: [] });
                                        (async () => {
                                          try {
                                            const kbApi = await import('@/api/knowledge-base');
                                            const [pageRes, linksRes] = await Promise.all([
                                              kbApi.kbReadPage(currentKb!.id, page.path),
                                              kbApi.kbGetPageLinks(currentKb!.id, page.path),
                                            ]);
                                            if (pageRes.success) setPageContent(pageRes.data as string);
                                            if (linksRes.success) setPageLinks(linksRes.data as { outgoing: string[]; incoming: string[] });
                                          } catch { /* ignore */ }
                                        })();
                                      }
                                    }}
                                  >
                                    <span className="shrink-0 text-muted-foreground/50 select-none">•</span>
                                    <span className="group-hover:text-primary transition-colors">{item.title}</span>
                                    {item.desc && <span className="text-xs text-muted-foreground truncate">{item.desc}</span>}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              {activeTab === 'graph' && (
                <div>
                  {graphData ? (
                    <KnowledgeGraph
                      data={graphData}
                      onNodeClick={(nodeId) => {
                        const page = wikiPages.find((p) => p.path === nodeId);
                        if (page) {
                          setActiveTab('pages');
                          setExpandedPage(page.path);
                          setEditingPagePath(null);
                          setPageContent(t('kb.loading'));
                          setPageLinks({ outgoing: [], incoming: [] });
                          const kbId = currentKb!.id;
                          (async () => {
                            try {
                              const kbApi = await import('@/api/knowledge-base');
                              const [pageRes, linksRes] = await Promise.all([
                                kbApi.kbReadPage(kbId, page.path),
                                kbApi.kbGetPageLinks(kbId, page.path),
                              ]);
                              if (pageRes.success) setPageContent(pageRes.data as string);
                              if (linksRes.success) setPageLinks(linksRes.data as { outgoing: string[]; incoming: string[] });
                            } catch { /* ignore */ }
                          })();
                        }
                      }}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                      Loading graph...
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'query' && (
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={queryInput}
                      onChange={(e) => setQueryInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleQuery()}
                      placeholder={t('kb.queryPlaceholder')}
                      className="flex-1 px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                      disabled={loadingAction === 'query'}
                    />
                    <button
                      onClick={handleQuery}
                      disabled={loadingAction === 'query' || !queryInput.trim()}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                      {t('kb.ask')}
                    </button>
                  </div>

                  {queryAnswer && (
                    <div className="rounded-lg border border-border p-4">
                      <pre className="whitespace-pre-wrap text-sm">{queryAnswer}</pre>
                      {queryCited.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-border">
                          <span className="text-xs text-muted-foreground">{t('kb.citedPages')}:</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {queryCited.map((page) => (
                              <span
                                key={page}
                                className="text-xs px-2 py-0.5 bg-muted rounded text-muted-foreground"
                              >
                                {page}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'lint' && (
                <div>
                  {loadingAction === 'lint' ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                      <span className="ml-2 text-sm text-muted-foreground">{t('kb.lintRunning')}</span>
                    </div>
                  ) : lintResult ? (
                    <div className="space-y-4">
                      {/* Overview */}
                      <div className="rounded-lg border border-border p-4">
                        <h3 className="text-sm font-medium mb-3">{t('kb.lintResult')}</h3>
                        <div className="flex items-center gap-5">
                          <div className="flex-shrink-0 flex flex-col items-center">
                            <div className={`w-16 h-16 rounded-full flex items-center justify-center text-lg font-bold ${
                              lintResult.healthScore >= 80 ? 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400'
                                : lintResult.healthScore >= 50 ? 'bg-yellow-50 text-yellow-600 dark:bg-yellow-900/20 dark:text-yellow-400'
                                : 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                            }`}>
                              {lintResult.healthScore}
                            </div>
                            <span className="text-[10px] text-muted-foreground mt-1">Health</span>
                          </div>
                          <div className="flex-1 grid grid-cols-3 gap-3">
                            <div className="rounded-md bg-muted/50 p-2.5 text-center">
                              <div className="text-lg font-semibold">{lintResult.totalPages}</div>
                              <div className="text-[10px] text-muted-foreground">{t('kb.lintTotalPages')}</div>
                            </div>
                            <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-2.5 text-center">
                              <div className="text-lg font-semibold text-red-600 dark:text-red-400">{lintResult.issues.filter(i => i.severity === 'error').length}</div>
                              <div className="text-[10px] text-red-500 dark:text-red-400">{t('kb.lintErrors')}</div>
                            </div>
                            <div className="rounded-md bg-yellow-50 dark:bg-yellow-900/20 p-2.5 text-center">
                              <div className="text-lg font-semibold text-yellow-600 dark:text-yellow-400">{lintResult.issues.filter(i => i.severity === 'warning').length}</div>
                              <div className="text-[10px] text-yellow-500 dark:text-yellow-400">{t('kb.lintWarnings')}</div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {lintResult.issues.length === 0 ? (
                        <div className="text-sm text-muted-foreground text-center py-8">{t('kb.lintNoIssues')}</div>
                      ) : (
                        <>
                          {/* Distribution */}
                          <div className="rounded-lg border border-border p-4">
                            <h4 className="text-xs font-medium text-muted-foreground mb-2">{t('kb.lintDistribution')}</h4>
                            {(() => {
                              const typeOrder = ['empty_body', 'missing_frontmatter', 'empty_tags', 'missing_source', 'undersized_page', 'oversized_page', 'duplicate_title'];
                              const counts = new Map<string, number>();
                              for (const issue of lintResult.issues) {
                                counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
                              }
                              return (
                                <div className="grid grid-cols-3 gap-2">
                                  {typeOrder.map((type) => {
                                    const count = counts.get(type) ?? 0;
                                    if (count === 0) return null;
                                    return (
                                      <div key={type} className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
                                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                          type === 'empty_body' ? 'bg-red-500'
                                            : 'bg-yellow-500'
                                        }`} />
                                        <span className="text-xs truncate">{t(`kb.lintType.${type}`)}</span>
                                        <span className="text-xs font-semibold text-muted-foreground ml-auto">{count}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                          </div>

                          {/* Detail */}
                          <div className="rounded-lg border border-border p-4">
                            <h4 className="text-xs font-medium text-muted-foreground mb-2">{t('kb.lintDetail')}</h4>
                            <div className="space-y-1.5 max-h-72 overflow-y-auto">
                              {lintResult.issues.map((issue, i) => (
                                <div key={i} className={`flex items-start gap-2 text-xs p-2 rounded ${
                                  issue.severity === 'error' ? 'bg-red-50 dark:bg-red-900/20' : 'bg-yellow-50 dark:bg-yellow-900/20'
                                }`}>
                                  <span className={`flex-shrink-0 mt-0.5 ${issue.severity === 'error' ? 'text-red-500' : 'text-yellow-500'}`}>
                                    {issue.severity === 'error' ? '✕' : '⚠'}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                        issue.severity === 'error' ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300'
                                          : 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/40 dark:text-yellow-300'
                                      }`}>{t(`kb.lintType.${issue.type}`)}</span>
                                    </div>
                                    <div className="flex items-center gap-1 truncate mt-0.5">
                                      <span className="truncate font-medium">{issue.file}</span>
                                      {issue.relatedFile && (
                                        <span className="text-muted-foreground">↔ <span className="truncate">{issue.relatedFile}</span></span>
                                      )}
                                    </div>
                                    <div className="text-muted-foreground mt-0.5">{issue.detail}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-12">
                      {t('kb.lintHint')}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'report' && (
                <div>
                  {loadingAction === 'report' ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                      <span className="ml-2 text-sm text-muted-foreground">{t('kb.reportGenerating')}</span>
                    </div>
                  ) : reportContent ? (
                    <div className="rounded-lg border border-border max-h-[600px] overflow-y-auto">
                      <ReportContent content={reportContent} />
                    </div>
                  ) : wikiPages.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-12">
                      {t('kb.noWikiForReport')}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                      <span className="ml-2 text-sm text-muted-foreground">{t('kb.reportGenerating')}</span>
                    </div>
                  )}
                </div>
              )}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
