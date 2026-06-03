/**
 * Local Token Estimator
 *
 * Character-based token estimation (pure JS, no dependencies).
 * Inspired by Claude Code's roughTokenCountEstimation:
 * - English/code/symbols: 4 chars ≈ 1 token
 * - CJK characters: 1 char = 2 tokens
 * - Whitespace/newlines included in count
 */

function isCJKCharacter(char: string): boolean {
  const code = char.codePointAt(0);
  if (!code) return false;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Extension A
    (code >= 0x20000 && code <= 0x2a6df) || // CJK Extension B
    (code >= 0x3040 && code <= 0x309f) ||   // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) ||   // Katakana
    (code >= 0xf900 && code <= 0xfaff)      // CJK Compatibility Ideographs
  );
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  for (const char of text) {
    tokens += isCJKCharacter(char) ? 2 : 0.25;
  }
  return Math.ceil(tokens);
}
