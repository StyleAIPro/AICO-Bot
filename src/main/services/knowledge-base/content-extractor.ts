import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { SourceFileType } from './types';

const require = createRequire(import.meta.url);

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const DOCX_EXTENSIONS = new Set(['.docx']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs',
  '.java', '.cpp', '.c', '.h', '.css', '.json',
  '.yaml', '.yml', '.xml', '.sh', '.bash', '.sql',
  '.vue', '.svelte',
]);

export function detectFileType(ext: string): SourceFileType {
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (HTML_EXTENSIONS.has(ext)) return 'web';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  throw new Error(`Unsupported file type: ${ext}`);
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = require('pdf-parse') as { PDFParse: new (data: Uint8Array) => PdfParserInstance };

  interface PdfParserInstance {
    load(): Promise<unknown>;
    getText(): Promise<{ text: string }>;
    destroy?(): void;
  }

  const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const parser = new PDFParse(uint8);
  try {
    await parser.load();
    const result = await parser.getText();
    return result.text.replace(/\s{3,}/g, ' ').trim();
  } finally {
    parser.destroy?.();
  }
}

async function extractHtml(buffer: Buffer): Promise<string> {
  const cheerio = await import('cheerio');
  const $ = cheerio.load(buffer.toString('utf-8'));
  $('script, style').remove();
  return $('body').text().replace(/\s{3,}/g, ' ').trim();
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = require('mammoth') as { extractRawText: (options: { buffer: Buffer }) => Promise<{ value: string }> };
  const result = await mammoth.extractRawText({ buffer });
  return result.value.replace(/\s{3,}/g, ' ').trim();
}

type ExtractableType = 'markdown' | 'pdf' | 'docx' | 'web' | 'code';

const extractors: Record<ExtractableType, (buffer: Buffer) => string | Promise<string>> = {
  markdown: (buf) => buf.toString('utf-8'),
  code: (buf) => buf.toString('utf-8'),
  pdf: extractPdf,
  docx: extractDocx,
  web: extractHtml,
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function extractContent(
  filePath: string,
): Promise<{ text: string; fileType: SourceFileType }> {
  const ext = path.extname(filePath).toLowerCase();
  const fileType = detectFileType(ext);

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    const fileName = path.basename(filePath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    throw new Error(`${fileName} 大于10MB，请修改为markdown格式`);
  }

  const buffer = fs.readFileSync(filePath);
  const extractor = extractors[fileType as ExtractableType];
  if (!extractor) {
    throw new Error(`Cannot extract content from file type: ${fileType}`);
  }

  const text = await extractor(buffer);
  return { text, fileType };
}
