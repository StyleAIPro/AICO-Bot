/**
 * Slash command dropdown menu
 *
 * Positioned above the textarea (same strategy as MentionPopup).
 * Displays command/subcommand list and installed skills with grouped sections.
 */

import { forwardRef } from 'react';
import { Wrench, Sparkles } from 'lucide-react';
import { useTranslation } from '../../i18n';
import type { SlashCommandMenuItem } from '../../hooks/slash-command/types';

interface SlashCommandMenuProps {
  items: SlashCommandMenuItem[];
  selectedIndex: number;
  onSelect: (item: SlashCommandMenuItem) => void;
}

function renderIcon(icon?: string) {
  if (icon === 'Sparkles') {
    return <Sparkles className="w-4 h-4 flex-shrink-0 text-primary" />;
  }
  if (icon === 'Wrench') {
    return <Wrench className="w-4 h-4 flex-shrink-0 text-muted-foreground" />;
  }
  return <span className="w-4 h-4 flex-shrink-0" />;
}

export const SlashCommandMenu = forwardRef<HTMLDivElement, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, selectedIndex, onSelect }, ref) {
    const { t } = useTranslation();

    if (items.length === 0) {
      return (
        <div
          ref={ref}
          className="absolute bottom-full left-0 mb-2 py-2 px-3 bg-popover border border-border
            rounded-lg shadow-lg min-w-[240px] z-50"
        >
          <span className="text-xs text-muted-foreground">{t('No matching commands')}</span>
        </div>
      );
    }

    const hasSkills = items.some((item) => item.type === 'skill');
    const hasCommands = items.some((item) => item.type !== 'skill');

    // Build a flat list with group headers; compute a global selectedIndex
    // that accounts for header rows
    const commandItems = items.filter((item) => item.type !== 'skill');
    const skillItems = items.filter((item) => item.type === 'skill');

    interface Row {
      kind: 'header' | 'item';
      item?: SlashCommandMenuItem;
      label?: string;
    }

    const rows: Row[] = [];
    if (hasCommands && hasSkills) {
      rows.push({ kind: 'header', label: t('Commands') });
      for (const item of commandItems) rows.push({ kind: 'item', item });
      rows.push({ kind: 'header', label: t('Skills') });
      for (const item of skillItems) rows.push({ kind: 'item', item });
    } else {
      for (const item of items) rows.push({ kind: 'item', item });
    }

    // Map original selectedIndex to row index (skip headers)
    let itemIdx = 0;
    let highlightRow = -1;
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].kind === 'item') {
        if (itemIdx === selectedIndex) highlightRow = r;
        itemIdx++;
      }
    }

    return (
      <div
        ref={ref}
        className="absolute bottom-full left-0 mb-2 py-1 bg-popover border border-border
          rounded-lg shadow-lg min-w-[240px] max-h-[300px] overflow-y-auto z-50"
      >
        {rows.map((row, index) => {
          if (row.kind === 'header') {
            return (
              <div
                key={`header-${row.label}`}
                className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {row.label}
              </div>
            );
          }
          const item = row.item!;
          return (
            <button
              key={`${item.type}-${item.command?.name ?? ''}${item.subcommand ? `-${item.subcommand.name}` : ''}${item.skill ? `-${item.skill.appId}` : ''}`}
              onClick={() => onSelect(item)}
              className={`w-full px-3 py-2 flex items-center gap-2 text-sm
                transition-colors ${
                  index === highlightRow
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground hover:bg-secondary'
                }`}
            >
              {renderIcon(item.icon)}

              {item.type === 'subcommand' && <span className="text-xs text-muted-foreground">/</span>}

              <span className="flex-1 text-left font-medium">{item.label}</span>

              <span className="text-xs text-muted-foreground truncate max-w-[160px]">
                {item.description}
              </span>
            </button>
          );
        })}
      </div>
    );
  },
);
