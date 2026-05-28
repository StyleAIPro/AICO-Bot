import { getConfig } from '../config.service';
import { getApiCredentials } from '../agent/helpers';
import { getEffectiveProxyUrl } from '../proxy';
import type { ApiCredentials } from '../agent/types';

type ChatMessage = Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;

export class KbLlmCaller {
  private credentials: ApiCredentials;
  private proxyUrl: string | undefined;

  private constructor(credentials: ApiCredentials, proxyUrl: string | undefined) {
    this.credentials = credentials;
    this.proxyUrl = proxyUrl;
  }

  static async create(): Promise<KbLlmCaller> {
    const config = getConfig();
    const credentials = await getApiCredentials(config);
    const proxyUrl = getEffectiveProxyUrl();
    return new KbLlmCaller(credentials, proxyUrl);
  }

  async chat(messages: ChatMessage, maxTokens?: number, signal?: AbortSignal): Promise<string> {
    const { baseUrl, apiKey, model, provider } = this.credentials;

    const sanitized = this.sanitizeMessages(messages);

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), 600_000);

    function onExternalAbort(): void { timeoutController.abort(); }
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    let responseJson: unknown;
    try {
      const fetchOptions: RequestInit = {
        method: 'POST',
        headers: this.buildHeaders(apiKey, provider),
        body: this.buildBody(model, sanitized, provider, maxTokens),
        signal: timeoutController.signal,
      };

      const response = await fetch(this.buildUrl(baseUrl, provider), fetchOptions);
      if (!response.ok) {
        const errorBody = await response.text();
        const bodySize = typeof fetchOptions.body === 'string' ? fetchOptions.body.length : 0;
        const roles = sanitized.map((m) => `${m.role}(${m.content.length})`);
        const debugInfo = `model=${model}, body=${bodySize}B, messages=[${roles.join(', ')}]`;
        throw new Error(`LLM request failed (${response.status}): ${errorBody} [${debugInfo}]`);
      }
      responseJson = (await response.json()) as unknown;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (signal?.aborted) {
          throw new Error('提取已取消');
        }
        throw new Error('LLM request timed out after 300s');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onExternalAbort);
    }

    return this.extractText(responseJson, provider);
  }

  async chatWithJson<T>(messages: ChatMessage, maxTokens?: number, signal?: AbortSignal): Promise<T> {
    const raw = await this.chat(messages, maxTokens, signal);
    const extracted = this.extractJson(raw);
    if (!extracted) {
      throw new Error(`LLM output is not valid JSON: ${raw.slice(0, 200)}...`);
    }
    const cleaned = this.sanitizeJsonString(extracted);
    try {
      return JSON.parse(cleaned) as T;
    } catch (firstErr) {
      try {
        const repaired = this.repairTruncatedJson(cleaned);
        const reCleaned = this.sanitizeJsonString(repaired);
        return JSON.parse(reCleaned) as T;
      } catch {
        const detail = (firstErr instanceof Error ? firstErr.message : String(firstErr)).slice(0, 200);
        throw new Error(`Failed to parse LLM JSON: ${detail}`);
      }
    }
  }

  private sanitizeMessages(messages: ChatMessage): ChatMessage {
    return messages.map((msg) => ({
      ...msg,
      content: this.sanitizeContent(msg.content),
    }));
  }

  private sanitizeContent(text: string): string {
    let s = text;
    // Remove null bytes
    s = s.replace(/\0/g, '');
    // Remove control characters except \t \n \r
    s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    // Replace Unicode line/paragraph separators
    s = s.replace(/\u2028/g, ' ');
    s = s.replace(/\u2029/g, ' ');
    // Remove BOM
    s = s.replace(/^\ufeff/, '');
    // Fix unpaired UTF-16 surrogates (lone surrogates are invalid in JSON)
    s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '');
    s = s.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
    return s;
  }

  private extractJson(raw: string): string | null {
    let text = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();

    if (text.startsWith('{') || text.startsWith('[')) {
      return text;
    }

    let best: string | null = null;
    for (const openChar of ['{', '['] as const) {
      const start = text.indexOf(openChar);
      if (start === -1) continue;

      const closeChar = openChar === '{' ? '}' : ']';
      let depth = 0;
      let inStr = false;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '\\' && inStr) { i++; continue; }
        if (text[i] === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (text[i] === openChar) depth++;
        if (text[i] === closeChar) depth--;
        if (depth === 0) { end = i; break; }
      }
      if (end !== -1) {
        const candidate = text.slice(start, end + 1);
        if (!best || candidate.length > best.length) {
          best = candidate;
        }
      }
    }

    return best;
  }

  private sanitizeJsonString(json: string): string {
    const result: string[] = [];
    let i = 0;
    let inString = false;

    while (i < json.length) {
      const ch = json[i];

      if (!inString) {
        if (ch === '"') inString = true;
        result.push(ch);
        i++;
        continue;
      }

      if (ch === '\\' && i + 1 < json.length) {
        const next = json[i + 1];
        const validEscapes = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
        if (validEscapes.has(next)) {
          result.push(ch, next);
          i += 2;
        } else if (next === 'u' && i + 5 < json.length) {
          const hex = json.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result.push(ch, json.slice(i + 1, i + 6));
            i += 6;
          } else {
            result.push(next);
            i += 2;
          }
        } else {
          result.push(next);
          i += 2;
        }
      } else if (ch === '"') {
        inString = false;
        result.push(ch);
        i++;
      } else if (ch === '\n') {
        result.push('\\', 'n');
        i++;
      } else if (ch === '\r') {
        result.push('\\', 'r');
        i++;
      } else if (ch === '\t') {
        result.push('\\', 't');
        i++;
      } else if (ch < ' ') {
        i++;
      } else {
        result.push(ch);
        i++;
      }
    }
    return result.join('');
  }

  private repairTruncatedJson(json: string): string {
    let s = json.trimEnd();
    s = s.replace(/,\s*$/, '');

    let inString = false;
    let i = 0;
    let lastCompletePos = 0;
    while (i < s.length) {
      if (s[i] === '\\' && inString) {
        i += 2;
        continue;
      }
      if (s[i] === '"') {
        inString = !inString;
        if (!inString) lastCompletePos = i + 1;
      } else if (!inString) {
        lastCompletePos = i + 1;
      }
      i++;
    }

    if (inString) {
      s = s.slice(0, lastCompletePos);
      s = s.replace(/,\s*"([^"]*)"\s*:\s*"([^"]*)$/, '');
      s = s.replace(/,\s*$/, '');
    }

    const stack: string[] = [];
    inString = false;
    for (let j = 0; j < s.length; j++) {
      if (s[j] === '\\' && inString) { j++; continue; }
      if (s[j] === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (s[j] === '{' || s[j] === '[') stack.push(s[j]);
      if (s[j] === '}' || s[j] === ']') {
        const expected = s[j] === '}' ? '{' : '[';
        if (stack.length > 0 && stack[stack.length - 1] === expected) {
          stack.pop();
        }
      }
    }

    while (stack.length > 0) {
      const open = stack.pop()!;
      s += open === '{' ? '}' : ']';
    }

    return s;
  }

  private buildUrl(baseUrl: string, provider: ApiCredentials['provider']): string {
    const base = baseUrl.replace(/\/+$/, '');
    if (provider === 'anthropic') {
      return `${base}/v1/messages`;
    }
    return `${base}/v1/chat/completions`;
  }

  private buildHeaders(
    apiKey: string,
    provider: ApiCredentials['provider'],
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    return headers;
  }

  private buildBody(
    model: string,
    messages: ChatMessage,
    provider: ApiCredentials['provider'],
    maxTokens?: number,
  ): string {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens ?? 4096,
    };

    if (provider === 'anthropic') {
      const systemMessages = messages.filter((m) => m.role === 'system');
      const nonSystemMessages = messages.filter((m) => m.role !== 'system');
      // Anthropic API requires at least one message in the messages array.
      // If all messages are system role, convert the last one to a user message.
      if (nonSystemMessages.length === 0 && systemMessages.length > 0) {
        const last = systemMessages.pop()!;
        body.messages = [{ role: 'user', content: last.content }];
      } else {
        body.messages = nonSystemMessages;
      }
      if (systemMessages.length > 0) {
        body.system = systemMessages.map((m) => m.content).join('\n\n');
      }
    }

    return JSON.stringify(body);
  }

  private extractText(responseJson: unknown, provider: ApiCredentials['provider']): string {
    if (provider === 'anthropic') {
      const resp = responseJson as { content?: Array<{ type: string; text: string }> };
      const content = resp.content;
      if (!Array.isArray(content) || content.length === 0) {
        throw new Error('Anthropic response missing content array');
      }
      const textBlock = content.find((b) => b.type === 'text');
      if (!textBlock?.text) {
        throw new Error('Anthropic response missing text content block');
      }
      return textBlock.text;
    }

    const resp = responseJson as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const choices = resp.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error('OpenAI response missing choices array');
    }
    const content = choices[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('OpenAI response missing message content');
    }
    return content;
  }
}
