// Shared prompt-definition helpers — deterministic readers for the tunable
// LLM prompt text that lives in maintainer-definitions/*.md, bundled as raw
// text by esbuild's ".md" loader. Keeping prompts in markdown separates
// objective code from fine-tune parameters.

/** The markdown marker that delimits one prompt template in a definition
 * file. Sections are "## <name>" blocks; the body runs to the next "## "
 * heading or the end of the file. */
const SECTION_HEADING_PREFIX = "## ";
/** Placeholder pattern for fillTemplate — {name} tokens. */
const PLACEHOLDER_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Error text when a definition file lacks a requested section heading. */
const MISSING_SECTION_ERROR = (heading: string): string =>
  `Prompt definition file has no "## ${heading}" section`;

// readPromptSection: extract the body of a "## <heading>" section, trimmed,
// up to the next line that starts with "## " (a section boundary) or the end
// of the file. Only line-anchored "## " lines count as boundaries so prompt
// text that mentions "## ..." mid-line (e.g. the global-query heading hint)
// does not truncate the section. Throws on a missing heading so a typo in a
// definition file fails loudly at load time.
export function readPromptSection(markdown: string, heading: string): string {
  const target = `${SECTION_HEADING_PREFIX}${heading}`;
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line === target);
  if (start === -1) throw new Error(MISSING_SECTION_ERROR(heading));
  const end = lines.findIndex((line, i) => i > start && line.startsWith(SECTION_HEADING_PREFIX));
  const bodyEnd = end === -1 ? lines.length : end;
  return lines.slice(start + 1, bodyEnd).join("\n").trim();
}

// fillTemplate: replace every {name} placeholder in the template with the
// matching params value; placeholders without a params key are kept as-is.
export function fillTemplate(template: string, params: Record<string, string>): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
    name in params ? params[name] : match,
  );
}
