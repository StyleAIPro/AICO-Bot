import { useTranslation } from '../../i18n';
import { useChatStore } from '../../stores/chat.store';
import { AlertTriangle, Clock, Play, Square } from 'lucide-react';

export function IdleTimeoutDialog({ conversationId }: { conversationId: string }) {
  const session = useChatStore((s) => s.sessions.get(conversationId));
  const resolveIdleTimeout = useChatStore((s) => s.resolveIdleTimeout);
  const forceIdleTimeout = useChatStore((s) => s.forceIdleTimeout);
  const { t } = useTranslation();

  if (!session?.idleTimeout) return null;

  const { idleMinutes } = session.idleTimeout;
  const elapsedMinutes = session.agentElapsedTime
    ? Math.round(session.agentElapsedTime / 60000)
    : null;

  return (
    <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 my-3 animate-fade-in">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-amber-200 text-sm mb-1">
            {t('Agent has been inactive for {{idleMinutes}} minutes. The Agent may be stuck.', { idleMinutes })}
          </div>
          {elapsedMinutes !== null && (
            <div className="flex items-center gap-1.5 text-xs text-foreground/50 mb-2">
              <Clock className="w-3 h-3" />
              {t('Agent has been running for {{minutes}} minutes', { minutes: elapsedMinutes })}
              {session.agentCurrentTool && (
                <span className="ml-1">
                  &middot; {t('Currently executing: {{toolName}}', { toolName: session.agentCurrentTool })}
                </span>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-secondary/60 hover:bg-secondary text-foreground/80 transition-colors"
              onClick={() => resolveIdleTimeout(conversationId)}
            >
              <Play className="w-3 h-3" />
              {t('Continue Waiting')}
            </button>
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-destructive/20 hover:bg-destructive/30 text-destructive transition-colors"
              onClick={() => forceIdleTimeout(conversationId)}
            >
              <Square className="w-3 h-3" />
              {t('Force Stop')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
