import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Check, ChevronDown } from 'lucide-react';
import { useKnowledgeBaseStore } from '@/stores/knowledge-base.store';

export function KbToggle() {
  const { t } = useTranslation();
  const { knowledgeBases, loadKnowledgeBases, activeKnowledgeBaseIds, toggleActiveKb } =
    useKnowledgeBaseStore();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadKnowledgeBases();
  }, [loadKnowledgeBases]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dropdownOpen]);

  const activeNames = knowledgeBases
    .filter((kb) => activeKnowledgeBaseIds.includes(kb.id))
    .map((kb) => kb.name);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className={`h-8 flex items-center gap-1.5 px-2.5 rounded-lg transition-colors duration-200 ${
          activeKnowledgeBaseIds.length > 0
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50'
        }`}
        title={t('kb.title')}
      >
        <BookOpen className="w-3.5 h-3.5" />
        {activeNames.length > 0 ? (
          <span className="text-xs max-w-[100px] truncate">
            {activeNames[0]}
            {activeNames.length > 1 ? ` +${activeNames.length - 1}` : ''}
          </span>
        ) : (
          <span className="text-xs">{t('kb.shortTitle', 'KB')}</span>
        )}
        <ChevronDown className="w-3 h-3" />
        {activeKnowledgeBaseIds.length > 0 && (
          <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-primary rounded-full" />
        )}
      </button>

      {dropdownOpen && (
        <div className="absolute bottom-full left-0 mb-1 w-56 rounded-lg border border-border bg-popover shadow-lg z-50">
          <div className="p-2 text-xs font-medium text-muted-foreground border-b border-border">
            {t('kb.title')}
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {knowledgeBases.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">{t('kb.empty')}</div>
            ) : (
              knowledgeBases.map((kb) => {
                const isActive = activeKnowledgeBaseIds.includes(kb.id);
                return (
                  <button
                    key={kb.id}
                    onClick={() => toggleActiveKb(kb.id)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors ${
                      isActive ? 'bg-primary/10 text-primary' : 'hover:bg-secondary text-foreground'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                        isActive ? 'bg-primary border-primary' : 'border-border'
                      }`}
                    >
                      {isActive && <Check className="w-3 h-3 text-primary-foreground" />}
                    </div>
                    <span className="truncate">{kb.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
