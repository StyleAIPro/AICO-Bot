/**
 * API Validator Service
 *
 * Validates API connections by sending a test message through the Claude Code SDK.
 * This ensures the entire pipeline (router, SDK, upstream API) works correctly.
 *
 * Why use SDK instead of direct HTTP?
 * 1. Tests the complete data path including OpenAI compat router
 * 2. Handles proxy/network configurations correctly
 * 3. Validates credentials in the same way production code does
 *
 * Uses the same SDK pattern as the agent module (session-manager.ts)
 */

import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import { app } from 'electron';
import { proxyFetch } from '../proxy';
import {
  ensureOpenAICompatRouter,
  encodeBackendConfig,
  normalizeApiUrl,
} from '../../openai-compat-router';
import type { BackendConfig } from '../../openai-compat-router';
import { getCleanUserEnv } from '../agent/sdk-config';
import { AVAILABLE_MODELS } from '../../../shared/types/ai-sources';
import { getHeadlessElectronPath } from '../agent/helpers';
import { normalizeModelsUrl } from '../../openai-compat-router/utils/url';

// Re-export normalizeApiUrl for external use (moved to router module)
export { normalizeApiUrl } from '../../openai-compat-router';

export interface FetchModelsParams {
  apiKey: string;
  apiUrl: string;
  useProxy?: boolean;
}

export interface FetchModelsResult {
  models: Array<{ id: string; name: string }>;
}

/**
 * Fetch available models from an OpenAI-compatible API endpoint.
 *
 * Runs in the main process (Node.js) to avoid CORS restrictions
 * that block direct renderer fetch() calls to external APIs.
 */
export async function fetchModelsFromApi(params: FetchModelsParams): Promise<FetchModelsResult> {
  const { apiKey, apiUrl, useProxy } = params;

  if (!apiKey || !apiUrl) {
    throw new Error('API key and URL are required');
  }

  // Normalize URL using shared function (consistent with test connection)
  const modelsUrl = normalizeModelsUrl(apiUrl);

  console.log('[API Validator] Fetching models from:', modelsUrl, 'useProxy:', useProxy);

  const response = await proxyFetch(
    modelsUrl,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    },
    40_000,
    !useProxy,
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch models (${response.status})`);
  }

  const data = await response.json();

  // Check for error responses in body (some providers return HTTP 200 with error payload)
  if (data && (data.success === false || data.error || data.code)) {
    const errMsg = data.msg || data.message || data.error?.message || data.error || `Error ${data.code || 'unknown'}`;
    throw new Error(String(errMsg));
  }

  // Support multiple response formats from different providers
  let models: Array<{ id: string; name: string }> | undefined;

  // Format 1: OpenAI standard { data: [...] }
  if (data.data && Array.isArray(data.data)) {
    models = data.data
      .filter((m: any) => typeof m.id === 'string')
      .map((m: any) => ({ id: m.id, name: m.name || m.id }));
  }
  // Format 1b: { data: { data: [...] } } (nested/paginated wrapper)
  else if (data.data && typeof data.data === 'object' && !Array.isArray(data.data) && Array.isArray(data.data.data)) {
    models = data.data.data
      .filter((m: any) => typeof m.id === 'string')
      .map((m: any) => ({ id: m.id, name: m.name || m.id }));
  }
  // Format 2: { models: [...] } (Ollama /api/tags, some Chinese providers)
  else if (data.models && Array.isArray(data.models)) {
    models = data.models
      .filter((m: any) => typeof m.id === 'string' || typeof m.name === 'string')
      .map((m: any) => ({ id: m.id || m.name, name: m.name || m.id }));
  }
  // Format 3: Direct array [...]
  else if (Array.isArray(data)) {
    models = data
      .filter((m: any) => typeof m.id === 'string')
      .map((m: any) => ({ id: m.id, name: m.name || m.id }));
  }
  // Format 4: Fallback — scan all top-level array fields for {id: string} objects
  else if (typeof data === 'object' && data !== null) {
    for (const key of Object.keys(data)) {
      const value = (data as any)[key];
      if (Array.isArray(value) && value.length > 0 && typeof value[0].id === 'string') {
        models = value
          .filter((m: any) => typeof m.id === 'string')
          .map((m: any) => ({ id: m.id, name: m.name || m.id }));
        break;
      }
    }
  }

  if (!models) {
    const preview = JSON.stringify(data).substring(0, 200);
    console.warn('[API Validator] Unrecognized model response format:', preview);
    throw new Error('Invalid API response format');
  }

  // Sort and deduplicate
  models = models
    .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)
    .sort((a, b) => a.id.localeCompare(b.id));

  if (models.length === 0) {
    throw new Error('No models found');
  }

  console.log(`[API Validator] Found ${models.length} models`);

  return { models };
}

export interface ValidateApiParams {
  apiKey: string;
  apiUrl: string;
  provider: 'anthropic' | 'openai';
  model?: string;
  useProxy?: boolean;
}

export interface ValidateApiResult {
  valid: boolean;
  message?: string;
  model?: string;
  normalizedUrl: string;
}

/**
 * Validate API connection by sending a test message through SDK
 *
 * This function:
 * 1. Normalizes the URL based on provider type
 * 2. Starts the OpenAI compat router if needed
 * 3. Creates a temporary SDK session with the test config
 * 4. Sends a minimal test message and streams response
 * 5. Returns validation result
 *
 * Uses the same SDK pattern as session-manager.ts: send() + stream()
 */
export async function validateApiConnection(params: ValidateApiParams): Promise<ValidateApiResult> {
  const { apiKey, apiUrl, provider, model, useProxy } = params;

  // Step 1: Normalize URL
  const normalizedUrl = normalizeApiUrl(apiUrl, provider);

  // Step 2: Build backend config for router
  let anthropicBaseUrl: string;
  let anthropicApiKey: string;

  if (provider === 'openai') {
    // Route through OpenAI compat router
    const routerInfo = await ensureOpenAICompatRouter({ debug: false });

    const backendConfig: BackendConfig = {
      url: normalizedUrl,
      key: apiKey,
    };

    anthropicBaseUrl = routerInfo.baseUrl;
    anthropicApiKey = encodeBackendConfig(backendConfig);
  } else {
    // Direct Anthropic API
    anthropicBaseUrl = normalizedUrl;
    anthropicApiKey = apiKey;
  }

  // Step 3: Determine test model
  // For OpenAI compat: use a simple model, SDK will pass through router
  // For Anthropic: use actual model from config or default
  const testModel =
    model || (provider === 'anthropic' ? AVAILABLE_MODELS[2].id : 'claude-sonnet-4-6');

  // Step 4: Get headless Electron path (same as agent module)
  const electronPath = getHeadlessElectronPath();

  // Step 5: Create temporary SDK session with same pattern as session-manager.ts
  const abortController = new AbortController();

  // Set timeout for validation (20 seconds — accounts for cold start scenarios)
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, 40000);

  try {
    const sdkOptions: Record<string, unknown> = {
      model: testModel,
      cwd: app.getPath('temp'),
      abortController,
      env: {
        ...getCleanUserEnv(),
        ELECTRON_RUN_AS_NODE: 1,
        ELECTRON_NO_ATTACH_CONSOLE: 1,
        ANTHROPIC_API_KEY: anthropicApiKey,
        ANTHROPIC_BASE_URL: anthropicBaseUrl,
        NO_PROXY: useProxy ? 'localhost,127.0.0.1' : '*',
        no_proxy: useProxy ? 'localhost,127.0.0.1' : '*',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_COST_WARNINGS: '1',
      },
      systemPrompt: 'Reply with exactly: OK',
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'bypassPermissions' as const,
      executable: electronPath,
      executableArgs: ['--no-warnings'],
    };

    console.log('[API Validator] Creating SDK session for validation...');
    const session = (await unstable_v2_createSession(sdkOptions as any)) as any;

    // Step 6: Send test message using correct SDK pattern: send() + stream()
    console.log('[API Validator] Sending test message...');
    session.send('test');

    // Step 7: Stream response and check for valid reply
    let hasResponse = false;
    let responseContent = '';
    let lastError = '';

    for await (const msg of session.stream()) {
      // Check for abort
      if (abortController.signal.aborted) {
        break;
      }

      // Look for assistant message or result
      if (msg.type === 'assistant') {
        hasResponse = true;
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              responseContent += block.text || '';
            }
          }
        }
      } else if (msg.type === 'result') {
        // Check result for errors (consistent with process-stream.ts pattern)
        const resultMsg = msg as any;
        const isError = resultMsg.is_error === true;
        const errorSubtype = resultMsg.subtype;
        const errorContent =
          resultMsg.result || resultMsg.message?.result || '';

        if (isError) {
          // API-level error (auth failure, model not found, etc.)
          hasResponse = false;
          lastError = errorContent || 'API returned an error';
        } else if (errorSubtype === 'error_during_execution') {
          // Execution interrupted (network issue, etc.)
          hasResponse = false;
          lastError = 'Connection interrupted during execution';
        } else {
          // Normal result or error_max_turns (graceful SDK termination)
          hasResponse = true;
        }
        break;
      }
    }

    // Step 8: Close session
    clearTimeout(timeoutId);
    try {
      session.close();
    } catch {
      // Ignore close errors
    }

    console.log(
      `[API Validator] Validation complete: hasResponse=${hasResponse}, content="${responseContent.substring(0, 50)}", lastError="${lastError.substring(0, 100)}"`,
    );

    if (hasResponse) {
      return {
        valid: true,
        normalizedUrl,
        model: testModel,
        message: 'Connection successful',
      };
    } else {
      return {
        valid: false,
        normalizedUrl,
        message: lastError || 'No response received from API',
      };
    }
  } catch (error) {
    clearTimeout(timeoutId);

    const err = error as Error;
    const errorMessage = err.message || 'Connection failed';

    console.error('[API Validator] Validation error:', errorMessage);

    // Parse common error patterns for better user feedback
    let userFriendlyMessage = errorMessage;

    if (err.name === 'AbortError' || errorMessage.includes('aborted')) {
      userFriendlyMessage = 'Connection timeout - server may be slow or unreachable';
    } else if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
      userFriendlyMessage = 'Invalid API key';
    } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
      userFriendlyMessage = 'Access denied - check API key permissions';
    } else if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
      userFriendlyMessage = 'API endpoint not found - check URL';
    } else if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
      userFriendlyMessage = 'Rate limited - try again later';
    } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
      userFriendlyMessage = 'Cannot connect to API server - check URL';
    } else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      userFriendlyMessage = 'Connection timeout - server may be slow or unreachable';
    } else if (
      errorMessage.includes('model_not_found') ||
      errorMessage.includes('invalid_model') ||
      errorMessage.includes('model does not exist')
    ) {
      userFriendlyMessage = 'Model not found - check model ID';
    } else if (
      errorMessage.includes('permission denied') ||
      errorMessage.includes('insufficient')
    ) {
      userFriendlyMessage = 'Permission denied - check API key permissions';
    } else if (errorMessage.includes('ECONNRESET') || errorMessage.includes('socket hang up')) {
      userFriendlyMessage = 'Connection reset by server - try again';
    }

    return {
      valid: false,
      normalizedUrl,
      message: userFriendlyMessage,
    };
  }
}
