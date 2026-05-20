import type { WikiPage } from './types';
import { WikiEngine } from './wiki-engine';
import fs from 'node:fs';

const DEFAULT_MAX_TOKENS = 10000;
const CHARS_PER_TOKEN = 4;

export class KbRetriever {
  private wikiEngine: WikiEngine;

  constructor(wikiEngine: WikiEngine) {
    this.wikiEngine = wikiEngine;
  }

  async retrieve(
    userMessage: string,
    maxTokens: number = DEFAULT_MAX_TOKENS,
  ): Promise<string | null> {
    const relevantPages = this.wikiEngine.findRelevantPages(userMessage, 7);
    console.log(`[KbRetriever] query="${userMessage.slice(0, 40)}" → ${relevantPages.length} pages`);

    if (relevantPages.length === 0) return null;

    const sections: string[] = [];

    for (const page of relevantPages) {
      if (!fs.existsSync(page.path)) continue;

      const raw = fs.readFileSync(page.path, 'utf-8');
      const { body } = this.wikiEngine.parseFrontmatter(raw);
      sections.push(`## ${page.title}\n${body}`);
    }

    const fullContext = sections.join('\n\n---\n\n');

    if (fullContext.trim().length === 0) {
      return null;
    }

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    if (fullContext.length > maxChars) {
      return fullContext.slice(0, maxChars) + '\n\n[...truncated]';
    }

    return fullContext;
  }
}
