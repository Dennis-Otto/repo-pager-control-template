// The notes of a release in the language of the pager: the check that Claude's
// translation keeps what the message links and names. The pager checks each line
// again (src/translations.ts of repo-pager) and shows the English of a line that
// fails; this check is the same and stricter, and all or nothing: a line that lost
// a reference, a name of code or a code span, or that gained a link, may be the
// mark of notes that steered Claude, so none of its answer goes to the pager.

/** The notes as the pager sends them, and the most that it takes back. */
export const NOTES = {
  /** The most lines, MAX_NOTE_LINES of the pager. */
  lines: 15,
  /** The most characters of a line that the pager sends, MAX_NOTE_LINE. */
  line: 300,
  /** The most characters of a translated line, MAX_TRANSLATED_LINE: German takes more than English. */
  translated: 450,
  /**
   * The most characters of the English notes with their scopes and headings,
   * MAX_NOTES_LENGTH. The pager takes translated lines of twice as many with their
   * scopes, so a translation of at most as many more than the English fits,
   * whatever the scopes, which it never sends, are.
   */
  shown: 1200,
};

/** A line folded into one, trimmed, as the pager shows it. */
export function fold(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** The numbers that the message links in a line, such as 791 of "#791", in order. */
export function references(text) {
  return [...text.matchAll(/(?:^|[\s(])#(\d{1,7})\b/g)]
    .map((found) => found[1])
    .sort()
    .join(" ");
}

/**
 * The names of code in a line, as the pager finds them: a word with a slash, an
 * underscore or an @, a version such as v1.56.0, a name of a hidden file such as
 * .github, or a file or a name with a dot such as check.sh or Node.js, without the
 * marks around it; "e.g." is none.
 */
export function names(text) {
  return text
    .split(/\s+/)
    .map((word) =>
      word.replace(/^["'(«„“]+/, "").replace(/["'),.:;!?»“”]+$/, ""),
    )
    .filter((word) =>
      /[/_@]|\d\.\d|^\.\w|[A-Za-z0-9]{2,}\.[A-Za-z0-9]/.test(word),
    );
}

/** The code spans of a line, such as `npm test`, with their backticks. */
export function spans(text) {
  return text.match(/`[^`]+`/g) ?? [];
}

/** The links of a line, such as https://example.com/a. */
export function links(text) {
  return text.match(/\bhttps?:\/\/[^\s<>"'`]+/gi) ?? [];
}

/** A piece of a line for the log, quoted and short. */
function quoted(piece) {
  return JSON.stringify(piece.length > 60 ? `${piece.slice(0, 59)}…` : piece);
}

/** The references of a line for the log, such as #12 #791, or none. */
function listed(found) {
  return found === "" ? "none" : `#${found.replaceAll(" ", " #")}`;
}

/**
 * Why a translated line, folded, doesn't keep its English line, or "" when it does:
 * it says something, fits the pager, and keeps every reference, code span and name
 * of code of the English, and adds no reference and no link.
 */
export function lost(english, translated) {
  if (translated === "") {
    return "is empty";
  }
  if (translated.length > NOTES.translated) {
    return `has more than ${NOTES.translated} characters`;
  }
  const kept = references(translated);
  if (kept !== references(english)) {
    return `has the references ${listed(kept)} for ${listed(references(english))}`;
  }
  const missing = [...spans(english), ...names(english)].find(
    (piece) => !translated.includes(piece),
  );
  if (missing !== undefined) {
    return `lost ${quoted(missing)}`;
  }
  const added = links(translated).find((link) => !english.includes(link));
  return added === undefined ? "" : `adds the link ${quoted(added)}`;
}

/**
 * The lines of a translation, folded as the pager shows them, when every line
 * keeps its English line and all together fit the message; otherwise null, and
 * why not.
 */
export function checkTranslation(english, translated) {
  if (translated.length !== english.length) {
    const count =
      translated.length === 1 ? "1 line" : `${translated.length} lines`;
    return {
      lines: null,
      why: `the translation has ${count} for ${english.length}`,
    };
  }
  const lines = translated.map(fold);
  for (const [at, line] of lines.entries()) {
    const why = lost(english[at], line);
    if (why !== "") {
      return { lines: null, why: `line ${at + 1} of the translation ${why}` };
    }
  }
  const length = (all) => all.reduce((sum, line) => sum + line.length, 0);
  const most = length(english) + NOTES.shown;
  if (length(lines) > most) {
    return {
      lines: null,
      why: `the translation has more than ${most} characters`,
    };
  }
  return { lines, why: "" };
}
