/**
 * TokenUsageIndicator - Displays token usage in a subtle, non-intrusive way
 *
 * Design principles:
 * - Minimal by default: shows only "12K" in muted color
 * - Hover reveals details: full usage breakdown in tooltip
 * - Independent component: can be placed anywhere
 * - Mobile-friendly: tap to see details on touch devices
 */

import { useState } from 'react';
import type { TokenUsage } from '../../types';
import { useTranslation } from '../../i18n';

interface TokenUsageIndicatorProps {
  tokenUsage: TokenUsage;
  previousCost?: number; // Previous cumulative cost, used to calculate current message cost
  className?: string;
  // Warning thresholds (defaults: 80% warning, 95% critical)
  warningThreshold?: number;
  criticalThreshold?: number;
  isEstimate?: boolean;
}

// Format number to K format (e.g., 12345 -> "12K")
function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${Math.round(tokens / 1000)}K`;
}

// Format cost to USD (e.g., 0.0123 -> "$0.01")
function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

// Compression threshold (80% of context window)
const COMPRESSION_THRESHOLD = 0.8;

export function TokenUsageIndicator({
  tokenUsage,
  previousCost = 0,
  className = '',
  warningThreshold = 80,
  criticalThreshold = 95,
  isEstimate = false,
}: TokenUsageIndicatorProps) {
  const { t } = useTranslation();
  const [showTooltip, setShowTooltip] = useState(false);

  // Current context size = all input tokens (consistent with CC's /context formula)
  // inputTokens: new input tokens (not cached)
  // cacheReadTokens: historical context read from cache
  // cacheCreationTokens: tokens for newly created cache
  // outputTokens: output tokens (also count towards context)
  const contextUsed =
    tokenUsage.inputTokens +
    tokenUsage.cacheReadTokens +
    tokenUsage.cacheCreationTokens +
    tokenUsage.outputTokens;

  // Defensive: avoid NaN when contextWindow is 0
  const contextWindow = tokenUsage.contextWindow > 0 ? tokenUsage.contextWindow : 200000;
  const usagePercent = Math.round((contextUsed / contextWindow) * 100);

  // Calculate remaining context before compression
  const compressionThreshold = Math.round(contextWindow * COMPRESSION_THRESHOLD);
  const remainingBeforeCompression = Math.max(0, compressionThreshold - contextUsed);
  const remainingContext = Math.max(0, contextWindow - contextUsed);

  // Calculate current message cost
  const currentCost = tokenUsage.totalCostUsd - previousCost;

  // Determine warning level
  const isCritical = usagePercent >= criticalThreshold;
  const isWarning = usagePercent >= warningThreshold && !isCritical;
  const isNearCompression = contextUsed >= compressionThreshold * 0.9; // 90% of compression threshold

  return (
    <div
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={() => setShowTooltip(!showTooltip)}
    >
      {/* Minimal display - cumulative context with color-coded warning */}
      <span
        className={`text-xs cursor-default select-none ${
          isCritical
            ? 'text-red-500/80'
            : isWarning
              ? 'text-amber-500/80'
              : 'text-muted-foreground/50'
        }`}
      >
        {isEstimate && <span className="text-muted-foreground/40">~</span>}{formatTokens(contextUsed)}
      </span>

      {/* Tooltip - shows on hover/tap */}
      {showTooltip && (
        <div className="absolute bottom-full right-0 mb-2 z-50 animate-fade-in">
          <div className="bg-popover border border-border rounded-lg shadow-lg p-3 min-w-[220px]">
            {/* Header */}
            <div className="text-xs font-medium text-foreground mb-2">{t('Token usage')}</div>

            {/* Progress bar */}
            <div className="h-2 bg-secondary rounded-full mb-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  isCritical ? 'bg-red-500' : isWarning ? 'bg-amber-500' : 'bg-primary/60'
                }`}
                style={{ width: `${Math.min(usagePercent, 100)}%` }}
              />
            </div>

            {/* Usage stats */}
            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-muted-foreground">
                <span>{t('Used / limit')}</span>
                <span className="text-foreground">
                  {isEstimate ? '~' : ''}{formatTokens(contextUsed)} / {formatTokens(contextWindow)}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{t('Input')}</span>
                <span>{formatTokens(tokenUsage.inputTokens)}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{t('Output')}</span>
                <span>{formatTokens(tokenUsage.outputTokens)}</span>
              </div>
              {tokenUsage.cacheReadTokens > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('Cache read')}</span>
                  <span>{formatTokens(tokenUsage.cacheReadTokens)}</span>
                </div>
              )}
              {tokenUsage.cacheCreationTokens > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('Cache created')}</span>
                  <span>{formatTokens(tokenUsage.cacheCreationTokens)}</span>
                </div>
              )}
              {tokenUsage.totalCostUsd > 0 && (
                <div className="flex justify-between text-muted-foreground pt-1 border-t border-border/50">
                  <span>{t('Current / total')}</span>
                  <span className="text-foreground">
                    {formatCost(currentCost)}/{formatCost(tokenUsage.totalCostUsd)}
                  </span>
                </div>
              )}
              {/* Remaining context display */}
              <div className="flex justify-between text-muted-foreground pt-1 border-t border-border/50">
                <span>{t('Remaining')}</span>
                <span
                  className={`text-foreground ${remainingContext < contextWindow * 0.2 ? 'text-red-400' : ''}`}
                >
                  {formatTokens(remainingContext)}
                </span>
              </div>
              {remainingBeforeCompression > 0 && (
                <div className="flex justify-between text-muted-foreground text-[10px]">
                  <span>{t('Before compression')}</span>
                  <span className="text-amber-400/80">
                    {formatTokens(remainingBeforeCompression)}
                  </span>
                </div>
              )}
            </div>

            {/* Warning alerts */}
            {isCritical && (
              <div className="mt-2 pt-2 border-t border-border/50 text-xs text-red-500 font-medium">
                <div className="flex items-center gap-1">
                  <svg
                    className="w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  {t('Context will be compressed very soon')}
                </div>
              </div>
            )}
            {isWarning && !isCritical && (
              <div className="mt-2 pt-2 border-t border-border/50 text-xs text-amber-500">
                {t('Approaching context limit')}
              </div>
            )}
            {isNearCompression && !isWarning && (
              <div className="mt-2 pt-2 border-t border-border/50 text-xs text-amber-400/80">
                <div className="flex items-center gap-1">
                  <svg
                    className="w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                  {t('Compression threshold approaching')}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
