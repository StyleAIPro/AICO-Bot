/**
 * SpaceSelector - Header dropdown for switching between spaces
 *
 * Shows current space icon + name, click to open dropdown with all spaces.
 * Bottom link navigates to HomePage for space management.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Settings2, Cloud, Folder, Blocks } from 'lucide-react';
import { useAppStore } from '../../stores/app.store';
import { useSpaceStore } from '../../stores/space.store';
import { useOtherSpacesHaveActiveTasks, useSpaceHasActiveTasks } from '../../stores/chat.store';
import { SpaceIcon } from '../icons/ToolIcons';
import { useTranslation } from '../../i18n';
import type { Space } from '../../types';
import type { RemoteServer } from '../../pages/RemoteServersPage';
import { api } from '../../api';

/** Minimum interval between loadSpaces calls (ms) */
const LOAD_THROTTLE_MS = 5_000;

/**
 * SpaceItem - Single space row in the dropdown.
 * Extracted as its own component so it can call useSpaceHasActiveTasks per space.
 */
function SpaceItem({
  space,
  isActive,
  remoteServerName,
  onSelect,
}: {
  space: Space;
  isActive: boolean;
  remoteServerName: string | null;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const hasActive = useSpaceHasActiveTasks(isActive ? undefined : space.id);
  const name = space.isTemp ? t('AICO-Bot Space') : space.name;

  return (
    <button
      onClick={onSelect}
      className={`w-full px-3 py-2.5 text-left text-sm hover:bg-secondary/80 transition-colors flex items-center gap-2.5 ${
        isActive ? 'text-primary bg-primary/5' : 'text-foreground'
      }`}
    >
      <SpaceIcon
        iconId={space.icon || (space.isTemp ? 'sparkles' : 'folder')}
        size={16}
        className="flex-shrink-0"
      />
      <span className="truncate">{name}</span>
      {/* Space type icon badge */}
      {'spaceType' in space && space.spaceType === 'hyper' ? (
        <Blocks className="ml-1 w-3.5 h-3.5 text-purple-500 flex-shrink-0" />
      ) : space.claudeSource === 'remote' ? (
        <Cloud className="ml-1 w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
      ) : (
        <Folder className="ml-1 w-3.5 h-3.5 text-green-600 flex-shrink-0" />
      )}
      {space.claudeSource === 'remote' && remoteServerName && (
        <span
          className="text-xs text-muted-foreground truncate max-w-[120px]"
          title={remoteServerName}
        >
          @ {remoteServerName}
        </span>
      )}
      {/* Active tasks indicator — small dot for non-current spaces with active conversations */}
      {!isActive && hasActive && (
        <span className="ml-auto w-2 h-2 rounded-full bg-blue-500 pulse-dot pulse-dot-generating flex-shrink-0" />
      )}
      {isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />}
    </button>
  );
}

export function SpaceSelector() {
  const { t } = useTranslation();
  const { setView } = useAppStore();
  const {
    defaultSpace,
    spaces,
    currentSpace,
    setCurrentSpace,
    refreshCurrentSpace,
    loadSpaces,
    isLoading,
  } = useSpaceStore();
  const [isOpen, setIsOpen] = useState(false);
  const [remoteServers, setRemoteServers] = useState<RemoteServer[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const lastLoadRef = useRef(0);
  const otherSpacesActive = useOtherSpacesHaveActiveTasks();

  // Throttled loadSpaces — skips if called within LOAD_THROTTLE_MS of last call
  const throttledLoadSpaces = useCallback(() => {
    const now = Date.now();
    if (now - lastLoadRef.current < LOAD_THROTTLE_MS) return;
    lastLoadRef.current = now;
    loadSpaces();
  }, [loadSpaces]);

  // Eagerly load spaces on mount so dropdown is ready
  useEffect(() => {
    throttledLoadSpaces();
  }, [throttledLoadSpaces]);

  // Load remote servers for displaying server names
  useEffect(() => {
    const loadServers = async () => {
      try {
        const result = await api.getRemoteServers();
        if (result.success && Array.isArray(result.data)) {
          setRemoteServers(result.data);
        }
      } catch {
        // 远程服务器加载失败是预期行为（本地/内网环境），静默处理
      }
    };
    loadServers();
  }, []);

  // Refresh spaces when dropdown opens (throttled)
  useEffect(() => {
    if (isOpen) {
      throttledLoadSpaces();
    }
  }, [isOpen, throttledLoadSpaces]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsOpen(false);
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleSelectSpace = (space: Space) => {
    if (space.id === currentSpace?.id) {
      setIsOpen(false);
      return;
    }
    setCurrentSpace(space);
    refreshCurrentSpace(); // Load full space data (preferences) from backend
    setView('space');
    setIsOpen(false);
  };

  const handleManageSpaces = () => {
    setIsOpen(false);
    setView('home');
  };

  // Build space list: default Space first, then dedicated spaces
  // Fallback: if store hasn't loaded yet, at least show currentSpace
  const storeSpaces: Space[] = [...(defaultSpace ? [defaultSpace] : []), ...spaces];
  const allSpaces: Space[] =
    storeSpaces.length > 0 ? storeSpaces : currentSpace ? [currentSpace] : [];

  // Helper to get remote server name by id
  const getRemoteServerName = (serverId: string): string => {
    const server = remoteServers.find((s) => s.id === serverId);
    return server ? server.name : serverId;
  };

  const displayName = currentSpace
    ? currentSpace.isTemp
      ? t('AICO-Bot')
      : currentSpace.name
    : t('AICO-Bot');

  const displayIcon = currentSpace?.icon || 'sparkles';

  // Get remote server name for current space
  const currentRemoteServerName =
    currentSpace?.claudeSource === 'remote' && currentSpace.remoteServerId
      ? getRemoteServerName(currentSpace.remoteServerId)
      : null;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2 py-1.5 text-sm hover:bg-secondary/80 rounded-lg transition-colors max-w-[200px]"
        title={
          currentRemoteServerName ? `${displayName} @ ${currentRemoteServerName}` : displayName
        }
      >
        <SpaceIcon iconId={displayIcon} size={18} className="flex-shrink-0" />
        <div className="flex items-center gap-1 min-w-0">
          <span className="font-medium truncate hidden sm:inline">{displayName}</span>
          {/* Space type indicator - icon only */}
          {currentSpace && 'spaceType' in currentSpace && currentSpace.spaceType === 'hyper' ? (
            <Blocks className="w-3 h-3 text-purple-500 flex-shrink-0 hidden md:inline" />
          ) : currentSpace?.claudeSource === 'remote' ? (
            <Cloud className="w-3 h-3 text-blue-500 flex-shrink-0 hidden md:inline" />
          ) : currentSpace ? (
            <Folder className="w-3 h-3 text-green-600 flex-shrink-0 hidden md:inline" />
          ) : null}
          {currentRemoteServerName && (
            <span className="text-xs text-muted-foreground truncate hidden lg:inline">
              @ {currentRemoteServerName}
            </span>
          )}
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
        {/* Active tasks in other spaces indicator */}
        {otherSpacesActive && !isOpen && (
          <span className="w-2 h-2 rounded-full bg-blue-500 pulse-dot pulse-dot-generating flex-shrink-0" />
        )}
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-card border border-border rounded-xl shadow-lg z-50 py-1 max-h-[50vh] overflow-y-auto">
          {isLoading && allSpaces.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">{t('Loading...')}</div>
          )}
          {allSpaces.map((space) => {
            const isActive = space.id === currentSpace?.id;
            const remoteServerName =
              space.claudeSource === 'remote' && space.remoteServerId
                ? getRemoteServerName(space.remoteServerId)
                : null;

            return (
              <SpaceItem
                key={space.id}
                space={space}
                isActive={isActive}
                remoteServerName={remoteServerName}
                onSelect={() => handleSelectSpace(space)}
              />
            );
          })}

          {/* Manage Spaces link */}
          <div className="border-t border-border/50 mt-1 pt-1">
            <button
              onClick={handleManageSpaces}
              className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors flex items-center gap-2"
            >
              <Settings2 className="w-3.5 h-3.5" />
              {t('Manage Spaces')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
