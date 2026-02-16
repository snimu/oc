/**
 * Zero-dependency character-weighted token estimator.
 * ~90-95% accuracy for English text and code.
 * Conservative bias (slightly overcounts).
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  let prevSpace = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);

    if (ch === 32) {
      // space
      tokens += prevSpace ? 0.08 : 0.2;
      prevSpace = true;
    } else if (ch === 10 || ch === 13) {
      // newline
      tokens += 0.25;
      prevSpace = false;
    } else if (ch >= 48 && ch <= 57) {
      // digit
      tokens += 0.35;
      prevSpace = false;
    } else if (ch >= 97 && ch <= 122) {
      // lowercase
      tokens += 0.28;
      prevSpace = false;
    } else if (ch >= 65 && ch <= 90) {
      // uppercase
      tokens += 0.35;
      prevSpace = false;
    } else if (ch < 128) {
      // other ASCII (punctuation, etc)
      tokens += 0.45;
      prevSpace = false;
    } else {
      // non-ASCII / unicode
      tokens += 0.8;
      prevSpace = false;
    }
  }

  return Math.ceil(tokens);
}
