/**
 * Home Page - Space list view
 */

import React, { useEffect, useState, useRef } from 'react';
import { useAppStore } from '../stores/app.store';
import { useSpaceStore } from '../stores/space.store';
import { SPACE_ICONS, DEFAULT_SPACE_ICON } from '../types';
import type { Space, CreateSpaceInput, SpaceIconId } from '../types';
import type { RemoteServer } from '../../shared/types';
import {
  SpaceIcon,
  Sparkles,
  Settings,
  Trash2,
  FolderOpen,
  Pencil,
} from '../components/icons/ToolIcons';
import { Header } from '../components/layout/Header';
import { SpaceGuide } from '../components/space/SpaceGuide';
import { HyperSpaceCreationDialog } from '../components/space/HyperSpaceCreationDialog';
import { Monitor, Blocks, ArrowRight, Cloud, Folder, Bot, Library } from 'lucide-react';
import { api } from '../api';
import { useTranslation } from '../i18n';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { useNotificationStore } from '../stores/notification.store';

// Check if running in web mode
const isWebMode = api.isRemoteMode();

export function HomePage() {
  const { t } = useTranslation();
  const { confirm: confirmDialog, ConfirmDialogElement } = useConfirm();
  const { setView } = useAppStore();
  const {
    defaultSpace,
    spaces,
    loadSpaces,
    setCurrentSpace,
    refreshCurrentSpace,
    createSpace,
    updateSpace,
    deleteSpace,
  } = useSpaceStore();

  // Dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showHyperSpaceDialog, setShowHyperSpaceDialog] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [newSpaceIcon, setNewSpaceIcon] = useState<SpaceIconId>(DEFAULT_SPACE_ICON);

  // Edit dialog state
  const [editingSpace, setEditingSpace] = useState<Space | null>(null);
  const [editSpaceName, setEditSpaceName] = useState('');
  const [editSpaceIcon, setEditSpaceIcon] = useState<SpaceIconId>(DEFAULT_SPACE_ICON);

  // Path selection state
  const [useCustomPath, setUseCustomPath] = useState(false);
  const [customPath, setCustomPath] = useState<string | null>(null);
  const [defaultPath, setDefaultPath] = useState<string>(
    window.platform.isWindows ? '%USERPROFILE%\\.aico-bot\\spaces' : '~/.aico-bot/spaces',
  );

  // Remote Claude configuration state
  const [claudeSource, setClaudeSource] = useState<'local' | 'remote'>('local');
  const [remoteServerId, setRemoteServerId] = useState<string>('');
  const [remotePath, setRemotePath] = useState<string>('/home');
  const [remoteServers, setRemoteServers] = useState<RemoteServer[]>([]);
  const [useSshTunnel, setUseSshTunnel] = useState<boolean>(true); // Default to true for security

  const DEFAULT_REMOTE_SYSTEM_PROMPT = `1. 你是一个华为昇腾NPU服务器操作高手，精通各种NPU相关操作命令和模型迁移调优分析方法。
2. 当需要下载模型时，优先使用中国国内的模型网站，如modelscope
3. 当需要下载模型或者下载超大文件时，要先分析一下目标目录的剩余空间，不要直接下载`;
  const [systemPrompt, setSystemPrompt] = useState<string>(DEFAULT_REMOTE_SYSTEM_PROMPT);

  // Load spaces on mount
  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  // Load remote servers on mount
  useEffect(() => {
    api.remoteServerList().then((result) => {
      if (result.success && result.data) {
        setRemoteServers(result.data);
        // Auto-connect to any disconnected servers when showing the dialog
        result.data.forEach((server) => {
          if (server.status === 'disconnected') {
            console.log('[HomePage] Auto-connecting to server:', server.id);
            api.remoteServerConnect(server.id).catch((err) => {
              console.error('[HomePage] Failed to auto-connect to server:', server.id, err);
            });
          }
        });
      }
    });
  }, []);

  // Refresh remote servers list when switching to remote mode
  useEffect(() => {
    if (claudeSource === 'remote') {
      api.remoteServerList().then((result) => {
        if (result.success && result.data) {
          setRemoteServers(result.data);
        }
      });
    }
  }, [claudeSource]);

  // Load default path when dialog opens
  useEffect(() => {
    if (!showCreateDialog) return;

    let focusTimer: ReturnType<typeof setTimeout>;
    let fallbackTimer: ReturnType<typeof setTimeout>;

    // Focus after IPC resolves + short delay for re-render to complete
    api.getDefaultSpacePath().then((res) => {
      if (res.success && res.data) {
        setDefaultPath(res.data as string);
      }
      focusTimer = setTimeout(() => {
        spaceNameInputRef.current?.focus();
      }, 50);
    });

    // Fallback focus in case IPC is slow — must wait for animate-fade-in (300ms) to finish
    fallbackTimer = setTimeout(() => {
      if (document.activeElement !== spaceNameInputRef.current) {
        spaceNameInputRef.current?.focus();
      }
    }, 400);

    return () => {
      clearTimeout(focusTimer);
      clearTimeout(fallbackTimer);
    };
  }, [showCreateDialog]);

  // Focus edit space name input when edit dialog opens
  useEffect(() => {
    if (!editingSpace) return;
    const timer = setTimeout(() => {
      editSpaceNameInputRef.current?.focus();
    }, 400);
    return () => clearTimeout(timer);
  }, [editingSpace]);

  // Refs for space name inputs
  const spaceNameInputRef = useRef<HTMLInputElement>(null);
  const editSpaceNameInputRef = useRef<HTMLInputElement>(null);

  // Handle folder selection
  const handleSelectFolder = async () => {
    if (isWebMode) return; // Disabled in web mode
    const res = await api.selectFolder();
    if (res.success && res.data) {
      const path = res.data as string;
      setCustomPath(path);
      setUseCustomPath(true);
      // Extract directory name as suggested space name
      const dirName = path.split(/[/\\]/).pop() || '';
      if (dirName && !newSpaceName.trim()) {
        setNewSpaceName(dirName);
      }
      // Focus the space name input
      setTimeout(() => {
        spaceNameInputRef.current?.focus();
        spaceNameInputRef.current?.select();
      }, 100);
    }
  };

  // Reset dialog state
  const resetDialog = () => {
    setShowCreateDialog(false);
    setNewSpaceName('');
    setNewSpaceIcon(DEFAULT_SPACE_ICON);
    setUseCustomPath(false);
    setCustomPath(null);
    // Reset remote configuration
    setClaudeSource('local');
    setRemoteServerId('');
    setRemotePath('/home');
    setUseSshTunnel(true); // Default to true for security
    setSystemPrompt(DEFAULT_REMOTE_SYSTEM_PROMPT);
  };

  // Handle space click - no reset needed, SpacePage handles its own state
  const handleSpaceClick = (space: Space) => {
    setCurrentSpace(space);
    refreshCurrentSpace(); // Load full space data (preferences) from backend
    setView('space');
  };

  // Handle create space
  const handleCreateSpace = async () => {
    if (!newSpaceName.trim()) return;

    const input: CreateSpaceInput = {
      name: newSpaceName.trim(),
      icon: newSpaceIcon,
      customPath: useCustomPath && customPath ? customPath : undefined,
      claudeSource,
      remoteServerId: claudeSource === 'remote' ? remoteServerId : undefined,
      remotePath: claudeSource === 'remote' ? remotePath : undefined,
      useSshTunnel: claudeSource === 'remote' ? useSshTunnel : undefined,
      systemPrompt: claudeSource === 'remote' ? systemPrompt : undefined,
    };

    const result = await createSpace(input);

    if (result.space) {
      resetDialog();
    } else if (result.error === 'REMOTE_DIR_NOT_FOUND' && result.data?.remotePath) {
      const confirmed = await confirmDialog(
        t('远程服务器上不存在目录 "{{path}}"，是否自动创建？', { path: result.data.remotePath }),
      );
      if (confirmed && remoteServerId) {
        const dirResult = await api.createRemoteDir({ remoteServerId, remotePath: result.data.remotePath });
        if (dirResult.success) {
          // Retry space creation after directory is created
          const retryResult = await createSpace(input);
          if (retryResult.space) {
            resetDialog();
          }
        }
      }
    }
  };

  // Shorten path for display
  const shortenPath = (p: string) => {
    // macOS: /Users/xxx -> ~/...
    if (p.includes('/Users/')) {
      return p.replace(/\/Users\/[^/]+/, '~');
    }
    // Windows: C:\Users\xxx -> ~\...
    if (/^[A-Z]:\\Users\\/.test(p)) {
      return p.replace(/^[A-Z]:\\Users\\[^\\]+/, '~');
    }
    return p;
  };

  // Handle delete space
  const handleDeleteSpace = async (e: React.MouseEvent, spaceId: string) => {
    e.stopPropagation();

    // Find the space to check if it's a custom path
    const space = spaces.find((s) => s.id === spaceId);
    if (!space) return;

    // Check if it's a project-linked space:
    // - New centralized spaces with project: have workingDir
    // - Legacy custom spaces: path doesn't end with /spaces/{uuid}
    //   (centralized paths are always {dataDir}/spaces/{uuid-v4}, uuid is 36 chars)
    const lastSegment = space.path.split(/[/\\]/).pop() ?? '';
    const isCentralizedSpace =
      (space.path.includes('/spaces/') || space.path.includes('\\spaces\\')) &&
      lastSegment.length === 36;
    const isProjectSpace = !!space.workingDir || !isCentralizedSpace;

    const message = isProjectSpace
      ? t(
          'Are you sure you want to delete this space?\n\nOnly AICO-Bot data (conversation history) will be deleted, your project files will be kept.',
        )
      : t(
          'Are you sure you want to delete this space?\n\nAll conversations and files in the space will be deleted.',
        );

    if (await confirmDialog(message)) {
      const result = await deleteSpace(spaceId);
      if (!result.success) {
        const showToast = useNotificationStore.getState().show;
        showToast({
          title: t('Delete failed'),
          body:
            result.error ||
            t(
              'Failed to delete space. Some files may be in use. Please close any active sessions and try again.',
            ),
          variant: 'error',
          duration: 6000,
        });
        // Reload spaces to re-sync with backend
        loadSpaces();
      }
    }
  };

  // Handle edit space - open dialog
  const handleEditSpace = (e: React.MouseEvent, space: Space) => {
    e.stopPropagation();
    setEditingSpace(space);
    setEditSpaceName(space.name);
    setEditSpaceIcon(space.icon as SpaceIconId);
  };

  // Handle save space edit
  const handleSaveEdit = async () => {
    if (!editingSpace || !editSpaceName.trim()) return;

    await updateSpace(editingSpace.id, {
      name: editSpaceName.trim(),
      icon: editSpaceIcon,
    });

    setEditingSpace(null);
    setEditSpaceName('');
    setEditSpaceIcon(DEFAULT_SPACE_ICON);
  };

  // Handle cancel edit
  const handleCancelEdit = () => {
    setEditingSpace(null);
    setEditSpaceName('');
    setEditSpaceIcon(DEFAULT_SPACE_ICON);
  };

  // Format time ago
  const formatTimeAgo = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t('Today');
    if (diffDays === 1) return t('Yesterday');
    if (diffDays < 7) return t('{{count}} days ago', { count: diffDays });
    if (diffDays < 30) return t('{{count}} weeks ago', { count: Math.floor(diffDays / 7) });
    return t('{{count}} months ago', { count: Math.floor(diffDays / 30) });
  };

  return (
    <>
      {ConfirmDialogElement}
      <div className="h-full w-full flex flex-col">
        {/* Header - cross-platform support */}
        <Header
          left={
            <>
              <div className="w-[22px] h-[22px] rounded-full border-2 border-primary/60 flex items-center justify-center">
                <div className="w-3 h-3 rounded-full bg-gradient-to-br from-primary/30 to-transparent" />
              </div>
              <span className="text-sm font-medium">AICO-Bot</span>
            </>
          }
          right={
            <>
              <button
                onClick={() => setView('apps')}
                className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
                title={t('Apps')}
              >
                <Bot className="w-5 h-5" />
              </button>
              <button
                onClick={() => setView('settings')}
                className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
              >
                <Settings className="w-5 h-5" />
              </button>
            </>
          }
        />

        {/* Content */}
        <main className="flex-1 overflow-auto p-6">
          {/* Primary entry cards: AICO-Bot Space + 技能管理 */}
          <div className="grid grid-cols-2 gap-4 mb-8 animate-fade-in">
            {/* Default Space card */}
            {defaultSpace && (
              <div
                data-onboarding="default-space"
                onClick={() => handleSpaceClick(defaultSpace)}
                className="aico-bot-space-card p-5 rounded-xl cursor-pointer flex flex-col gap-3 min-h-[120px]"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-primary" />
                    <h2 className="text-sm font-semibold">{defaultSpace.name}</h2>
                    {defaultSpace.claudeSource === 'remote' ? (
                      <span className="flex items-center gap-1 text-xs bg-blue-500/10 text-blue-500 px-2 py-0.5 rounded-full">
                        <Cloud className="w-3 h-3" />
                        {t('Remote')}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs bg-green-500/10 text-green-600 px-2 py-0.5 rounded-full">
                        <Folder className="w-3 h-3" />
                        {t('Local')}
                      </span>
                    )}
                  </div>
                  {defaultSpace.claudeSource === 'remote' && defaultSpace.remoteServerId && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Cloud className="w-3 h-3" />@
                      {remoteServers.find((s) => s.id === defaultSpace.remoteServerId)?.name ||
                        defaultSpace.remoteServerId}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground flex-1">
                  {t('Aimless time, ideas will crystallize here')}
                </p>
                <div className="flex justify-end">
                  <span className="text-xs text-primary flex items-center gap-1">
                    {t('Enter')} <ArrowRight className="w-3 h-3" />
                  </span>
                </div>
              </div>
            )}

            {/* Skill Management card */}
            <div
              onClick={() => setView('skill')}
              className="skill-space-card p-5 rounded-xl cursor-pointer flex flex-col gap-3 min-h-[120px]"
            >
              <div className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-amber-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                  />
                </svg>
                <h2 className="text-sm font-semibold">{t('技能管理')}</h2>
              </div>
              <p className="text-xs text-muted-foreground flex-1">{t('技能库、市场与编辑器')}</p>
              <div className="flex justify-end">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  {t('Open')} <ArrowRight className="w-3 h-3" />
                </span>
              </div>
            </div>

            {/* Knowledge Base card */}
            <div
              onClick={() => setView('knowledgeBase')}
              className="kb-space-card p-5 rounded-xl cursor-pointer flex flex-col gap-3 min-h-[120px]"
            >
              <div className="flex items-center gap-2">
                <Library className="w-5 h-5 text-emerald-500" />
                <h2 className="text-sm font-semibold">知识库</h2>
              </div>
              <p className="text-xs text-muted-foreground flex-1">个人 Wiki 知识管理</p>
              <div className="flex justify-end">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  {t('Enter')} <ArrowRight className="w-3 h-3" />
                </span>
              </div>
            </div>
          </div>

          {/* Spaces Section */}
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium text-muted-foreground">{t('Dedicated Spaces')}</h3>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground mr-1">
                {t('Space Creation')}
              </span>
              <div className="w-px h-4 bg-border mx-1" />
              <button
                onClick={() => {
                  setClaudeSource('local');
                  setShowCreateDialog(true);
                }}
                title={t(
                  'Create a local space with files stored on your computer. Suitable for local development and file management.',
                )}
                className="flex items-center gap-1 px-3 py-1 text-sm text-green-600 hover:bg-green-500/10 rounded-lg transition-colors"
              >
                <Folder className="w-4 h-4" />
                {t('Local')}
              </button>
              <button
                onClick={() => {
                  setClaudeSource('remote');
                  setShowCreateDialog(true);
                }}
                title={t(
                  'Create a remote space connected to a remote server via SSH. Suitable for cloud servers, NPU clusters, and remote development.',
                )}
                className="flex items-center gap-1 px-3 py-1 text-sm text-blue-500 hover:bg-blue-500/10 rounded-lg transition-colors"
              >
                <Cloud className="w-4 h-4" />
                {t('Remote')}
              </button>
              <button
                onClick={() => setShowHyperSpaceDialog(true)}
                title={t(
                  'Create a Hyper Space with multiple AI agents collaborating. The leader agent orchestrates tasks and delegates to worker agents.',
                )}
                className="flex items-center gap-1 px-3 py-1 text-sm text-purple-500 hover:bg-purple-500/10 rounded-lg transition-colors"
              >
                <Blocks className="w-4 h-4" />
                {t('Hyper')}
              </button>
            </div>
          </div>

          {/* Space Guide - always visible */}
          <SpaceGuide />

          {spaces.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p className="text-sm">{t('No dedicated spaces yet')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {spaces.map((space, i) => {
                const remoteServer = space.remoteServerId
                  ? remoteServers.find((s) => s.id === space.remoteServerId)
                  : null;
                return (
                  <div
                    key={`${space.id}-${i}`}
                    onClick={() => handleSpaceClick(space)}
                    className="space-card p-4 group animate-fade-in"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <SpaceIcon iconId={space.icon} size={20} />
                        <span className="font-medium truncate">{space.name}</span>
                        {space.spaceType === 'hyper' ? (
                          <span className="flex items-center gap-1 text-xs bg-purple-500/10 text-purple-500 px-2 py-0.5 rounded-full flex-shrink-0">
                            <Blocks className="w-3 h-3" />
                            Hyper
                          </span>
                        ) : space.claudeSource === 'remote' ? (
                          <span className="flex items-center gap-1 text-xs bg-blue-500/10 text-blue-500 px-2 py-0.5 rounded-full flex-shrink-0">
                            <Cloud className="w-3 h-3" />
                            远程
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs bg-green-500/10 text-green-600 px-2 py-0.5 rounded-full flex-shrink-0">
                            <Folder className="w-3 h-3" />
                            本地
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                        <button
                          onClick={(e) => handleEditSpace(e, space)}
                          className="p-1 hover:bg-secondary rounded transition-all"
                          title={t('Edit Space')}
                        >
                          <Pencil className="w-4 h-4 text-muted-foreground" />
                        </button>
                        <button
                          onClick={(e) => handleDeleteSpace(e, space.id)}
                          className="p-1 hover:bg-destructive/20 rounded transition-all"
                          title={t('Delete space')}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </button>
                      </div>
                    </div>
                    {/* Project directory */}
                    <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                      <Folder className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">
                        {space.claudeSource === 'remote'
                          ? space.remotePath || '/home'
                          : space.workingDir || space.path}
                      </span>
                    </div>
                    {/* Remote server info */}
                    {space.claudeSource === 'remote' && remoteServer && (
                      <div className="flex items-center gap-1 mt-1.5 text-xs text-muted-foreground">
                        <Cloud className="w-3 h-3" />
                        <span className="truncate">@ {remoteServer.name}</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {formatTimeAgo(space.updatedAt)}
                      {t('active')}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </main>

        {/* Create Space Dialog */}
        {showCreateDialog && (
          <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-[200]"
            onClick={resetDialog}
          >
            {/* Animation wrapper — separated from scroll container to avoid Chromium hit-testing issues */}
            <div className="animate-fade-in" onClick={(e) => e.stopPropagation()}>
              <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
                <h2 className="text-lg font-medium mb-4">
                  {claudeSource === 'local' ? t('Create Local Space') : t('Create Remote Space')}
                </h2>

                {/* Icon select */}
                <div className="mb-4">
                  <label className="block text-sm text-muted-foreground mb-2">
                    {t('Icon (optional)')}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {SPACE_ICONS.map((iconId) => (
                      <button
                        key={iconId}
                        onClick={() => setNewSpaceIcon(iconId)}
                        className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                          newSpaceIcon === iconId
                            ? 'bg-primary/20 border-2 border-primary'
                            : 'bg-secondary hover:bg-secondary/80'
                        }`}
                      >
                        <SpaceIcon iconId={iconId} size={20} />
                      </button>
                    ))}
                  </div>
                </div>

                {/* Storage location - only for local mode */}
                {claudeSource === 'local' && (
                  <div className="mb-6">
                    <label className="block text-sm text-muted-foreground mb-2">
                      {t('Storage Location')}
                    </label>
                    <div className="space-y-2">
                      {/* Default location */}
                      <label
                        className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                          !useCustomPath
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-muted-foreground/50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="pathType"
                          checked={!useCustomPath}
                          onChange={() => {
                            setUseCustomPath(false);
                            setTimeout(() => {
                              spaceNameInputRef.current?.focus();
                            }, 100);
                          }}
                          className="w-4 h-4 text-primary"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm">{t('Default Location')}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {shortenPath(defaultPath)}/{newSpaceName || '...'}
                          </div>
                        </div>
                      </label>

                      {/* Custom location */}
                      <label
                        className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                          isWebMode
                            ? 'cursor-not-allowed opacity-60 border-border'
                            : useCustomPath
                              ? 'cursor-pointer border-primary bg-primary/5'
                              : 'cursor-pointer border-border hover:border-muted-foreground/50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="pathType"
                          checked={useCustomPath}
                          onChange={() => !isWebMode && setUseCustomPath(true)}
                          disabled={isWebMode}
                          className="w-4 h-4 text-primary"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm">{t('Custom Folder')}</div>
                          {isWebMode ? (
                            <div className="text-xs text-muted-foreground flex items-center gap-1">
                              <Monitor className="w-3 h-3" />
                              {t('Please select folder in desktop app')}
                            </div>
                          ) : customPath ? (
                            <div className="text-xs text-muted-foreground truncate">
                              {shortenPath(customPath)}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground">
                              {t('Select an existing project or folder')}
                            </div>
                          )}
                        </div>
                        {!isWebMode && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              handleSelectFolder();
                            }}
                            className="px-3 py-1.5 text-xs bg-secondary hover:bg-secondary/80 rounded-md flex items-center gap-1.5 transition-colors"
                          >
                            <FolderOpen className="w-3.5 h-3.5" />
                            {t('Browse')}
                          </button>
                        )}
                      </label>
                    </div>
                  </div>
                )}

                {/* Remote server configuration (only shown when remote is selected) */}
                {claudeSource === 'remote' && (
                  <>
                    <div className="mb-4">
                      <label className="block text-sm text-muted-foreground mb-2">
                        {t('Remote Server')}
                      </label>
                      <select
                        value={remoteServerId}
                        onChange={(e) => setRemoteServerId(e.target.value)}
                        className="w-full mt-1 px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                      >
                        <option value="">{t('Select server...')}</option>
                        {remoteServers
                          .filter((s: RemoteServer) => s.sdkInstalled && s.proxyRunning)
                          .map((server: RemoteServer) => (
                            <option key={server.id} value={server.id}>
                              {server.name}
                            </option>
                          ))}
                      </select>
                      {remoteServers.length > 0 &&
                        remoteServers.filter((s: RemoteServer) => s.sdkInstalled && s.proxyRunning)
                          .length === 0 && (
                          <p className="text-xs text-amber-500 mt-1">
                            {t(
                              'No servers with SDK and Bot Proxy ready. Please deploy the agent first.',
                            )}
                          </p>
                        )}
                    </div>

                    <div className="mb-4">
                      <label className="block text-sm text-muted-foreground mb-2">
                        {t('Working Directory (Remote)')}
                      </label>
                      <input
                        type="text"
                        value={remotePath}
                        onChange={(e) => setRemotePath(e.target.value)}
                        placeholder="/home"
                        className="w-full mt-1 px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                      />
                      <p className="text-xs text-muted-foreground mt-1">{t('Default: /home')}</p>
                    </div>

                    {/* SSH Tunnel Toggle */}
                    <div className="mb-6">
                      <label className="block text-sm text-muted-foreground mb-2">
                        {t('Connection Mode')}
                      </label>
                      <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-secondary/30">
                        <div className="flex-1">
                          <div className="text-sm font-medium">{t('Use SSH Tunnel')}</div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t(
                              'Use SSH port forwarding (localhost:8080) instead of direct WebSocket connection.',
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t(
                              'Use this for Huawei Cloud or networks that block external WebSocket connections.',
                            )}
                          </p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer ml-4">
                          <input
                            type="checkbox"
                            checked={useSshTunnel}
                            onChange={(e) => setUseSshTunnel(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                        </label>
                      </div>
                      {useSshTunnel && (
                        <p className="text-xs text-primary mt-2">
                          {t(
                            'Note: Make sure SSH port forwarding is active: ssh -L 8080:localhost:8080 <server>',
                          )}
                        </p>
                      )}
                    </div>

                    {/* System Prompt */}
                    <div className="mb-6">
                      <label className="block text-sm text-muted-foreground mb-2">
                        {t('System Prompt (optional)')}
                      </label>
                      <textarea
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        placeholder={t('Custom instructions for the AI agent in this space...')}
                        rows={5}
                        className="w-full mt-1 px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors resize-y text-sm"
                      />
                    </div>
                  </>
                )}

                {/* Space name - moved to bottom, above create button */}
                <div className="mb-6">
                  <label className="block text-sm text-muted-foreground mb-2">
                    {t('Name this space')}
                  </label>
                  <input
                    ref={spaceNameInputRef}
                    type="text"
                    value={newSpaceName}
                    onChange={(e) => setNewSpaceName(e.target.value)}
                    placeholder={t('My Project')}
                    className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                  />
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-3">
                  <button
                    onClick={resetDialog}
                    className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-colors"
                  >
                    {t('Cancel')}
                  </button>
                  <button
                    onClick={handleCreateSpace}
                    disabled={
                      !newSpaceName.trim() ||
                      (useCustomPath && !customPath) ||
                      (claudeSource === 'remote' && !remoteServerId)
                    }
                    className="px-4 py-2 bg-primary text-primary-foreground rounded-lg btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('Create')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Edit Space Dialog */}
        {editingSpace && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[200]">
            <div className="animate-fade-in">
              <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md">
                <h2 className="text-lg font-medium mb-4">{t('Edit Space')}</h2>

                {/* Space name */}
                <div className="mb-4">
                  <label className="block text-sm text-muted-foreground mb-2">
                    {t('Space Name')}
                  </label>
                  <input
                    ref={editSpaceNameInputRef}
                    type="text"
                    value={editSpaceName}
                    onChange={(e) => setEditSpaceName(e.target.value)}
                    placeholder={t('My Project')}
                    className="w-full px-4 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
                  />
                </div>

                {/* Icon select */}
                <div className="mb-6">
                  <label className="block text-sm text-muted-foreground mb-2">{t('Icon')}</label>
                  <div className="flex flex-wrap gap-2">
                    {SPACE_ICONS.map((iconId) => (
                      <button
                        key={iconId}
                        onClick={() => setEditSpaceIcon(iconId)}
                        className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                          editSpaceIcon === iconId
                            ? 'bg-primary/20 border-2 border-primary'
                            : 'bg-secondary hover:bg-secondary/80'
                        }`}
                      >
                        <SpaceIcon iconId={iconId} size={20} />
                      </button>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-3">
                  <button
                    onClick={handleCancelEdit}
                    className="px-4 py-2 text-muted-foreground hover:bg-secondary rounded-lg transition-colors"
                  >
                    {t('Cancel')}
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    disabled={!editSpaceName.trim()}
                    className="px-4 py-2 bg-primary text-primary-foreground rounded-lg btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('Save')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Hyper Space Creation Dialog */}
        <HyperSpaceCreationDialog
          isOpen={showHyperSpaceDialog}
          onClose={() => setShowHyperSpaceDialog(false)}
          onSuccess={(spaceId) => {
            loadSpaces();
            // Need to wait for spaces to load, then find and set the new space
            setTimeout(() => {
              api.listSpaces().then((result) => {
                if (result.success && result.data) {
                  const space = (result.data as Space[]).find((s) => s.id === spaceId);
                  if (space) {
                    setCurrentSpace(space);
                    setView('space');
                  }
                }
              });
            }, 100);
          }}
        />
      </div>
    </>
  );
}
