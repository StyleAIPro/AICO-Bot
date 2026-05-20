import { isElectron } from './transport';

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export async function kbList(): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbList();
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbGet(id: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbGet(id);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbCreate(input: { name: string; description?: string; icon?: string }): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbCreate(input);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbUpdate(id: string, updates: Record<string, unknown>): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbUpdate(id, updates);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbDelete(id: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbDelete(id);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbImportFiles(kbId: string, filePaths: string[]): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbImportFiles(kbId, filePaths);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbImportFolder(kbId: string, folderPath: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbImportFolder(kbId, folderPath);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbRemoveSource(kbId: string, sourceId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbRemoveSource(kbId, sourceId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbListSources(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbListSources(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbSaveConversation(kbId: string, spaceId: string, conversationId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbSaveConversation(kbId, spaceId, conversationId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbIngest(kbId: string, sourceId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbIngest(kbId, sourceId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbIngestAll(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbIngestAll(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbIngestIncremental(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbIngestIncremental(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbCancelIngest(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbCancelIngest(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbRecompile(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbRecompile(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbCompile(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbCompile(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbQuery(kbId: string, question: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbQuery(kbId, question);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbLint(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbLint(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbGenerateReport(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbGenerateReport(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbLoadReport(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbLoadReport(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbAudit(kbId: string, correction: Record<string, unknown>): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbAudit(kbId, correction);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbListPages(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbListPages(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbReadSource(kbId: string, sourceId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbReadSource(kbId, sourceId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbReadPage(kbId: string, pagePath: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbReadPage(kbId, pagePath);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbUpdatePage(kbId: string, pagePath: string, content: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbUpdatePage(kbId, pagePath, content);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbGetPageLinks(kbId: string, pagePath: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbGetPageLinks(kbId, pagePath);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbDeletePage(kbId: string, pagePath: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbDeletePage(kbId, pagePath);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbOpenSourceBrowser(kbId: string, sourceId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbOpenSourceBrowser(kbId, sourceId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbOpenSourceDefault(kbId: string, sourceId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbOpenSourceDefault(kbId, sourceId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbGetGraph(kbId: string): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbGetGraph(kbId);
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbSelectFile(): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbSelectFile();
  }
  return { success: false, error: 'Not available in web mode' };
}

export async function kbSelectFolder(): Promise<ApiResponse> {
  if (isElectron()) {
    return window.aicoBot.kbSelectFolder();
  }
  return { success: false, error: 'Not available in web mode' };
}
