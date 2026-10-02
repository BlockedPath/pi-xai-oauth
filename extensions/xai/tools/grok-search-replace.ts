function normalizeCrlfForExactMatch(value: string): {
  normalized: string;
  rawBoundaries: number[];
} {
  let normalized = "";
  const rawBoundaries = [0];
  for (let rawIndex = 0; rawIndex < value.length;) {
    if (value[rawIndex] === "\r" && value[rawIndex + 1] === "\n") {
      normalized += "\n";
      rawIndex += 2;
    } else {
      normalized += value[rawIndex];
      rawIndex += 1;
    }
    rawBoundaries.push(rawIndex);
  }
  return { normalized, rawBoundaries };
}

function replacementLineEnding(
  value: string,
  start: number,
  end: number,
): "\n" | "\r\n" {
  const inMatch = value.indexOf("\n", start);
  const newlineIndex = inMatch >= 0 && inMatch < end
    ? inMatch
    : value.indexOf("\n", end);
  if (newlineIndex >= 0) return value[newlineIndex - 1] === "\r" ? "\r\n" : "\n";
  const previous = value.lastIndexOf("\n", Math.max(0, start - 1));
  return previous >= 0 && value[previous - 1] === "\r" ? "\r\n" : "\n";
}

function adaptReplacementLineEndings(value: string, lineEnding: "\n" | "\r\n"): string {
  const normalized = value.replace(/\r\n/g, "\n");
  return lineEnding === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

/**
 * Apply one exact `old_string` → `new_string` replacement against current file
 * bytes. Callers must invoke this only after holding pi's per-file mutation
 * queue so sibling same-file hunks see each other's writes.
 */
export function buildExactSearchReplaceContent(
  rawContent: string,
  oldTextRaw: string,
  newTextRaw: string,
  replaceAll: boolean | undefined,
  displayPath: string,
): string {
  const hasBom = rawContent.charCodeAt(0) === 0xfeff;
  const body = hasBom ? rawContent.slice(1) : rawContent;
  const { normalized: matchText, rawBoundaries } = normalizeCrlfForExactMatch(body);
  const oldText = oldTextRaw.replace(/\r\n/g, "\n");
  const positions: number[] = [];
  let searchOffset = 0;
  while (true) {
    const matchOffset = matchText.indexOf(oldText, searchOffset);
    if (matchOffset < 0) break;
    positions.push(matchOffset);
    searchOffset = matchOffset + oldText.length;
  }
  if (positions.length === 0) {
    throw new Error(`search_replace could not find old_string in ${displayPath}`);
  }
  if (!replaceAll && positions.length !== 1) {
    throw new Error(
      `search_replace found ${positions.length} occurrences; make old_string unique or set replace_all=true`,
    );
  }

  const selectedPositions = replaceAll ? positions : positions.slice(0, 1);
  const chunks: string[] = [];
  let rawCursor = 0;
  for (const position of selectedPositions) {
    const rawStart = rawBoundaries[position];
    const rawEnd = rawBoundaries[position + oldText.length];
    chunks.push(body.slice(rawCursor, rawStart));
    chunks.push(adaptReplacementLineEndings(
      newTextRaw,
      replacementLineEnding(body, rawStart, rawEnd),
    ));
    rawCursor = rawEnd;
  }
  chunks.push(body.slice(rawCursor));
  return `${hasBom ? "\ufeff" : ""}${chunks.join("")}`;
}
