/**
 * Remote Servers Section Component
 * Manages remote SSH server configurations with terminal output
 */

import React from 'react';
import {
  Server,
  Plus,
  Trash2,
  ExternalLink,
  Plug,
  PowerOff,
  CheckCircle,
  XCircle,
  Loader2,
  Terminal,
  ChevronDown,
  ChevronRight,
  Edit,
  AlertTriangle,
  AlertCircle,
  Package,
  X,
} from 'lucide-react';
import { useTranslation } from '../../i18n';
import { api } from '../../api';
import { useConfirm } from '../ui/ConfirmDialog';
import { useChatStore } from '../../stores/chat.store';
import { useSpaceStore } from '../../stores/space.store';
import type { ModelOption } from '../../types';

interface TerminalEntry {
  id: string;
  timestamp: number;
  type: 'command' | 'output' | 'error' | 'success';
  content: string;
}

export function RemoteServersSection() {
  const { t } = useTranslation();
  const { confirm: confirmDialog, alert: alertDialog, ConfirmDialogElement } = useConfirm();
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const spaces = useSpaceStore((s) => s.spaces);
  const [servers, setServers] = React.useState<any[]>([]);
  // Active session warning dialog state
  const [activeSessionWarning, setActiveSessionWarning] = React.useState<{
    serverId: string;
    serverName: string;
    activeCount: number;
  } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [showAddDialog, setShowAddDialog] = React.useState(false);
  const [editingServer, setEditingServer] = React.useState<any | null>(null);
  const [formData, setFormData] = React.useState({
    name: '',
    host: '',
    sshPort: 22,
    username: '',
    password: '',
    claudeApiKey: '',
    claudeBaseUrl: '',
    claudeModel: '',
    aiSourceId: '',
  });
  const [aiSources, setAiSources] = React.useState<
    Array<{
      id: string;
      name: string;
      provider: string;
      apiUrl: string;
      apiKey?: string;
      model: string;
      authType: string;
      accessToken?: string;
    }>
  >([]);
  const [saving, setSaving] = React.useState(false);
  const [updatingAgent, setUpdatingAgent] = React.useState<string | null>(null);
  const [offlineBundleReady, setOfflineBundleReady] = React.useState(false);
  const [expandedServers, setExpandedServers] = React.useState<Set<string>>(new Set());
  // Add server progress tracking
  const [addProgress, setAddProgress] = React.useState<{
    serverName: string;
    stage: string;
    message: string;
    progress: number;
    error?: boolean;
  } | null>(null);
  // Ref to track which server ID is being added (to match progress events)
  const addingServerIdRef = React.useRef<string | null>(null);
  // Ref to track that we're in an active add operation (before we know the server ID)
  const isAddingRef = React.useRef(false);
  const [terminalEntries, setTerminalEntries] = React.useState<Map<string, TerminalEntry[]>>(() => {
    // Load from localStorage on init
    try {
      const saved = localStorage.getItem('remote-server-terminal-entries');
      if (saved) {
        const parsed = JSON.parse(saved);
        return new Map(Object.entries(parsed));
      }
    } catch (e) {
      console.error('[RemoteServersSection] Failed to load terminal entries from localStorage:', e);
    }
    return new Map();
  });
  // Track servers that user manually disconnected - don't auto-reconnect these
  const [manuallyDisconnected, setManuallyDisconnected] = React.useState<Set<string>>(new Set());
  // Batch operation state
  const [batchUpdating, setBatchUpdating] = React.useState(false);
  const [batchProgress, setBatchProgress] = React.useState<{
    current: number;
    total: number;
  } | null>(null);
  // Ref to track if we're awaiting an IPC call (so the event handler doesn't double-handle)
  const pendingUpdateRef = React.useRef<string | null>(null);
  // Ref to track which servers' results have already been handled (to prevent double dialogs)
  const handledUpdateRef = React.useRef<Set<string>>(new Set());
  // Ref to mirror servers state for use in event handlers without causing re-subscription
  const serversRef = React.useRef<any[]>([]);
  serversRef.current = servers;

  // State for expanded AI sources in the model picker (accordion)
  const [modelPickerExpanded, setModelPickerExpanded] = React.useState<string | null>(null);

  // Get available models for an AI source
  const getModelsForSource = (source: any): ModelOption[] => {
    // If source has its own available models (user fetched or configured), use them
    if (source.availableModels && source.availableModels.length > 0) {
      return source.availableModels;
    }
    // Fallback: return current model as single option
    if (source.model) {
      return [{ id: source.model, name: source.model }];
    }
    return [];
  };

  // Save terminal entries to localStorage whenever they change
  React.useEffect(() => {
    try {
      const obj = Object.fromEntries(terminalEntries);
      localStorage.setItem('remote-server-terminal-entries', JSON.stringify(obj));
    } catch (e) {
      console.error('[RemoteServersSection] Failed to save terminal entries to localStorage:', e);
    }
  }, [terminalEntries]);

  // Check if offline bundle is available for detected server architectures
  React.useEffect(() => {
    const checkOfflineBundle = async () => {
      try {
        // Collect unique architectures from connected servers
        const archSet = new Set<string>();
        for (const s of servers) {
          if (s.detectedArch) archSet.add(s.detectedArch);
        }
        // Default to x64 if no servers have detected arch yet
        if (archSet.size === 0) archSet.add('arm64');
        // Check if at least one required bundle is available
        let anyAvailable = false;
        for (const arch of archSet) {
          const result = await api.remoteServerCheckOfflineBundle(arch as 'x64' | 'arm64');
          if (result.success && (result.data as any)?.available) {
            anyAvailable = true;
            break;
          }
        }
        setOfflineBundleReady(anyAvailable);
      } catch {
        setOfflineBundleReady(false);
      }
    };
    checkOfflineBundle();
  }, [servers]);

  // Load servers on mount
  React.useEffect(() => {
    loadServers();
    loadAiSources();
  }, []);

  // On mount (and after servers load), check if any update was in progress
  // so the spinner can be restored after a tab switch
  React.useEffect(() => {
    if (servers.length === 0) return;

    const checkUpdateStates = async () => {
      for (const server of servers) {
        try {
          // Skip if already handled (e.g., by the event handler)
          if (handledUpdateRef.current.has(server.id)) continue;

          const result = await api.remoteServerGetUpdateStatus(server.id);
          if (result.success && result.data) {
            const state = result.data as {
              inProgress: boolean;
              completedAt?: number;
              success?: boolean;
              data?: any;
              error?: string;
            };

            if (state.inProgress) {
              // Update still running — restore the spinner
              console.log('[RemoteServersSection] Restoring update spinner for:', server.id);
              setUpdatingAgent(server.id);
              expandServer(server.id);
              addTerminalEntry(server.id, 'output', t('(Update in progress... view restored)'));
            } else if (state.completedAt) {
              // Update completed while we were away — acknowledge and show result
              handledUpdateRef.current.add(server.id);
              console.log(
                '[RemoteServersSection] Found completed update for:',
                server.id,
                state.success ? 'success' : 'failed',
              );
              await api.remoteServerAcknowledgeUpdate(server.id);
              setUpdatingAgent(null);

              if (state.success) {
                addTerminalEntry(server.id, 'success', t('Agent updated successfully!'));
                const vi = state.data as
                  | {
                      remoteVersion?: string;
                      localVersion?: string;
                      remoteBuildTime?: string;
                      localBuildTime?: string;
                    }
                  | undefined;
                let msg = t('{{name}} Agent updated successfully', { name: server.name });
                if (vi?.remoteVersion) {
                  msg += `\n\n${t('Local version')}: ${vi.localVersion || 'unknown'}${vi.localBuildTime ? `\n${t('Local build time')}: ${vi.localBuildTime}` : ''}`;
                  msg += `\n\n${t('Remote version')}: ${vi.remoteVersion}${vi.remoteBuildTime ? `\n${t('Remote build time')}: ${vi.remoteBuildTime}` : ''}`;
                }
                await alertDialog(msg);
              } else {
                addTerminalEntry(
                  server.id,
                  'error',
                  t('Update failed: {{error}}', { error: state.error || t('Unknown error') }),
                );
                await alertDialog(
                  t('{{name}} update failed: {{error}}', {
                    name: server.name,
                    error: state.error || t('Unknown error'),
                  }),
                );
              }

              await loadServers();
            }
          }
        } catch (err) {
          console.error('[RemoteServersSection] Failed to check update status:', server.id, err);
        }
      }
    };

    checkUpdateStates();
  }, [servers]);

  const loadAiSources = async () => {
    try {
      const result = await api.getConfig();
      if (result.success && result.data) {
        const config = result.data as any;
        const sources = config.aiSources?.sources || [];
        setAiSources(
          sources.map((s: any) => ({
            id: s.id,
            name: s.name,
            provider: s.provider,
            apiUrl: s.apiUrl,
            apiKey: s.apiKey,
            accessToken: s.accessToken,
            model: s.model,
            authType: s.authType,
            availableModels: s.availableModels,
          })),
        );
      }
    } catch (err) {
      console.error('[RemoteServersSection] Failed to load AI sources:', err);
    }
  };

  // Listen for command output, status change, and update-complete events from main process
  // NOTE: Uses empty dependency [] so listeners are registered exactly once on mount.
  // Uses refs (serversRef, pendingUpdateRef, handledUpdateRef) to access current state.
  React.useEffect(() => {
    const handleCommandOutput = (data: {
      serverId: string;
      type: 'command' | 'output' | 'error' | 'success';
      content: string;
      timestamp: number;
    }) => {
      addTerminalEntry(data.serverId, data.type, data.content);
    };

    // Listen for status change events to update UI in real-time
    const handleStatusChange = (data: { serverId: string; config: any }) => {
      console.log('[RemoteServersSection] Status change event:', data);
      setServers((prev) =>
        prev.map((s) => (s.id === data.serverId ? { ...s, ...data.config } : s)),
      );
    };

    // Listen for deploy progress events
    const handleDeployProgress = (data: {
      serverId: string;
      stage: string;
      message: string;
      progress?: number;
      timestamp: number;
    }) => {
      console.log('[RemoteServersSection] Deploy progress:', data);
      // Map stage to terminal type
      let type: TerminalEntry['type'] = 'output';
      if (data.stage === 'complete') type = 'success';
      else if (data.stage === 'error') type = 'error';
      else if (data.stage === 'command') type = 'command';

      // Add progress percentage if available
      const progressText = data.progress !== undefined ? ` [${data.progress}%]` : '';
      addTerminalEntry(data.serverId, type, `${data.message}${progressText}`);

      // Update addProgress if:
      // 1. This matches the server being added (known ID), OR
      // 2. We're in an active add operation (haven't got ID yet)
      const isMatch =
        addingServerIdRef.current === data.serverId ||
        (isAddingRef.current && !addingServerIdRef.current);
      if (isMatch) {
        // If this is the first event during an add, capture the server ID
        if (!addingServerIdRef.current) {
          addingServerIdRef.current = data.serverId;
        }

        // Look up server name from current servers list or from addProgress
        const server = serversRef.current.find((s) => s.id === data.serverId);
        const serverName = server?.name || addProgress?.serverName || data.serverId;
        setAddProgress({
          serverName,
          stage: data.stage,
          message: data.message,
          progress: data.progress ?? (data.stage === 'complete' ? 100 : 0),
          error: data.stage === 'error',
        });
        // Auto-expand the server to show terminal
        setExpandedServers((prev) => new Set([...prev, data.serverId]));
      }
    };

    // Handle update completion event (for when user is on a different tab)
    const handleUpdateComplete = async (data: {
      serverId: string;
      success: boolean;
      data?: any;
      error?: string;
    }) => {
      console.log('[RemoteServersSection] Update complete event:', data);

      // If we're still awaiting the IPC call for this server, let the promise handler show the dialog
      if (pendingUpdateRef.current === data.serverId) {
        return;
      }

      // Skip if already handled by the mount check
      if (handledUpdateRef.current.has(data.serverId)) {
        return;
      }
      handledUpdateRef.current.add(data.serverId);

      // Component was remounted (or user was on a different tab) — handle completion here
      setUpdatingAgent(null);
      await api.remoteServerAcknowledgeUpdate(data.serverId);

      const server = serversRef.current.find((s) => s.id === data.serverId);
      const serverName = server?.name || data.serverId;

      if (data.success) {
        addTerminalEntry(data.serverId, 'success', t('Agent updated successfully!'));
        const vi = data.data as
          | {
              remoteVersion?: string;
              localVersion?: string;
              remoteBuildTime?: string;
              localBuildTime?: string;
            }
          | undefined;
        let msg = t('{{name}} Agent updated successfully', { name: serverName });
        if (vi?.remoteVersion) {
          msg += `\n\n${t('Local version')}: ${vi.localVersion || 'unknown'}${vi.localBuildTime ? `\n${t('Local build time')}: ${vi.localBuildTime}` : ''}`;
          msg += `\n\n${t('Remote version')}: ${vi.remoteVersion}${vi.remoteBuildTime ? `\n${t('Remote build time')}: ${vi.remoteBuildTime}` : ''}`;
        }
        await alertDialog(msg);
      } else {
        addTerminalEntry(
          data.serverId,
          'error',
          t('Update failed: {{error}}', { error: data.error || t('Unknown error') }),
        );
        await alertDialog(
          t('{{name}} update failed: {{error}}', {
            name: serverName,
            error: data.error || t('Unknown error'),
          }),
        );
      }

      await loadServers();
    };

    const unsubCommandOutput = api.onRemoteServerCommandOutput(
      handleCommandOutput as (data: any) => void,
    );
    const unsubStatusChange = api.onRemoteServerStatusChange(
      handleStatusChange as (data: any) => void,
    );
    const unsubDeployProgress = api.onRemoteServerDeployProgress(
      handleDeployProgress as (data: any) => void,
    );
    const unsubUpdateComplete = api.onRemoteServerUpdateComplete(
      handleUpdateComplete as (data: any) => void,
    );

    return () => {
      unsubCommandOutput();
      unsubStatusChange();
      unsubDeployProgress();
      unsubUpdateComplete();
    };
  }, []);

  // Load servers
  const loadServers = async () => {
    setLoading(true);
    try {
      console.log('[RemoteServersSection] Loading servers...');
      const result = await api.remoteServerList();
      console.log('[RemoteServersSection] Load result:', result);
      console.log('[RemoteServersSection] Load result data:', JSON.stringify(result.data));
      if (result.success && result.data) {
        setServers(result.data);

        // Auto-connect disconnected servers (except those manually disconnected by user,
        // and those with auth/connection errors that would just fail again)
        setManuallyDisconnected((prev) => {
          const serversToAutoConnect = result.data.filter(
            (s: any) => s.status === 'disconnected' && !prev.has(s.id),
          );

          if (serversToAutoConnect.length > 0) {
            console.log(
              '[RemoteServersSection] Auto-connecting servers (excluding manually disconnected):',
              serversToAutoConnect.map((s: any) => s.name),
            );

            // Auto-connect in background without blocking UI
            serversToAutoConnect.forEach((server: any) => {
              api.remoteServerConnect(server.id).catch((err) => {
                console.error(
                  '[RemoteServersSection] Failed to auto-connect server:',
                  server.id,
                  err,
                );
              });
            });
          }

          return prev; // Don't modify the set
        });
      } else {
        console.error('[RemoteServersSection] Failed to load servers:', result.error);
      }
    } catch (error) {
      console.error('[RemoteServersSection] Error loading servers:', error);
    } finally {
      setLoading(false);
    }
  };

  // Add terminal entry for a specific server
  const addTerminalEntry = (serverId: string, type: TerminalEntry['type'], content: string) => {
    const entry: TerminalEntry = {
      id: `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      type,
      content,
    };
    setTerminalEntries((prev) => {
      const newMap = new Map(prev);
      const existing = newMap.get(serverId) || [];
      newMap.set(serverId, [...existing, entry].slice(-50)); // Keep last 50 entries
      return newMap;
    });
  };

  // Clear terminal for a server
  const clearTerminal = (serverId: string) => {
    setTerminalEntries((prev) => {
      const newMap = new Map(prev);
      newMap.delete(serverId);
      return newMap;
    });
  };

  // Toggle server expansion
  const toggleExpand = (serverId: string) => {
    setExpandedServers((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(serverId)) {
        newSet.delete(serverId);
      } else {
        newSet.add(serverId);
      }
      return newSet;
    });
  };

  // Expand server card
  const expandServer = (serverId: string) => {
    setExpandedServers((prev) => new Set([...prev, serverId]));
  };

  const handleAddServer = async () => {
    if (saving) return;

    // Validate: AI source must be configured
    if (!formData.aiSourceId) {
      alert(t('Please select an AI model service'));
      return;
    }

    console.log('[RemoteServersSection] Add server clicked, formData:', formData);

    setSaving(true);
    isAddingRef.current = true;
    setAddProgress({
      serverName: formData.name,
      stage: 'add',
      message: 'Adding server...',
      progress: 5,
    });

    try {
      const selectedSource = aiSources.find((s) => s.id === formData.aiSourceId);
      const serverInput = {
        name: formData.name,
        ssh: {
          host: formData.host,
          port: formData.sshPort,
          username: formData.username,
          password: formData.password,
        },
        aiSourceId: formData.aiSourceId || undefined,
        claudeApiKey: selectedSource
          ? selectedSource.authType === 'api-key'
            ? selectedSource.apiKey || ''
            : selectedSource.accessToken || ''
          : undefined,
        claudeBaseUrl: selectedSource?.apiUrl || undefined,
        claudeModel: selectedSource?.model || undefined,
      };

      const result = await api.remoteServerAdd(serverInput);
      console.log('[RemoteServersSection] Add result:', result);
      if (result.success && result.data) {
        // Reload servers to get full server data (including detection results)
        await loadServers();

        // If add was partial (SSH connection failed), show error and stop — do NOT retry
        if (result.data.partial) {
          const isAuthError = result.data.authError === true;
          addTerminalEntry(
            result.data.id,
            'error',
            isAuthError
              ? t('Authentication failed: {{error}}. Please check your password and retry.', {
                  error: result.data.error || '',
                })
              : t('Connection failed: {{error}}', { error: result.data.error || '' }),
          );
          return;
        }

        // Auto-connect the newly added server
        console.log('[RemoteServersSection] Auto-connecting newly added server:', result.data.id);
        await api.remoteServerConnect(result.data.id);

        // Reload servers to update connection status
        await new Promise((resolve) => setTimeout(resolve, 500));
        await loadServers();
      } else {
        console.error('[RemoteServersSection] Add failed:', result.error);
        setAddProgress({
          serverName: formData.name,
          stage: 'error',
          message: result.error || t('Failed to add server'),
          progress: 0,
          error: true,
        });
        // Stay in dialog showing error, user clicks Cancel to dismiss
        return;
      }
    } catch (error) {
      console.error('[RemoteServersSection] Add error:', error);
      setAddProgress((prev) =>
        prev
          ? {
              ...prev,
              stage: 'error',
              message: t('Failed to add server'),
              progress: 0,
              error: true,
            }
          : null,
      );
      return;
    } finally {
      setSaving(false);
      isAddingRef.current = false;
      addingServerIdRef.current = null;
      setAddProgress(null);
      setShowAddDialog(false);
      setFormData({
        name: '',
        host: '',
        sshPort: 22,
        username: '',
        password: '',
        claudeApiKey: '',
        claudeBaseUrl: '',
        claudeModel: '',
        aiSourceId: '',
      });
    }
  };

  // Open edit modal with server data
  const openEditModal = (server: any) => {
    loadAiSources();
    setEditingServer(server);
    setModelPickerExpanded(null);
    setFormData({
      name: server.name || '',
      host: server.host || '',
      sshPort: server.sshPort || 22,
      username: server.username || '',
      password: server.password ? '••••••••••' : '', // Placeholder dots if password exists
      claudeApiKey: server.claudeApiKey || '',
      claudeBaseUrl: server.claudeBaseUrl || '',
      claudeModel: server.claudeModel || '',
      aiSourceId: server.aiSourceId || '',
    });
  };

  // Handle edit server
  const handleEditServer = async () => {
    if (!editingServer || saving) return;

    // Validate: AI source must be configured
    if (!formData.aiSourceId) {
      alert(t('Please select an AI model service'));
      return;
    }

    console.log('[RemoteServersSection] Edit server:', editingServer.id, 'formData:', formData);

    setSaving(true);
    try {
      const selectedSource = aiSources.find((s) => s.id === formData.aiSourceId);
      const serverInput = {
        id: editingServer.id,
        name: formData.name,
        ssh: {
          host: formData.host,
          port: formData.sshPort,
          username: formData.username,
          password:
            formData.password && formData.password !== '••••••••••' ? formData.password : undefined, // Keep unchanged if placeholder
        },
        aiSourceId: formData.aiSourceId || undefined,
        claudeApiKey: selectedSource
          ? selectedSource.authType === 'api-key'
            ? selectedSource.apiKey || ''
            : selectedSource.accessToken || ''
          : undefined,
        claudeBaseUrl: selectedSource?.apiUrl || undefined,
        claudeModel: selectedSource?.model || undefined,
      };

      const result = await api.updateRemoteServer(serverInput as any);
      console.log('[RemoteServersSection] Edit result:', result);
      if (result.success) {
        setEditingServer(null);
        setFormData({
          name: '',
          host: '',
          sshPort: 22,
          username: '',
          password: '',
          claudeApiKey: '',
          claudeBaseUrl: '',
          claudeModel: '',
          aiSourceId: '',
        });
        await loadServers();
      } else {
        console.error('[RemoteServersSection] Edit failed:', result.error);
        await alertDialog(result.error || t('Failed to update server'));
      }
    } catch (error) {
      console.error('[RemoteServersSection] Edit error:', error);
      await alertDialog(t('Failed to update server'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteServer = async (serverId: string) => {
    // Check if any remote spaces reference this server
    const spacesResult = await api.listSpaces();
    if (spacesResult.success && spacesResult.data) {
      const referencedSpaces = (spacesResult.data as any[]).filter(
        (s) => s.claudeSource === 'remote' && s.remoteServerId === serverId,
      );
      if (referencedSpaces.length > 0) {
        const names = referencedSpaces.map((s) => s.name).join('、');
        const warnMsg =
          t(
            'The following remote spaces are using this server. Deleting it will break these spaces: {{names}}',
            { names },
          ) +
          '\n\n' +
          t('Are you sure you want to delete?');
        if (!(await confirmDialog(warnMsg))) return;
      } else {
        if (!(await confirmDialog(t('Are you sure you want to delete this server?')))) return;
      }
    } else {
      // Can't check — proceed anyway
      if (!(await confirmDialog(t('Are you sure you want to delete this server?')))) return;
    }
    try {
      const result = await api.remoteServerDelete(serverId);
      if (result.success) {
        await loadServers();
      }
    } catch (error) {
      console.error('Failed to delete server:', error);
    }
  };

  const handleConnectServer = async (serverId: string) => {
    console.log('[RemoteServersSection] handleConnectServer called for:', serverId);
    // User manually connected - remove from manually disconnected set
    setManuallyDisconnected((prev) => {
      const newSet = new Set(prev);
      newSet.delete(serverId);
      return newSet;
    });
    try {
      const result = await api.remoteServerConnect(serverId);
      console.log('[RemoteServersSection] Connect result:', result);
      if (result.success) {
        // The status will be updated via the status-change event
        // No need to reload servers - status-change event will update UI
      } else {
        await alertDialog(result.error || t('Failed to connect'));
      }
    } catch (error) {
      console.error('[RemoteServersSection] Failed to connect server:', error);
      await alertDialog(t('Failed to connect'));
    }
  };

  const handleDisconnectServer = async (serverId: string) => {
    console.log('[RemoteServersSection] handleDisconnectServer called for:', serverId);
    // User manually disconnected - add to manually disconnected set
    setManuallyDisconnected((prev) => new Set(prev).add(serverId));
    try {
      const result = await api.remoteServerDisconnect(serverId);
      console.log('[RemoteServersSection] Disconnect result:', result);
      // The status will be updated via the status-change event
      // No need to reload servers - status-change event will update UI
    } catch (error) {
      console.error('[RemoteServersSection] Failed to disconnect server:', error);
    }
  };

  // Check if any remote spaces linked to a server have active (generating) sessions
  const getActiveSessionCount = (serverId: string): number => {
    const relatedSpaces = spaces.filter((s) => s.remoteServerId === serverId);
    let count = 0;
    for (const space of relatedSpaces) {
      const spaceSessions = useChatStore.getState().spaceStates.get(space.id);
      if (!spaceSessions) continue;
      for (const conv of spaceSessions.conversations) {
        const session = useChatStore.getState().sessions.get(conv.id);
        if (session?.isGenerating && !session.isStopping) count++;
      }
    }
    return count;
  };

  // Force stop all active sessions for a given server's remote spaces
  const forceStopServerSessions = async (serverId: string): Promise<void> => {
    const relatedSpaces = spaces.filter((s) => s.remoteServerId === serverId);
    for (const space of relatedSpaces) {
      const spaceSessions = useChatStore.getState().spaceStates.get(space.id);
      if (!spaceSessions) continue;
      for (const conv of spaceSessions.conversations) {
        const session = useChatStore.getState().sessions.get(conv.id);
        if (session?.isGenerating && !session.isStopping) {
          try {
            await stopGeneration(conv.id);
          } catch (e) {
            console.warn(`[RemoteServersSection] Failed to stop session ${conv.id}:`, e);
          }
        }
      }
    }
  };

  // Update agent code to latest version
  // Returns true if update succeeded, false if failed
  const handleUpdateAgent = async (
    serverId: string,
    skipConfirm?: boolean,
    forceStop?: boolean,
  ): Promise<boolean> => {
    // Pre-check: scan for active sessions related to this server
    if (!skipConfirm && !forceStop) {
      const activeCount = getActiveSessionCount(serverId);
      if (activeCount > 0) {
        const server = servers.find((s) => s.id === serverId);
        setActiveSessionWarning({
          serverId,
          serverName: server?.name || serverId,
          activeCount,
        });
        return false;
      }
    }

    // If force stopping, stop all active sessions first
    if (forceStop) {
      setActiveSessionWarning(null);
      await forceStopServerSessions(serverId);
      // Brief pause to let sessions clean up
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (
      !skipConfirm &&
      !forceStop &&
      !(await confirmDialog(
        t('Update remote agent to latest version? This will restart the agent service.'),
      ))
    )
      return true;
    setUpdatingAgent(serverId);
    pendingUpdateRef.current = serverId;
    expandServer(serverId);
    // Clear terminal only when starting a new update (as requested by user)
    clearTerminal(serverId);

    console.log('[RemoteServersSection] Updating agent for server:', serverId);
    addTerminalEntry(serverId, 'command', '=== Updating remote agent to latest version ===');
    try {
      const result = await api.remoteServerUpdateAgent(serverId);
      console.log('[RemoteServersSection] Update result:', result);
      // Acknowledge the update in main process (clear stored state)
      try {
        await api.remoteServerAcknowledgeUpdate(serverId);
      } catch {}
      if (result.success) {
        // Show version info if available
        const versionInfo = result.data as
          | {
              remoteVersion?: string;
              remoteBuildTime?: string;
              localVersion?: string;
              localBuildTime?: string;
            }
          | undefined;
        if (versionInfo?.remoteVersion) {
          addTerminalEntry(serverId, 'success', `Agent updated successfully!`);
          addTerminalEntry(
            serverId,
            'output',
            `Local version: ${versionInfo.localVersion || 'unknown'}${versionInfo.localBuildTime ? ` (Built: ${versionInfo.localBuildTime})` : ''}`,
          );
          addTerminalEntry(
            serverId,
            'output',
            `Remote version: ${versionInfo.remoteVersion}${versionInfo.remoteBuildTime ? ` (Built: ${versionInfo.remoteBuildTime})` : ''}`,
          );

          // Only show alert for single (non-batch) updates
          if (!skipConfirm) {
            const alertMessage = `${t('Agent updated successfully')}\n\n${t('Local version')}: ${versionInfo.localVersion || 'unknown'}${versionInfo.localBuildTime ? `\n${t('Local build time')}: ${versionInfo.localBuildTime}` : ''}\n\n${t('Remote version')}: ${versionInfo.remoteVersion}${versionInfo.remoteBuildTime ? `\n${t('Remote build time')}: ${versionInfo.remoteBuildTime}` : ''}`;
            await alertDialog(alertMessage);
          }
        } else {
          addTerminalEntry(serverId, 'success', t('Agent updated and restarted successfully!'));
          if (!skipConfirm) {
            await alertDialog(t('Agent updated successfully'));
          }
        }
        await loadServers();
        return true;
      } else {
        addTerminalEntry(serverId, 'error', `Update failed: ${result.error}`);
        if (!skipConfirm) {
          await alertDialog(result.error || t('Failed to update agent'));
        }
        return false;
      }
    } catch (error) {
      addTerminalEntry(serverId, 'error', `Error updating agent: ${error}`);
      console.error('[RemoteServersSection] Update agent error:', error);
      if (!skipConfirm) {
        await alertDialog(t('Failed to update agent'));
      }
      return false;
    } finally {
      pendingUpdateRef.current = null;
      setUpdatingAgent(null);
    }
  };

  const handleDeployOffline = async (
    serverId: string,
    options?: { skipSpinner?: boolean; skipAlert?: boolean },
  ): Promise<boolean> => {
    if (!options?.skipSpinner) {
      setUpdatingAgent(serverId);
      pendingUpdateRef.current = serverId;
    }
    expandServer(serverId);
    clearTerminal(serverId);

    // Architecture is auto-detected by the backend (no manual selection needed)
    const server = servers.find((s) => s.id === serverId);
    const archDisplay = server?.detectedArch ?? 'auto';

    addTerminalEntry(serverId, 'command', t('=== Offline deploying (arch: {{arch}}) ===', { arch: archDisplay }));

    try {
      const result = await api.remoteServerDeployOffline(serverId);
      console.log('[RemoteServersSection] Offline deploy result:', result);
      try {
        await api.remoteServerAcknowledgeUpdate(serverId);
      } catch {}

      if (result.success) {
        addTerminalEntry(serverId, 'success', t('Offline deploy completed!'));
        if (!options?.skipAlert) {
          await alertDialog(t('Agent deployed offline successfully'));
        }
        await loadServers();
        return true;
      } else {
        addTerminalEntry(serverId, 'error', t('Offline deploy failed: {{error}}', { error: result.error }));
        if (!options?.skipAlert) {
          await alertDialog(result.error || t('Failed to deploy agent offline'));
        }
        return false;
      }
    } catch (error) {
      addTerminalEntry(serverId, 'error', `Error: ${error}`);
      console.error('[RemoteServersSection] Offline deploy error:', error);
      if (!options?.skipAlert) {
        await alertDialog(t('Failed to deploy agent offline'));
      }
      return false;
    } finally {
      if (!options?.skipSpinner) {
        pendingUpdateRef.current = null;
        setUpdatingAgent(null);
      }
    }
  };

  const handleDeploy = async (serverId: string): Promise<boolean> => {
    return handleDeployOffline(serverId);
  };

  // Cancel an in-flight deploy/update operation
  const handleCancelOperation = async (serverId: string) => {
    await api.remoteServerCancelOperation(serverId);
    setUpdatingAgent(null);
  };

  // Batch offline deploy all servers
  const handleBatchUpdate = async () => {
    if (servers.length === 0) return;
    if (
      !(await confirmDialog(
        t('Batch offline deploy all servers? This will deploy the latest agent bundle to all servers.'),
      ))
    )
      return;
    setBatchUpdating(true);
    // Expand all servers to show terminal output
    setExpandedServers((prev) => new Set([...prev, ...servers.map((s) => s.id)]));
    const total = servers.length;
    setBatchProgress({ current: 0, total });
    let completed = 0;
    let succeeded = 0;

    await Promise.allSettled(
      servers.map((server) =>
        handleDeployOffline(server.id, { skipSpinner: true, skipAlert: true })
          .then((ok) => {
            if (ok) succeeded++;
          })
          .finally(() => {
            completed++;
            setBatchProgress({ current: completed, total });
          }),
      ),
    );

    const failed = total - succeeded;
    setBatchProgress(null);
    setBatchUpdating(false);
    await alertDialog(
      t('Batch deploy completed: {{succeeded}}/{{total}} succeeded{{failed}}', {
        succeeded,
        total,
        failed: failed > 0 ? t(', {{count}} failed', { count: failed }) : '',
      }),
    );
    await loadServers();
  };

  const getAgentStatusBadge = (server: any) => {
    const badges: React.ReactNode[] = [];

    // SDK badge
    if (server.sdkInstalled) {
      badges.push(
        <span
          key="sdk"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-green-500/10 text-green-600 text-xs rounded-full"
        >
          <CheckCircle className="w-3 h-3" />
          <span>
            {t('SDK')} {server.sdkVersion}
          </span>
        </span>,
      );
    } else if (server.sdkVersionMismatch) {
      badges.push(
        <span
          key="sdk-mismatch"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/10 text-amber-600 text-xs rounded-full"
        >
          <AlertTriangle className="w-3 h-3" />
          <span>
            {t('SDK')} {server.sdkVersion} (need 0.2.104)
          </span>
        </span>,
      );
    } else if (server.status === 'connected' || server.status === 'deploying') {
      badges.push(
        <span
          key="sdk-missing"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-red-500/10 text-red-600 text-xs rounded-full"
        >
          <XCircle className="w-3 h-3" />
          <span>{t('SDK Not Installed')}</span>
        </span>,
      );
    }

    // Remote Bot proxy running badge — show when detection has run (server has assignedPort)
    if (server.proxyRunning === true) {
      badges.push(
        <span
          key="proxy"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-green-500/10 text-green-600 text-xs rounded-full"
        >
          <CheckCircle className="w-3 h-3" />
          <span>{t('Bot Proxy OK')}</span>
        </span>,
      );
    } else if (server.assignedPort && server.status === 'connected') {
      badges.push(
        <span
          key="proxy-stopped"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-red-500/10 text-red-600 text-xs rounded-full"
        >
          <XCircle className="w-3 h-3" />
          <span>{t('Bot Proxy Stopped')}</span>
        </span>,
      );
    }

    return <div className="flex flex-wrap gap-1.5">{badges}</div>;
  };

  return (
    <>
      {ConfirmDialogElement}
      {/* Active session warning dialog */}
      {activeSessionWarning && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
          onClick={() => setActiveSessionWarning(null)}
        >
          <div
            className="relative w-full max-w-md mx-4 bg-background border border-border rounded-xl shadow-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="text-sm font-semibold">{t('Active Sessions Detected')}</h3>
                <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                  {t(
                    '{{serverName}} has {{count}} active session(s). Updating the agent will interrupt them and may cause connection errors.',
                    {
                      serverName: activeSessionWarning.serverName,
                      count: activeSessionWarning.activeCount,
                    },
                  )}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setActiveSessionWarning(null)}
                className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
              >
                {t('Cancel')}
              </button>
              <button
                onClick={() => handleUpdateAgent(activeSessionWarning.serverId, false, true)}
                className="px-4 py-2 text-sm rounded-lg bg-yellow-600 text-white hover:bg-yellow-700 transition-colors"
              >
                {t('Force Stop & Update')}
              </button>
            </div>
          </div>
        </div>
      )}
      <section id="remote-servers" className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold">{t('Remote Server Management')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('Manage and connect to remote SSH servers')}
            </p>
            {batchProgress && (
              <p className="text-xs text-muted-foreground mt-1">
                <Loader2 className="w-3 h-3 inline animate-spin mr-1" />
                {t('Updating agents... {{current}}/{{total}}', {
                  current: batchProgress.current,
                  total: batchProgress.total,
                })}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Auto-detected architecture indicator (offline mode only) */}

            {servers.length > 0 && offlineBundleReady && (
              <button
                onClick={handleBatchUpdate}
                disabled={batchUpdating}
                className="px-4 py-2 bg-green-600 text-white rounded-lg flex items-center gap-2 hover:bg-green-700 transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {batchUpdating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Package className="w-4 h-4" />
                )}
                {t('Batch Deploy')}
              </button>
            )}

            <button
              onClick={() => {
                loadAiSources();
                setShowAddDialog(true);
              }}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg flex items-center gap-2 hover:bg-primary/90 transition-colors whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              {t('Add Server')}
            </button>
          </div>
        </div>

        {/* Servers List */}
        {loading ? (
          <div className="text-center py-12">
            <div className="inline-block w-8 h-8 border-2 border-primary/20 rounded-full animate-spin"></div>
          </div>
        ) : servers.length === 0 ? (
          <div className="text-center py-12">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <Plug className="w-12 h-12" />
              <p>{t('No remote servers configured')}</p>
              <p className="text-sm">{t('Add a server to get started')}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {servers.map((server: any) => {
              const isExpanded = expandedServers.has(server.id);
              const entries = terminalEntries.get(server.id) || [];

              return (
                <div key={server.id} className="border border-border rounded-lg overflow-hidden">
                  {/* Server Card Header */}
                  <div className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => toggleExpand(server.id)}
                          className="p-1 hover:bg-secondary/10 rounded-lg transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          )}
                        </button>
                        <div>
                          <h3 className="font-semibold">{server.name || t('Unknown')}</h3>
                          <p className="text-sm text-muted-foreground">
                            {server.host || ''}
                            {server.assignedPort ? `:${server.assignedPort}` : ''}
                          </p>
                          {server.clientId && (
                            <span className="inline-flex items-center text-xs text-muted-foreground/60 font-mono mt-0.5">
                              {t('Client ID')}: {server.clientId}
                            </span>
                          )}
                          {server.aiSourceId &&
                            (() => {
                              const source = aiSources.find((s) => s.id === server.aiSourceId);
                              const modelId = server.claudeModel || source?.model || '';
                              const modelDisplayName = modelId && source
                                ? source.availableModels?.find((m) => m.id === modelId)?.name || modelId
                                : modelId;
                              return source && modelId ? (
                                <span className="inline-flex items-center text-xs text-muted-foreground mt-0.5">
                                  {source.provider} / {modelDisplayName}
                                </span>
                              ) : null;
                            })()}
                          {!server.aiSourceId && server.claudeModel && (
                            <span className="inline-flex items-center text-xs text-muted-foreground mt-0.5">
                              {server.claudeModel}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {getAgentStatusBadge(server)}
                        <span className="text-xs text-muted-foreground">
                          {server.status || 'disconnected'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between mt-3">
                      <div className="flex items-center gap-2">
                        {server.status === 'connected' ? (
                          <button
                            onClick={() => handleDisconnectServer(server.id)}
                            className="p-1.5 hover:bg-destructive/10 text-destructive hover:text-destructive rounded-lg transition-colors"
                            title={t('Disconnect')}
                          >
                            <PowerOff className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => handleConnectServer(server.id)}
                            className="p-1.5 hover:bg-primary/10 text-primary hover:text-primary-foreground rounded-lg transition-colors"
                            title={t('Connect')}
                          >
                            <Plug className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleDeploy(server.id)}
                          disabled={
                            updatingAgent === server.id ||
                            batchUpdating ||
                            !offlineBundleReady
                          }
                          className="p-1.5 hover:bg-green-500/10 text-green-600 rounded-lg transition-colors disabled:opacity-50"
                          title={
                            offlineBundleReady ? t('Deploy Agent (Offline)') : t('Offline bundle not built')
                          }
                        >
                          {updatingAgent === server.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Package className="w-4 h-4" />
                          )}
                        </button>
                        {updatingAgent === server.id && (
                          <button
                            onClick={() => handleCancelOperation(server.id)}
                            className="p-1.5 hover:bg-red-500/10 text-red-500 rounded-lg transition-colors"
                            title={t('Cancel Operation')}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => openEditModal(server)}
                          className="p-1.5 hover:bg-secondary/10 rounded-lg transition-colors"
                          title={t('Edit Server')}
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteServer(server.id)}
                          className="p-1.5 hover:bg-destructive/10 text-destructive hover:text-destructive rounded-lg transition-colors"
                          title={t('Delete')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expandable Terminal Section */}
                  {isExpanded && (
                    <div className="border-t border-border">
                      <div className="bg-neutral-950 p-4 max-h-80 overflow-auto">
                        {entries.length === 0 ? (
                          <div className="flex items-center justify-center h-full text-muted-foreground">
                            <p className="text-sm">{t('No output')}</p>
                          </div>
                        ) : (
                          <div className="space-y-2 font-mono text-sm">
                            {entries.map((entry) => (
                              <div key={entry.id} className="flex gap-2">
                                <span className="text-muted-foreground/50 text-xs shrink-0">
                                  {new Date(entry.timestamp).toLocaleTimeString()}
                                </span>
                                {entry.type === 'command' && (
                                  <span className="text-primary font-semibold">
                                    $ {entry.content}
                                  </span>
                                )}
                                {entry.type === 'output' && (
                                  <span className="text-green-400">{entry.content}</span>
                                )}
                                {entry.type === 'error' && (
                                  <span className="text-red-400 flex items-start gap-1.5">
                                    <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                    <span>{entry.content}</span>
                                  </span>
                                )}
                                {entry.type === 'success' && (
                                  <span className="text-green-500 flex items-start gap-1.5">
                                    <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
                                    <span>{entry.content}</span>
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Add/Edit Server Dialog */}
        {(showAddDialog || editingServer) && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
            <div
              className="bg-card border border-border rounded-xl p-6 w-full max-w-md relative z-[101]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Progress view (shown during add server operation) */}
              {saving && !editingServer && addProgress ? (
                <div>
                  <h3 className="text-lg font-semibold mb-4">{t('Adding Remote Server')}</h3>
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      {addProgress.stage === 'complete' ? (
                        <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />
                      ) : addProgress.error ? (
                        <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                      ) : (
                        <Loader2 className="w-5 h-5 text-primary animate-spin flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{addProgress.serverName}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {addProgress.message}
                        </p>
                      </div>
                      {addProgress.progress > 0 && (
                        <span className="text-xs text-muted-foreground flex-shrink-0">
                          {addProgress.progress}%
                        </span>
                      )}
                    </div>
                    {/* Progress bar */}
                    {addProgress.stage !== 'complete' && !addProgress.error && (
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
                          style={{ width: `${Math.max(addProgress.progress, 2)}%` }}
                        />
                      </div>
                    )}
                    {/* Error message */}
                    {addProgress.error && (
                      <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                        <p className="text-sm text-red-500">{addProgress.message}</p>
                      </div>
                    )}
                    {/* Complete message */}
                    {addProgress.stage === 'complete' && (
                      <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                        <p className="text-sm text-green-500">{addProgress.message}</p>
                      </div>
                    )}
                  </div>
                  {/* Only show Close button when complete or error */}
                  {(addProgress.stage === 'complete' || addProgress.error) && (
                    <div className="flex justify-end mt-6">
                      <button
                        onClick={() => {
                          setSaving(false);
                          isAddingRef.current = false;
                          addingServerIdRef.current = null;
                          setAddProgress(null);
                          setShowAddDialog(false);
                          setFormData({
                            name: '',
                            host: '',
                            sshPort: 22,
                            username: '',
                            password: '',
                            claudeApiKey: '',
                            claudeBaseUrl: '',
                            claudeModel: '',
                            aiSourceId: '',
                          });
                        }}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                      >
                        {t('Close')}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <h3 className="text-lg font-semibold mb-4">
                    {editingServer ? t('Edit Server') : t('Add Remote Server')}
                  </h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm font-medium mb-1 block">{t('Server Name')}</label>
                      <input
                        type="text"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                        placeholder={t('My Server')}
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">{t('Host')}</label>
                      <input
                        type="text"
                        value={formData.host}
                        onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                        className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                        placeholder="192.168.1.100"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium mb-1 block">{t('SSH Port')}</label>
                        <input
                          type="number"
                          value={formData.sshPort}
                          onChange={(e) =>
                            setFormData({ ...formData, sshPort: parseInt(e.target.value) || 22 })
                          }
                          className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">{t('Username')}</label>
                      <input
                        type="text"
                        value={formData.username}
                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                        className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                        placeholder="ubuntu"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">{t('Password')}</label>
                      <input
                        type="password"
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        onFocus={() => {
                          if (formData.password === '••••••••••')
                            setFormData({ ...formData, password: '' });
                        }}
                        className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                        placeholder="•••••"
                      />
                    </div>
                    <div className="pt-2 border-t border-border">
                      <h4 className="text-sm font-medium mb-3">{t('AI Model Configuration')}</h4>
                      <div>
                        <label className="text-sm font-medium mb-1 block">{t('AI Provider')}</label>
                        <select
                          value={formData.aiSourceId}
                          onChange={(e) => {
                            const sourceId = e.target.value;
                            if (sourceId) {
                              const source = aiSources.find((s) => s.id === sourceId);
                              if (source) {
                                // Set the source, but don't lock in a model yet — user picks below
                                setFormData((prev) => ({
                                  ...prev,
                                  aiSourceId: sourceId,
                                  claudeApiKey:
                                    source.authType === 'api-key'
                                      ? source.apiKey || ''
                                      : source.accessToken || '',
                                  claudeBaseUrl: source.apiUrl,
                                  // Only set model if source has no availableModels (single-model source)
                                  claudeModel:
                                    source.availableModels && source.availableModels.length > 0
                                      ? prev.claudeModel || source.model
                                      : source.model,
                                }));
                                // Auto-expand the source to show model list
                                setModelPickerExpanded(sourceId);
                              }
                            } else {
                              setFormData((prev) => ({
                                ...prev,
                                aiSourceId: '',
                                claudeApiKey: '',
                                claudeBaseUrl: '',
                                claudeModel: '',
                              }));
                              setModelPickerExpanded(null);
                            }
                          }}
                          className="w-full px-3 py-2 bg-input border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                        >
                          <option value="">{t('-- Select AI Provider --')}</option>
                          {aiSources.map((source) => (
                            <option key={source.id} value={source.id}>
                              {source.name || source.provider}
                            </option>
                          ))}
                        </select>
                        {aiSources.length === 0 && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('No AI models configured. Go to Settings to add one.')}
                          </p>
                        )}

                        {/* Model list (accordion) for the selected source */}
                        {formData.aiSourceId &&
                          (() => {
                            const source = aiSources.find((s) => s.id === formData.aiSourceId);
                            if (!source) return null;
                            const models = getModelsForSource(source);
                            if (models.length <= 1) return null; // No need to show single model

                            const isExpanded = modelPickerExpanded === source.id;
                            return (
                              <div className="mt-3">
                                <div
                                  className="px-3 py-2 text-xs font-medium flex items-center justify-between cursor-pointer hover:bg-secondary/50 transition-colors text-muted-foreground rounded-lg border border-border mb-1"
                                  onClick={() =>
                                    setModelPickerExpanded((prev) =>
                                      prev === source.id ? null : source.id,
                                    )
                                  }
                                >
                                  <div className="flex items-center gap-2">
                                    <ChevronDown
                                      className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                    />
                                    <span>
                                      {t('Select Model')} ({models.length})
                                    </span>
                                  </div>
                                  <span className="text-xs text-primary">
                                    {formData.claudeModel || source.model}
                                  </span>
                                </div>

                                {isExpanded && (
                                  <div className="bg-secondary/10 rounded-lg border border-border max-h-48 overflow-auto">
                                    {models.map((model) => {
                                      const modelId = typeof model === 'string' ? model : model.id;
                                      const modelName =
                                        typeof model === 'string' ? model : model.name || model.id;
                                      const isSelected = formData.claudeModel === modelId;

                                      return (
                                        <button
                                          key={modelId}
                                          onClick={() => {
                                            setFormData((prev) => ({
                                              ...prev,
                                              claudeModel: modelId,
                                            }));
                                            setModelPickerExpanded(null);
                                          }}
                                          className={`w-full px-3 py-2 text-left text-sm hover:bg-secondary/80 transition-colors flex items-center gap-2 ${
                                            isSelected
                                              ? 'text-primary bg-secondary/30'
                                              : 'text-foreground'
                                          }`}
                                        >
                                          {isSelected ? (
                                            <CheckCircle className="w-3.5 h-3.5" />
                                          ) : (
                                            <span className="w-3.5" />
                                          )}
                                          {modelName}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-end gap-3 mt-6">
                    <button
                      onClick={() => {
                        setShowAddDialog(false);
                        setEditingServer(null);
                        setModelPickerExpanded(null);
                        setFormData({
                          name: '',
                          host: '',
                          sshPort: 22,
                          username: '',
                          password: '',
                          claudeApiKey: '',
                          claudeBaseUrl: '',
                          claudeModel: '',
                          aiSourceId: '',
                        });
                      }}
                      disabled={saving}
                      className="px-4 py-2 border border-border rounded-lg hover:bg-secondary transition-colors disabled:opacity-50"
                    >
                      {t('Cancel')}
                    </button>
                    <button
                      onClick={editingServer ? handleEditServer : handleAddServer}
                      disabled={
                        saving ||
                        !formData.name.trim() ||
                        !formData.host.trim() ||
                        (!editingServer && !formData.password.trim())
                      }
                      className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground transition-colors"
                    >
                      {saving ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {editingServer ? t('Saving...') : t('Adding...')}
                        </>
                      ) : editingServer ? (
                        t('Save')
                      ) : (
                        t('Add Server')
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
