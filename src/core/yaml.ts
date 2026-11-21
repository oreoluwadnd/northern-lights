/**
 * A tiny reader for the small YAML subset used by `.northern-lights/project.yaml`:
 *
 *   key: value
 *   list_key:
 *     - item
 *     - "quoted item"
 *
 * Comments (#) and blank lines are ignored. Anything fancier is rejected with a clear error,
 * so we don't need a YAML dependency.
 */
export type YamlValue = string | string[];

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function stripComment(line: string): string {
  // Only strip " #" comments outside quotes (good enough for this subset).
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

export function parseYaml(text: string, file = "project.yaml"): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  let currentList: string | null = null;
  text.split(/\r?\n/).forEach((rawLine, idx) => {
    const line = stripComment(rawLine).replace(/\s+$/, "");
    if (!line.trim()) return;
    const item = line.match(/^\s+-\s+(.*)$/) ?? line.match(/^-\s+(.*)$/);
    if (item) {
      if (!currentList) throw new Error(`${file}:${idx + 1}: list item without a key above it`);
      (out[currentList] as string[]).push(unquote(item[1]));
      return;
    }
    const kv = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!kv) throw new Error(`${file}:${idx + 1}: can't read this line: ${rawLine}`);
    const [, key, value] = kv;
    if (value === "" || value === undefined) {
      out[key] = [];
      currentList = key;
    } else if (value.trim() === "[]") {
      out[key] = [];
      currentList = null;
    } else {
      out[key] = unquote(value);
      currentList = null;
    }
  });
  return out;
}
