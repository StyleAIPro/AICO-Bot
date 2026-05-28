/**
 * Streamdown plugin configuration (lazy-loaded)
 *
 * Loads @streamdown/code (Shiki) and @streamdown/math (KaTeX) asynchronously
 * to avoid blocking the module graph in Vite dev mode.
 */

import { useState, useEffect } from 'react';
import type { CodeHighlighterPlugin, MathPlugin } from 'streamdown';

// --- Code highlighter (Shiki) ---

let cachedCodePlugin: CodeHighlighterPlugin | null = null;
let loadCodePromise: Promise<CodeHighlighterPlugin> | null = null;

function loadCodePlugin(): Promise<CodeHighlighterPlugin> {
  if (!loadCodePromise) {
    loadCodePromise = import('@streamdown/code').then((m) => {
      const plugin = m.createCodePlugin({
        themes: ['github-dark', 'github-light'],
      });
      cachedCodePlugin = plugin;
      return plugin;
    });
  }
  return loadCodePromise;
}

export function useCodePlugin(): CodeHighlighterPlugin | undefined {
  const [plugin, setPlugin] = useState<CodeHighlighterPlugin | undefined>(
    cachedCodePlugin ?? undefined,
  );

  useEffect(() => {
    if (cachedCodePlugin) {
      setPlugin(cachedCodePlugin);
      return;
    }
    loadCodePlugin().then(setPlugin);
  }, []);

  return plugin;
}

// --- Math (KaTeX) ---

let cachedMathPlugin: MathPlugin | null = null;
let loadMathPromise: Promise<MathPlugin> | null = null;
let mathStylesInjected = false;

function loadMathPlugin(): Promise<MathPlugin> {
  if (!loadMathPromise) {
    loadMathPromise = import('@streamdown/math').then((m) => {
      const plugin = m.createMathPlugin({ singleDollarTextMath: true });
      cachedMathPlugin = plugin;

      // Inject KaTeX CSS
      if (!mathStylesInjected) {
        import('katex/dist/katex.min.css').catch(() => {});
        const styles = plugin.getStyles?.();
        if (styles) {
          const link = document.createElement('style');
          link.textContent = styles;
          document.head.appendChild(link);
        }
        mathStylesInjected = true;
      }

      return plugin;
    });
  }
  return loadMathPromise;
}

export function useMathPlugin(): MathPlugin | undefined {
  const [plugin, setPlugin] = useState<MathPlugin | undefined>(
    cachedMathPlugin ?? undefined,
  );

  useEffect(() => {
    if (cachedMathPlugin) {
      setPlugin(cachedMathPlugin);
      return;
    }
    loadMathPlugin().then(setPlugin);
  }, []);

  return plugin;
}
