/** Parses JSONC: JSON plus // and /* *\/ comments and trailing commas (wrangler.jsonc). Throws on invalid input. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('Unterminated block comment');
      i = end + 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
