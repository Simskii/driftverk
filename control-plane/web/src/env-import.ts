export type ImportedVariable = { name: string; value: string };
export type EnvImportResult = { variables: ImportedVariable[]; errors: string[] };

// Parse data only: never expand variables or execute shell expressions.
export function parseEnvImport(source: string): EnvImportResult {
  const variables: ImportedVariable[] = [];
  const errors: string[] = [];
  const names = new Set<string>();
  if (source.length > 1_048_576) return { variables, errors: ["Use a file smaller than 1 MB."] };
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const lineNumber = i + 1;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) { errors.push(`Line ${lineNumber}: expected NAME=value.`); continue; }
    const name = match[1];
    let value = match[2];
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      let end = -1;
      const findEnd = () => {
        for (let j = 1; j < value.length; j++) {
          if (quote === '"' && value[j] === "\\") { j++; continue; }
          if (value[j] === quote) return j;
        }
        return -1;
      };
      while ((end = findEnd()) < 0 && i + 1 < lines.length) value += "\n" + lines[++i];
      if (end < 0) { errors.push(`Line ${lineNumber}: unclosed quoted value.`); continue; }
      const suffix = value.slice(end + 1).trim();
      if (suffix && !suffix.startsWith("#")) { errors.push(`Line ${lineNumber}: unexpected text after quoted value.`); continue; }
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\([nr"\\])/g, (_, escaped: string) => ({ n: "\n", r: "\r", '"': '"', "\\": "\\" })[escaped]!);
    } else {
      value = value.split("#", 1)[0].trim();
    }
    if (names.has(name)) { errors.push(`Line ${lineNumber}: ${name} appears more than once.`); continue; }
    if (value.length > 32768) { errors.push(`Line ${lineNumber}: ${name} exceeds 32,768 characters.`); continue; }
    names.add(name);
    variables.push({ name, value });
  }
  return { variables, errors };
}

export function mergeImportedVariables(existing: ImportedVariable[], imported: ImportedVariable[]) {
  const incoming = new Map(imported.map((variable) => [variable.name, variable]));
  return [...existing.filter((variable) => variable.name && !incoming.has(variable.name)), ...imported];
}
