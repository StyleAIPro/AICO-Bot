/**
 * Knowledge Base Module - Type Definitions
 */

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  icon: string;
  sourceCount: number;
  pageCount: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SourceFileType = 'pdf' | 'docx' | 'markdown' | 'code' | 'web' | 'conversation';
export type SourceStatus = 'pending' | 'ingesting' | 'compiled' | 'error';

export interface KbSource {
  id: string;
  kbId: string;
  originalPath: string;
  storedName: string;
  fileType: SourceFileType;
  fileSize: number;
  status: SourceStatus;
  errorMessage: string;
  ingestedAt: string | null;
  compiledAt: string | null;
  metadataJson: string;
  createdAt: string;
}

export interface KbConversation {
  id: string;
  kbId: string;
  spaceId: string;
  conversationId: string;
  summary: string;
  originalLength: number;
  status: SourceStatus;
  createdAt: string;
}

export interface ImportResult {
  imported: number;
  failed: number;
  errors: Array<{ file: string; error: string }>;
}

export interface IngestResult {
  pagesCreated: number;
  pagesUpdated: number;
  conceptsCount: number;
  entitiesCount: number;
  summaryCreated: boolean;
  errors: string[];
  newPages: Array<{ title: string; kind: string; desc: string }>;
}

export interface CompileResult {
  splitsPerformed: number;
  mergesPerformed: number;
  indexRebuilt: boolean;
  issuesFound: number;
}

export interface QueryResult {
  answer: string;
  citedPages: string[];
}

export type LintIssueType =
  | 'oversized_page'
  | 'undersized_page'
  | 'missing_frontmatter'
  | 'empty_tags'
  | 'empty_body'
  | 'duplicate_title'
  | 'missing_source';

export interface LintIssue {
  type: LintIssueType;
  severity: 'warning' | 'error';
  file: string;
  detail: string;
  relatedFile?: string;
}

export interface LintResult {
  issues: LintIssue[];
  totalPages: number;
  healthScore: number;
}

export type AuditCorrectionType = 'factual_error' | 'outdated' | 'incomplete' | 'misleading';

export interface AuditCorrection {
  type: AuditCorrectionType;
  targetPage: string;
  description: string;
  suggestedFix?: string;
}

export interface CreateKnowledgeBaseInput {
  name: string;
  description?: string;
  icon?: string;
}

export interface WikiPage {
  title: string;
  type: 'concept' | 'entity' | 'summary' | 'conversation';
  path: string;
  content: string;
  sources: string[];
  tags: string[];
}
