/**
 * SkillLibrary - 已安装技能库
 *
 * 显示已安装的技能列表，支持启用/禁用、卸载、导出等操作
 * 支持查看本地技能和远程服务器上的技能
 * 同时支持抽屉式文件浏览器
 */

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useSkillStore } from '../../stores/skill/skill.store';
import { useTranslation } from '../../i18n';
import {
  Book,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Download,
  FileCode,
  FolderOpen,
  Folder,
  ChevronRight,
  ChevronDown,
  FileText,
  X,
  Loader2,
  RefreshCw,
  Server,
  HardDrive,
  GripVertical,
  Github,
  ExternalLink,
  Upload,
  PackagePlus,
  FolderInput,
} from 'lucide-react';
import type {
  InstalledSkill,
  SkillFileNode,
  SkillMarketSource,
} from '../../../shared/skill/skill-types';
import { api, isElectron } from '../../api';
import { useConfirm } from '../ui/ConfirmDialog';

// 文件节点接口
interface FileNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  extension?: string;
  children?: FileNode[];
}

// 技能来源类型
type SkillSource = { type: 'local' } | { type: 'remote'; serverId: string; serverName: string };

export function SkillLibrary() {
  const { t } = useTranslation();
  const { confirm: confirmDialog, ConfirmDialogElement } = useConfirm();
  const {
    installedSkills,
    selectedSkillId,
    setSelectedSkillId,
    toggleSkill,
    uninstallSkill,
    exportSkill,
    refreshSkills,
    remoteSkills,
    remoteSkillsLoading,
    remoteSkillsError,
    loadRemoteSkills,
    marketSources,
    pushSkillToGitHub,
    pushLoading,
    pushResult,
    pushError,
    clearPushState,
    repoDirs,
    repoDirsLoading,
    loadRepoDirectories,
    loadGitCodeRepoDirectories,
    syncLoading,
    syncError,
    syncSkillToRemote,
    clearSyncState,
    syncSkillFromRemote,
    syncFromRemoteLoading,
    clearSyncFromRemoteState,
  } = useSkillStore();

  // GitHub 推送状态
  const [showPushModal, setShowPushModal] = useState(false);
  const [pushTargetRepo, setPushTargetRepo] = useState('');
  const [pushTargetSourceId, setPushTargetSourceId] = useState('');
  const [pushTargetPath, setPushTargetPath] = useState('');

  // Sync to remote server 状态
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncTargetServerId, setSyncTargetServerId] = useState<string | null>(null);
  const [syncOutput, setSyncOutput] = useState<string>('');

  // Sync from remote server 状态
  const [showSyncFromRemoteModal, setShowSyncFromRemoteModal] = useState(false);
  const [syncFromRemoteOutput, setSyncFromRemoteOutput] = useState<string>('');

  // Remote uninstall loading state
  const [remoteUninstallLoading, setRemoteUninstallLoading] = useState(false);

  // Import state
  const [importing, setImporting] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);

  // Import ZIP file input ref (for Web mode)
  const zipInputRef = useRef<HTMLInputElement>(null);

  // GitHub + GitCode 源列表
  const githubSources = marketSources.filter((s) => s.type === 'github' || s.type === 'gitcode');

  // Push target helpers
  const pushTargetSource = pushTargetSourceId
    ? githubSources.find((s) => s.id === pushTargetSourceId)
    : null;
  const isGitCodePush = pushTargetSource?.type === 'gitcode';

  // 技能来源选择
  const [selectedSource, setSelectedSource] = useState<SkillSource>({ type: 'local' });
  const [showSourceDropdown, setShowSourceDropdown] = useState(false);

  // 组件挂载时不再自动刷新，由 SkillPage 统一管理
  // 用户可通过刷新按钮手动刷新

  // 抽屉状态
  const [showFilesDrawer, setShowFilesDrawer] = useState(false);
  const [fileTree, setFileTree] = useState<FileNode[] | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);

  // 抽屉宽度状态（支持拖动调整）
  const [drawerWidth, setDrawerWidth] = useState(384); // 默认 384px (w-96)
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);

  // 拖动调整宽度
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = window.innerWidth - e.clientX;
      // 限制最小和最大宽度
      const minWidth = 280;
      const maxWidth = 600;
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setDrawerWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // 远程服务器列表（用于 source dropdown）
  const [remoteServers, setRemoteServers] = useState<
    { id: string; name: string; status: string }[]
  >([]);

  // 按名称排序的本地技能列表
  const sortedSkills = useMemo(() => {
    return [...installedSkills].sort((a, b) => a.spec.name.localeCompare(b.spec.name));
  }, [installedSkills]);

  // 当前来源对应的技能列表
  const activeSkills = useMemo(() => {
    if (selectedSource.type === 'local') {
      return sortedSkills;
    }
    return (remoteSkills[selectedSource.serverId] || []).sort((a, b) =>
      a.spec.name.localeCompare(b.spec.name),
    );
  }, [selectedSource, sortedSkills, remoteSkills]);

  const activeLoading =
    selectedSource.type === 'remote'
      ? remoteSkillsLoading[selectedSource.serverId] || false
      : false;

  const activeError =
    selectedSource.type === 'remote' ? remoteSkillsError[selectedSource.serverId] || null : null;

  // 加载远程服务器列表（组件挂载时 + 打开同步模态框时）
  const loadRemoteServers = async () => {
    try {
      const result = await api.remoteServerList();
      if (result.success && result.data) {
        setRemoteServers(
          result.data.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status || 'disconnected',
          })),
        );
      }
    } catch (error) {
      console.error('Failed to load remote servers:', error);
    }
  };

  useEffect(() => {
    loadRemoteServers();
  }, []);

  // 选择远程服务器时加载远程技能
  useEffect(() => {
    if (selectedSource.type === 'remote') {
      const { serverId } = selectedSource;
      if (!remoteSkills[serverId] && !remoteSkillsLoading[serverId]) {
        loadRemoteSkills(serverId);
      }
    }
  }, [selectedSource]);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    if (!showSourceDropdown) return;
    const handleClickOutside = () => setShowSourceDropdown(false);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showSourceDropdown]);

  // 点击外部关闭导入菜单
  useEffect(() => {
    if (!importMenuOpen) return;
    const handler = () => setImportMenuOpen(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [importMenuOpen]);

  // Push 弹窗打开时加载仓库目录
  useEffect(() => {
    if (showPushModal && pushTargetRepo) {
      loadRepoDirectories(pushTargetRepo);
    }
  }, [showPushModal, pushTargetRepo]);

  // 监听技能同步输出
  useEffect(() => {
    const cleanup = api.onSkillSyncOutput(({ skillId, serverId, output }) => {
      if (skillId === selectedSkillId) {
        setSyncOutput((prev) => prev + output.content);
      }
    });
    return cleanup;
  }, [selectedSkillId]);

  // 监听从远程同步技能输出
  useEffect(() => {
    const cleanup = api.onSkillSyncFromRemoteOutput(({ skillId, serverId, output }) => {
      if (skillId === selectedSkillId) {
        setSyncFromRemoteOutput((prev) => prev + output.content);
      }
    });
    return cleanup;
  }, [selectedSkillId]);

  // 加载文件树
  const loadFileTree = async (skillId: string) => {
    setLoadingFiles(true);
    try {
      let result;
      if (selectedSource.type === 'remote') {
        result = await api.remoteServerListSkillFiles(selectedSource.serverId, skillId);
      } else {
        result = await api.skillFiles(skillId);
      }
      if (result.success && result.data) {
        setFileTree(result.data);
      } else {
        setFileTree([]);
      }
    } catch (error) {
      console.error('Failed to load file tree:', error);
      setFileTree([]);
    } finally {
      setLoadingFiles(false);
    }
  };

  // 加载文件内容
  const loadFileContent = async (skillId: string, filePath: string) => {
    try {
      let result;
      if (selectedSource.type === 'remote') {
        result = await api.remoteServerReadSkillFile(selectedSource.serverId, skillId, filePath);
      } else {
        result = await api.skillFileContent(skillId, filePath);
      }
      if (result.success && result.data !== undefined) {
        setFileContent(result.data);
        setSelectedFilePath(filePath);
      }
    } catch (error) {
      console.error('Failed to load file content:', error);
    }
  };

  // 打开文件抽屉
  const handleOpenFiles = async (skillId: string) => {
    setShowFilesDrawer(true);
    await loadFileTree(skillId);
  };

  // 关闭文件抽屉
  const handleCloseFiles = () => {
    setShowFilesDrawer(false);
    setFileTree(null);
    setSelectedFilePath(null);
    setFileContent(null);
  };

  // 处理导出技能
  const handleExport = async (skillId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const yamlContent = await exportSkill(skillId);
    if (yamlContent) {
      // 创建下载
      const blob = new Blob([yamlContent], { type: 'application/x-yaml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${skillId}-skill.yaml`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  // 处理卸载确认
  const handleUninstall = async (skillId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (await confirmDialog(t('Are you sure you want to uninstall this skill?'))) {
      await uninstallSkill(skillId);
    }
  };

  // 处理远程卸载
  const handleRemoteUninstall = async (skillId: string) => {
    if (selectedSource.type !== 'remote') return;
    const serverId = selectedSource.serverId;
    const confirmed = await confirmDialog(
      t('Are you sure you want to uninstall this skill from {name}?', {
        name: selectedSource.serverName,
      }),
      { title: t('Uninstall Skill'), confirmLabel: t('Uninstall'), cancelLabel: t('Cancel') },
    );
    if (!confirmed) return;

    setRemoteUninstallLoading(true);
    try {
      await api.skillUninstallMulti({
        appId: skillId,
        targets: [{ type: 'remote', serverId }],
      });
      setSelectedSkillId(null);
      await loadRemoteSkills(serverId);
    } catch (error) {
      console.error('Failed to uninstall remote skill:', error);
    } finally {
      setRemoteUninstallLoading(false);
    }
  };

  // 导入技能处理函数
  const handleImportFromZip = useCallback(async () => {
    setImportMenuOpen(false);
    if (importing) return;

    if (isElectron()) {
      try {
        console.log('[SkillImport] handleImportFromZip: opening dialog...');
        const filePaths = await window.aicoBot.showOpenDialog({
          title: t('Select Archive File'),
          filters: [{ name: 'Archive', extensions: ['zip', 'tar.gz', 'tgz', 'tar.bz2', 'tar.xz'] }],
          properties: ['openFile'],
        });

        console.log('[SkillImport] dialog result:', filePaths);
        if (!filePaths || filePaths.length === 0) return;

        const filePath = filePaths[0];
        console.log('[SkillImport] calling skillImportSkills with sourceType=archive, filePath=', filePath);
        setImporting(true);
        const result = await window.aicoBot.skillImportSkills({
          sourceType: 'archive',
          filePath,
        });

        console.log('[SkillImport] IPC result:', JSON.stringify(result));
        if (result?.success && result.data) {
          const { installed, skipped, errors } = result.data;
          console.log('[SkillImport] installed:', installed, 'skipped:', skipped, 'errors:', errors);
          if (installed.length > 0) {
            console.log(`Installed ${installed.length} skills: ${installed.join(', ')}`);
          }
          if (skipped.length > 0) {
            console.warn(`Skipped ${skipped.length}: ${skipped.join(', ')}`);
          }
          if (errors.length > 0) {
            console.error(`Errors: ${errors.join('; ')}`);
          }
          refreshSkills();
        } else {
          console.warn('[SkillImport] result not success or no data:', result);
        }
      } catch (err) {
        console.error('[SkillImport] Import from ZIP failed:', err);
      } finally {
        setImporting(false);
      }
    } else {
      zipInputRef.current?.click();
    }
  }, [importing, refreshSkills]);

  const handleImportFromFolder = useCallback(async () => {
    setImportMenuOpen(false);
    if (importing) return;

    try {
      console.log('[SkillImport] handleImportFromFolder: opening dialog...');
      const dirPaths = await window.aicoBot.showOpenDialog({
        title: t('Select folder containing skills'),
        properties: ['openDirectory'],
      });

      console.log('[SkillImport] dialog result:', dirPaths);
      if (!dirPaths || dirPaths.length === 0) return;

      const dirPath = dirPaths[0];
      console.log('[SkillImport] calling skillImportSkills with sourceType=folder, filePath=', dirPath);
      setImporting(true);
      const result = await window.aicoBot.skillImportSkills({
        sourceType: 'folder',
        filePath: dirPath,
      });

      console.log('[SkillImport] IPC result:', JSON.stringify(result));
      if (result?.success && result.data) {
        const { installed, skipped, errors } = result.data;
        console.log('[SkillImport] installed:', installed, 'skipped:', skipped, 'errors:', errors);
        if (installed.length > 0) {
          console.log(`Installed ${installed.length} skills: ${installed.join(', ')}`);
        }
        if (skipped.length > 0) {
          console.warn(`Skipped ${skipped.length}: ${skipped.join(', ')}`);
        }
        if (errors.length > 0) {
          console.error(`Errors: ${errors.join('; ')}`);
        }
        refreshSkills();
      } else {
        console.warn('[SkillImport] result not success or no data:', result);
      }
    } catch (err) {
      console.error('Import from folder failed:', err);
    } finally {
      setImporting(false);
    }
  }, [importing, refreshSkills]);

  const handleZipFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      console.log('[SkillImport] handleZipFileChange: uploading file=', file.name, 'size=', file.size);
      const result = await api.skillImportFromArchive(file);

      console.log('[SkillImport] HTTP result:', JSON.stringify(result));
      if (result?.success && result.data) {
        const { installed, skipped, errors } = result.data;
        console.log('[SkillImport] installed:', installed, 'skipped:', skipped, 'errors:', errors);
        if (installed.length > 0) {
          console.log(`Installed ${installed.length} skills: ${installed.join(', ')}`);
        }
        if (skipped.length > 0) {
          console.warn(`Skipped ${skipped.length}: ${skipped.join(', ')}`);
        }
        if (errors.length > 0) {
          console.error(`Errors: ${errors.join('; ')}`);
        }
        refreshSkills();
      } else {
        console.warn('[SkillImport] result not success or no data:', result);
      }
    } catch (err) {
      console.error('Import from ZIP failed:', err);
    } finally {
      setImporting(false);
      if (zipInputRef.current) {
        zipInputRef.current.value = '';
      }
    }
  }, [refreshSkills]);

  // 刷新当前来源的技能列表
  const handleRefresh = () => {
    if (selectedSource.type === 'local') {
      refreshSkills();
    } else {
      loadRemoteSkills(selectedSource.serverId);
    }
  };

  const isLocal = selectedSource.type === 'local';

  return (
    <>
      {ConfirmDialogElement}
      <div className="flex h-full">
        {/* 左侧：技能列表 */}
        <div className="w-80 border-r border-border overflow-y-auto flex flex-col">
          <div className="p-4 border-b border-border shrink-0">
            <div className="flex items-center justify-between">
              {/* 来源选择下拉 */}
              <div className="relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSourceDropdown(!showSourceDropdown);
                  }}
                  className="flex items-center gap-1.5 text-sm font-semibold text-foreground hover:text-primary/80 transition-colors"
                >
                  {isLocal ? (
                    <HardDrive className="w-3.5 h-3.5" />
                  ) : (
                    <Server className="w-3.5 h-3.5" />
                  )}
                  <span className="max-w-[120px] truncate">
                    {isLocal ? t('Local') : selectedSource.serverName}
                  </span>
                  <span className="text-muted-foreground">({activeSkills.length})</span>
                  <ChevronDown
                    className={`w-3 h-3 text-muted-foreground transition-transform ${showSourceDropdown ? 'rotate-180' : ''}`}
                  />
                </button>

                {showSourceDropdown && (
                  <div
                    className="absolute top-full left-0 mt-1 w-60 bg-popover border border-border rounded-lg shadow-lg z-50 py-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* 本地选项 */}
                    <div
                      onClick={() => {
                        setSelectedSource({ type: 'local' });
                        setSelectedSkillId(null);
                        setShowSourceDropdown(false);
                      }}
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${isLocal ? 'bg-accent' : 'hover:bg-accent/50'}`}
                    >
                      <HardDrive className="w-4 h-4 text-muted-foreground" />
                      <div className="flex-1">
                        <span className="text-sm">{t('Local')}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{sortedSkills.length}</span>
                    </div>

                    {remoteServers.length > 0 && <div className="border-t border-border my-1" />}

                    {/* 远程服务器选项 */}
                    {remoteServers.map((server) => {
                      const isSelected =
                        selectedSource.type === 'remote' && selectedSource.serverId === server.id;
                      const skillCount = remoteSkills[server.id]?.length;
                      return (
                        <div
                          key={server.id}
                          onClick={() => {
                            setSelectedSource({
                              type: 'remote',
                              serverId: server.id,
                              serverName: server.name,
                            });
                            setSelectedSkillId(null);
                            setShowSourceDropdown(false);
                          }}
                          className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${isSelected ? 'bg-accent' : 'hover:bg-accent/50'}`}
                        >
                          <Server className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm truncate block">{server.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {server.status === 'connected' ? t('Connected') : t('Disconnected')}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {server.status === 'connected' && (
                              <span className="w-2 h-2 rounded-full bg-green-500" />
                            )}
                            {skillCount !== undefined && (
                              <span className="text-xs text-muted-foreground">{skillCount}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {remoteServers.length === 0 && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        {t('No remote servers')}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <div className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setImportMenuOpen(!importMenuOpen); }}
                    disabled={importing}
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 disabled:opacity-50"
                  >
                    {importing ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <PackagePlus className="w-3 h-3" />
                    )}
                    {t('Import')}
                  </button>
                  {importMenuOpen && (
                    <div className="absolute left-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg py-1 z-50 min-w-[160px]">
                      <button
                        onClick={handleImportFromZip}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent text-left"
                      >
                        <PackagePlus className="w-3 h-3" />
                        {t('From Archive File')}
                      </button>
                      {isElectron() && (
                        <button
                          onClick={handleImportFromFolder}
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent text-left"
                        >
                          <FolderInput className="w-3 h-3" />
                          {t('From Folder')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={handleRefresh}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
                >
                  <RefreshCw className="w-3 h-3" />
                  {t('Refresh')}
                </button>
              </div>
            </div>
          </div>

          {/* 技能列表内容 */}
          <div className="flex-1 divide-y divide-border">
            {/* 加载状态 */}
            {activeLoading && (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                <span className="mt-2 text-xs text-muted-foreground">
                  {t('Loading remote skills...')}
                </span>
              </div>
            )}

            {/* 错误状态 */}
            {activeError && !activeLoading && (
              <div className="p-3 mx-2 mt-2 text-xs text-red-400 bg-red-500/10 rounded">
                {activeError}
                <button onClick={handleRefresh} className="ml-2 underline hover:text-red-300">
                  {t('Retry')}
                </button>
              </div>
            )}

            {/* 空状态（远程） */}
            {!activeLoading && !activeError && activeSkills.length === 0 && !isLocal && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Server className="w-10 h-10 mb-3 opacity-50" />
                <p className="text-sm">{t('No skills on this server')}</p>
              </div>
            )}

            {/* 空状态（本地） */}
            {!activeLoading && !activeError && activeSkills.length === 0 && isLocal && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Book className="w-10 h-10 mb-3 opacity-50" />
                <p className="text-sm">{t('No skills installed')}</p>
                <p className="text-xs mt-1">
                  {t('Install skills from the market or create your own.')}
                </p>
              </div>
            )}

            {/* 技能卡片列表 */}
            {activeSkills.map((skill) => (
              <div
                key={skill.appId}
                onClick={() => { api.logUserAction('skill:select', skill.appId); setSelectedSkillId(skill.appId); }}
                className={`
                p-4 cursor-pointer transition-colors
                ${
                  selectedSkillId === skill.appId
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50'
                }
              `}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium truncate">{skill.spec.name}</h3>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {skill.spec.description}
                    </p>
                  </div>
                  {isLocal && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSkill(skill.appId, !skill.enabled);
                      }}
                      className="ml-2"
                    >
                      {skill.enabled ? (
                        <ToggleRight className="w-5 h-5 text-green-500" />
                      ) : (
                        <ToggleLeft className="w-5 h-5 text-muted-foreground" />
                      )}
                    </button>
                  )}
                </div>

                {/* 技能元数据 */}
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs text-muted-foreground">v{skill.spec.version}</span>
                  {skill.spec.trigger_command && (
                    <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                      {skill.spec.trigger_command}
                    </code>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 右侧：技能详情 + 文件浏览器 */}
        <div className="flex-1 flex">
          {/* 主内容区域 */}
          <div className={`flex-1 overflow-y-auto p-6 ${showFilesDrawer ? 'pr-0' : ''}`}>
            {selectedSkillId ? (
              (() => {
                const selectedSkill = activeSkills.find((s) => s.appId === selectedSkillId);
                if (!selectedSkill) {
                  // selectedSkillId references a skill no longer in the list (uninstalled, filter changed, etc.)
                  return (
                    <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                      <FileCode className="w-12 h-12 mb-4 opacity-50" />
                      <p>{t('Selected skill not found')}</p>
                    </div>
                  );
                }
                return (
                  <SkillDetail
                    skill={selectedSkill}
                    isRemote={!isLocal}
                    remoteServerName={
                      selectedSource.type === 'remote' ? selectedSource.serverName : undefined
                    }
                    onToggle={
                      isLocal
                        ? () => toggleSkill(selectedSkillId, !selectedSkill.enabled)
                        : undefined
                    }
                    onExport={isLocal ? (e) => handleExport(selectedSkillId, e) : undefined}
                    onUninstall={
                      isLocal
                        ? (e) => handleUninstall(selectedSkillId, e)
                        : selectedSource.type === 'remote'
                          ? () => handleRemoteUninstall(selectedSkillId)
                          : undefined
                    }
                    onOpenFiles={() => handleOpenFiles(selectedSkillId)}
                    hasGitHubSources={githubSources.length > 0}
                    githubSourcesList={githubSources}
                    onPushToGitHub={
                      isLocal
                        ? () => {
                            const firstSource = githubSources[0];
                            const repo = firstSource?.repos?.[0] || '';
                            setPushTargetRepo(repo);
                            setPushTargetSourceId(firstSource?.id || '');
                            setPushTargetPath('');
                            setShowPushModal(true);
                            if (repo) {
                              if (firstSource?.type === 'gitcode') {
                                loadGitCodeRepoDirectories(repo);
                              } else {
                                loadRepoDirectories(repo);
                              }
                            }
                          }
                        : undefined
                    }
                    onSyncToServer={
                      isLocal && remoteServers.length > 0
                        ? () => {
                            setSyncTargetServerId(null);
                            setSyncOutput('');
                            clearSyncState();
                            setShowSyncModal(true);
                          }
                        : undefined
                    }
                    syncLoading={syncLoading}
                    onSyncFromServer={
                      !isLocal && selectedSource.type === 'remote'
                        ? () => {
                            setSyncFromRemoteOutput('');
                            clearSyncFromRemoteState();
                            setShowSyncFromRemoteModal(true);
                          }
                        : undefined
                    }
                    syncFromRemoteLoading={syncFromRemoteLoading}
                    uninstallLoading={remoteUninstallLoading}
                  />
                );
              })()
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                <FileCode className="w-12 h-12 mb-4 opacity-50" />
                <p>{t('Select a skill to view details')}</p>
              </div>
            )}
          </div>

          {/* 文件抽屉 */}
          {showFilesDrawer && selectedSkillId && (
            <div
              className="border-l border-border flex flex-col relative"
              style={{ width: `${drawerWidth}px` }}
            >
              {/* 拖动调整宽度的手柄 */}
              <div
                ref={resizeRef}
                onMouseDown={handleMouseDown}
                className={`
                absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize z-10
                hover:bg-primary/50 transition-colors
                ${isResizing ? 'bg-primary' : 'bg-transparent'}
              `}
              >
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 hover:opacity-100 transition-opacity">
                  <GripVertical className="w-3 h-3 text-muted-foreground" />
                </div>
              </div>

              {/* 抽屉头部 */}
              <div className="flex items-center justify-between p-3 border-b border-border">
                <h3 className="text-sm font-medium text-foreground">{t('Skill Files')}</h3>
                <button onClick={handleCloseFiles} className="p-1 hover:bg-secondary rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* 内容区域：文件树 + 文件预览 */}
              <div className="flex-1 flex flex-col min-h-0">
                {/* 文件树 - 紧凑显示，只占需要的空间 */}
                <div className="shrink-0 max-h-[40%] overflow-y-auto p-2">
                  {loadingFiles ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : fileTree && fileTree.length > 0 ? (
                    <div className="space-y-1">
                      {fileTree.map((node) => (
                        <FileTreeNode
                          key={node.path}
                          node={node}
                          level={0}
                          selectedPath={selectedFilePath}
                          onSelect={(path, type) => {
                            if (type === 'file') {
                              loadFileContent(selectedSkillId, path);
                            }
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center py-4 text-muted-foreground">
                      <Folder className="w-5 h-5 mr-2 opacity-50" />
                      <span className="text-xs">{t('No files found')}</span>
                    </div>
                  )}
                </div>

                {/* 文件预览 - 占满剩余空间到底部 */}
                {selectedFilePath && fileContent !== null && (
                  <div className="border-t border-border flex flex-col min-h-0 flex-1">
                    <div className="flex items-center justify-between p-2 border-b border-border bg-secondary/50 shrink-0">
                      <span className="text-xs font-mono truncate">
                        {selectedFilePath.split('/').pop()}
                      </span>
                      <button
                        onClick={() => {
                          setSelectedFilePath(null);
                          setFileContent(null);
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {t('Close')}
                      </button>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto p-2">
                      <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                        {typeof fileContent === 'string'
                          ? fileContent.slice(0, 5000)
                          : 'No content'}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Hidden file input for Web mode archive import */}
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,.tar.gz,.tgz,.tar.bz2,.tar.xz"
        className="hidden"
        onChange={handleZipFileChange}
      />

      {/* Push to GitHub Modal */}
      {showPushModal && selectedSkillId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => {
              setShowPushModal(false);
              clearPushState();
            }}
          />
          <div className="relative bg-background border border-border rounded-xl shadow-xl w-[420px] p-6 space-y-4 z-10">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Github className="w-5 h-5" />
                {pushTargetSource?.type === 'gitcode' ? t('Push to GitCode') : t('Push to GitHub')}
              </h3>
              <button
                onClick={() => {
                  setShowPushModal(false);
                  clearPushState();
                }}
                className="p-1 hover:bg-secondary rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground">
              {t('Submit skill')}{' '}
              <span className="font-medium text-foreground">{selectedSkillId}</span>{' '}
              {isGitCodePush
                ? t('as a Merge Request to a repository.')
                : t('as a Pull Request to a repository.')}
            </p>

            {/* Target repo selector */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('Target Repository')}
              </label>
              {githubSources.length > 0 ? (
                <select
                  value={pushTargetSourceId}
                  onChange={(e) => {
                    const selectedSource = githubSources.find((s) => s.id === e.target.value);
                    const repo = selectedSource?.repos?.[0] || '';
                    setPushTargetSourceId(e.target.value);
                    setPushTargetRepo(repo);
                    setPushTargetPath('');
                    if (repo) {
                      if (selectedSource?.type === 'gitcode') {
                        loadGitCodeRepoDirectories(repo);
                      } else {
                        loadRepoDirectories(repo);
                      }
                    }
                  }}
                  className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground"
                >
                  {githubSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.type === 'gitcode' ? 'GitCode: ' : s.type === 'github' ? 'GitHub: ' : ''}
                      {s.repos?.[0] || s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-yellow-500">
                  {t('No GitHub sources configured. Add one in the Skill Market.')}
                </p>
              )}
            </div>

            {/* Target directory selector */}
            {pushTargetRepo && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">
                  {t('Target Directory')}
                </label>
                <div className="relative">
                  {repoDirsLoading && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  <input
                    type="text"
                    list="repo-dirs-list"
                    value={pushTargetPath}
                    onChange={(e) => setPushTargetPath(e.target.value)}
                    placeholder={repoDirs.length > 0 ? repoDirs[0] : 'e.g. Inference'}
                    className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground pr-8"
                  />
                  <datalist id="repo-dirs-list">
                    {repoDirs.map((dir) => (
                      <option key={dir} value={dir} />
                    ))}
                  </datalist>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('Leave empty for root, or type a directory name.')}
                </p>
              </div>
            )}

            {/* Upload path preview */}
            {pushTargetRepo && !pushResult && (
              <div className="p-2 bg-secondary/50 rounded text-xs font-mono text-muted-foreground">
                {pushTargetPath
                  ? `${pushTargetPath}/${selectedSkillId}/...`
                  : `${selectedSkillId}/...`}{' '}
                (all files in skill directory)
              </div>
            )}

            {/* Push result */}
            {pushResult?.prUrl && (
              <div className="p-3 bg-green-500/10 rounded-lg">
                <p className="text-sm text-green-500 font-medium mb-1">
                  {t('PR created successfully!')}
                </p>
                <a
                  href={pushResult.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
                >
                  <ExternalLink className="w-3 h-3" />
                  {pushResult.prUrl}
                </a>
                {pushResult.warning && (
                  <p className="text-xs text-yellow-500 mt-2">{pushResult.warning}</p>
                )}
              </div>
            )}

            {pushError && (
              <div className="p-3 bg-red-500/10 rounded-lg">
                <p className="text-sm text-red-500">{pushError}</p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => {
                  setShowPushModal(false);
                  clearPushState();
                }}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {pushResult ? t('Close') : t('Cancel')}
              </button>
              {!pushResult && (
                <button
                  onClick={async () => {
                    if (pushTargetRepo) {
                      if (isGitCodePush) {
                        const { pushSkillToGitCode } = useSkillStore.getState();
                        await pushSkillToGitCode(
                          selectedSkillId,
                          pushTargetRepo,
                          pushTargetPath || undefined,
                        );
                      } else {
                        await pushSkillToGitHub(
                          selectedSkillId,
                          pushTargetRepo,
                          pushTargetPath || undefined,
                        );
                      }
                    }
                  }}
                  disabled={pushLoading || !pushTargetRepo}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-500 text-white hover:bg-purple-600 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {pushLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {isGitCodePush ? t('Creating MR...') : t('Creating PR...')}
                    </>
                  ) : (
                    <>
                      <Github className="w-4 h-4" />
                      {isGitCodePush ? t('Create MR') : t('Create PR')}
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sync to Remote Server Modal */}
      {showSyncModal && selectedSkillId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => {
              setShowSyncModal(false);
              clearSyncState();
            }}
          />
          <div className="relative bg-background border border-border rounded-xl shadow-xl w-[420px] max-h-[70vh] flex flex-col z-10">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Upload className="w-5 h-5" />
                {t('Sync to Server')}
              </h3>
              <button
                onClick={() => {
                  setShowSyncModal(false);
                  clearSyncState();
                }}
                className="p-1 hover:bg-secondary rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="px-4 pt-3 text-sm text-muted-foreground">
              {t('Select a server to sync the skill to')}
            </p>

            <div className="p-4 space-y-2 overflow-y-auto flex-1">
              {remoteServers.map((server) => (
                <div
                  key={server.id}
                  onClick={() => setSyncTargetServerId(server.id)}
                  className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors border ${
                    syncTargetServerId === server.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-accent/50'
                  }`}
                >
                  <Server className="w-4 h-4 text-muted-foreground" />
                  <div className="flex-1">
                    <span className="text-sm font-medium text-foreground">{server.name}</span>
                    <span className="text-xs text-muted-foreground block">{server.status}</span>
                  </div>
                  {server.status === 'connected' && (
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                  )}
                </div>
              ))}
            </div>

            {/* Sync output */}
            {syncOutput && (
              <div className="border-t border-border p-3 max-h-32 overflow-y-auto">
                <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground">
                  {syncOutput}
                </pre>
              </div>
            )}

            {syncError && (
              <div className="px-4 py-2 text-xs text-red-400 bg-red-500/10">{syncError}</div>
            )}

            <div className="p-4 border-t border-border flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowSyncModal(false);
                  clearSyncState();
                }}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('Cancel')}
              </button>
              <button
                onClick={async () => {
                  if (!syncTargetServerId || !selectedSkillId) return;
                  setSyncOutput('');
                  const success = await syncSkillToRemote(selectedSkillId, syncTargetServerId);
                  if (success) {
                    loadRemoteSkills(syncTargetServerId);
                    setShowSyncModal(false);
                    setSyncTargetServerId(null);
                  }
                }}
                disabled={!syncTargetServerId || syncLoading}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {syncLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('Syncing...')}
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    {t('Sync')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sync from Remote Server Modal */}
      {showSyncFromRemoteModal && selectedSkillId && selectedSource.type === 'remote' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => {
              if (!syncFromRemoteLoading) {
                setShowSyncFromRemoteModal(false);
                clearSyncFromRemoteState();
              }
            }}
          />
          <div className="relative bg-background border border-border rounded-xl shadow-xl w-[420px] max-h-[70vh] flex flex-col z-10">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Download className="w-5 h-5" />
                {t('Download to Local')}
              </h3>
              {!syncFromRemoteLoading && (
                <button
                  onClick={() => {
                    setShowSyncFromRemoteModal(false);
                    clearSyncFromRemoteState();
                  }}
                  className="p-1 hover:bg-secondary rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <p className="px-4 pt-3 text-sm text-muted-foreground">
              {t('Download skill from remote server and install it locally.')}
            </p>

            {/* Download progress */}
            {syncFromRemoteLoading && (
              <div className="px-4 pt-3 space-y-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                  <span>{t('Connecting to remote server...')}</span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-400 rounded-full animate-pulse"
                    style={{ width: '60%' }}
                  />
                </div>
              </div>
            )}

            {syncFromRemoteOutput && (
              <div className="border-t border-border p-3 max-h-40 overflow-y-auto">
                <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground">
                  {syncFromRemoteOutput}
                </pre>
              </div>
            )}

            <div className="p-4 border-t border-border flex justify-end gap-2">
              {!syncFromRemoteLoading && (
                <button
                  onClick={() => {
                    setShowSyncFromRemoteModal(false);
                    clearSyncFromRemoteState();
                  }}
                  className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('Cancel')}
                </button>
              )}
              <button
                onClick={async () => {
                  setSyncFromRemoteOutput('');
                  const success = await syncSkillFromRemote(
                    selectedSkillId,
                    selectedSource.serverId,
                  );
                  if (success) {
                    setShowSyncFromRemoteModal(false);
                    refreshSkills();
                    setSelectedSource({ type: 'local' });
                  }
                }}
                disabled={syncFromRemoteLoading}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {syncFromRemoteLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('Downloading...')}
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    {t('Download to Local')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 技能详情组件
function SkillDetail({
  skill,
  isRemote,
  remoteServerName,
  onToggle,
  onExport,
  onUninstall,
  onOpenFiles,
  onPushToGitHub,
  hasGitHubSources,
  githubSourcesList,
  onSyncToServer,
  syncLoading,
  onSyncFromServer,
  syncFromRemoteLoading,
  uninstallLoading,
}: {
  skill: InstalledSkill;
  isRemote?: boolean;
  remoteServerName?: string;
  onToggle?: () => void;
  onExport?: (e: React.MouseEvent) => void;
  onUninstall?: (e?: React.MouseEvent) => void;
  onOpenFiles?: () => void;
  onPushToGitHub?: () => void;
  hasGitHubSources?: boolean;
  githubSourcesList?: SkillMarketSource[];
  onSyncToServer?: () => void;
  syncLoading?: boolean;
  onSyncFromServer?: () => void;
  syncFromRemoteLoading?: boolean;
  uninstallLoading?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="max-w-2xl space-y-6">
      {/* 头部 */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-xl font-semibold text-foreground">{skill.spec.name}</h2>
          {isRemote && remoteServerName && (
            <span className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded flex items-center gap-1">
              <Server className="w-3 h-3" />
              {remoteServerName}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{skill.spec.description}</p>
      </div>

      {/* 状态和版本 */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('Status')}:</span>
          <span
            className={`text-xs px-2 py-0.5 rounded ${skill.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'}`}
          >
            {skill.enabled ? t('Enabled') : t('Disabled')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('Version')}:</span>
          <span className="text-xs text-foreground">{skill.spec.version}</span>
        </div>
        {skill.spec.author && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('Author')}:</span>
            <span className="text-xs text-foreground">{skill.spec.author}</span>
          </div>
        )}
      </div>

      {/* 触发命令 */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{t('Trigger Command')}</h3>
        <div className="bg-secondary rounded-lg p-3 font-mono text-sm">
          {skill.spec.trigger_command || `/${skill.appId}`}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('Type this command in any conversation to use this skill.')}
        </p>
      </div>

      {/* 系统提示 */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{t('System Prompt')}</h3>
        <div className="bg-secondary rounded-lg p-4 text-sm font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
          {skill.spec.system_prompt}
        </div>
      </div>

      {/* 标签 */}
      {skill.spec.tags && skill.spec.tags.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">{t('Tags')}</h3>
          <div className="flex flex-wrap gap-2">
            {skill.spec.tags.map((tag: string) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 bg-accent text-accent-foreground rounded"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 文件浏览器按钮（本地技能） */}
      {!isRemote && onOpenFiles && (
        <div className="space-y-2">
          <button
            onClick={onOpenFiles}
            className="flex items-center gap-2 w-full px-4 py-2 bg-secondary/50 hover:bg-secondary text-secondary-foreground hover:text-foreground rounded-lg text-sm font-medium transition-colors"
          >
            <FolderOpen className="w-4 h-4" />
            {t('View Skill Files')}
            <ChevronRight className="w-4 h-4 ml-auto" />
          </button>
        </div>
      )}

      {/* 安装时间 */}
      {skill.installedAt && (
        <div className="text-xs text-muted-foreground">
          {t('Installed at')}: {new Date(skill.installedAt).toLocaleString()}
        </div>
      )}

      {/* 操作按钮（仅本地） */}
      {!isRemote && onToggle && onExport && onUninstall && (
        <div className="flex gap-2 pt-4 border-t border-border">
          <button
            onClick={onToggle}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
              ${
                skill.enabled
                  ? 'bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20'
                  : 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
              }
            `}
          >
            {skill.enabled ? (
              <ToggleLeft className="w-4 h-4" />
            ) : (
              <ToggleRight className="w-4 h-4" />
            )}
            {skill.enabled ? t('Disable') : t('Enable')}
          </button>

          <button
            onClick={onExport}
            className="flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-lg text-sm font-medium transition-colors"
          >
            <Download className="w-4 h-4" />
            {t('Export')}
          </button>

          {hasGitHubSources && onPushToGitHub && (
            <button
              onClick={onPushToGitHub}
              className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 rounded-lg text-sm font-medium transition-colors"
            >
              <Github className="w-4 h-4" />
              {(githubSourcesList?.length ?? 0) === 1
                ? githubSourcesList![0].type === 'gitcode'
                  ? t('Push to GitCode')
                  : t('Push to GitHub')
                : t('Push to Remote')}
            </button>
          )}

          {onSyncToServer && (
            <button
              onClick={onSyncToServer}
              disabled={syncLoading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {syncLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {syncLoading ? t('Syncing...') : t('Sync to Server')}
            </button>
          )}

          <button
            onClick={onUninstall}
            className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-sm font-medium transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {t('Uninstall')}
          </button>
        </div>
      )}

      {/* 远程只读提示 */}
      {isRemote && (
        <div className="pt-4 border-t border-border">
          {onUninstall && (
            <button
              onClick={onUninstall}
              disabled={uninstallLoading}
              className="flex items-center gap-2 w-full px-4 py-2 mt-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {uninstallLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              {uninstallLoading ? t('Uninstalling...') : t('Uninstall from Server')}
            </button>
          )}
          {onSyncFromServer && (
            <button
              onClick={onSyncFromServer}
              disabled={syncFromRemoteLoading}
              className="flex items-center gap-2 w-full px-4 py-2 mt-2 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              {syncFromRemoteLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {syncFromRemoteLoading ? t('Downloading...') : t('Download to Local')}
            </button>
          )}
          <button
            onClick={onOpenFiles}
            className="flex items-center gap-2 w-full px-4 py-2 mt-2 bg-secondary/50 hover:bg-secondary text-secondary-foreground hover:text-foreground rounded-lg text-sm font-medium transition-colors"
          >
            <FolderOpen className="w-4 h-4" />
            {t('View Skill Files')}
            <ChevronRight className="w-4 h-4 ml-auto" />
          </button>
        </div>
      )}
    </div>
  );
}

// 文件树节点组件
function FileTreeNode({
  node,
  level,
  selectedPath,
  onSelect,
}: {
  node: FileNode;
  level: number;
  selectedPath: string | null;
  onSelect: (path: string, type: 'file' | 'directory') => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isSelected = selectedPath === node.path;

  const handleToggle = () => {
    if (node.type === 'directory') {
      setIsExpanded(!isExpanded);
    } else {
      onSelect(node.path, node.type);
    }
  };

  return (
    <div>
      <div
        onClick={handleToggle}
        className={`
          flex items-center gap-2 px-2 py-1 cursor-pointer rounded text-sm
          ${isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-secondary/50'}
        `}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {node.type === 'directory' ? (
          <span
            className="transition-transform duration-200"
            style={{
              display: 'inline-block',
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          </span>
        ) : (
          <FileText className="w-3 h-3 text-muted-foreground" />
        )}
        <span className="truncate">{node.name}</span>
        {node.type === 'file' && node.size && (
          <span className="text-xs text-muted-foreground ml-auto">{formatSize(node.size)}</span>
        )}
      </div>

      {/* 子节点 */}
      {node.type === 'directory' && isExpanded && node.children && (
        <div className="mt-0.5">
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              level={level + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 格式化文件大小
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
