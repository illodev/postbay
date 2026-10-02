/**
 * The instructions an agent gets are a template per brand, filled in with what this request is about. A template is
 * plain text (Markdown works well) with {{name}} placeholders; a name that is not one of these is an error when the runner
 * starts, not a blank at two in the morning.
 */
export const TEMPLATE_VARIABLES = [
  'brand', 'piece_title', 'piece_brief', 'piece_kind', 'format', 'style', 'version_number', 'round', 'max_rounds', 'max_minutes', 'max_cost', 'currency',
  'reason', 'note', 'requested_by', 'comments', 'people_only', 'previous_files', 'requirements', 'checklist', 'failures', 'result_format',
  'input_dir', 'output_dir', 'sources_dir', 'run_dir',
  'slot', 'slot_day', 'campaigns',
  // A piece made from a project: its `source` as the studio has it, the directory the agent works in (absolute, as the agent sees it)
  // and, in git mode, the piece's branch. Empty for a piece without a project.
  'source', 'project_dir', 'project_branch',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function unknownVariables(template: string): string[] {
  const known = new Set<string>(TEMPLATE_VARIABLES);
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((n) => !known.has(n)))];
}

export function render(template: string, vars: Partial<Record<TemplateVariable, string>>): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => vars[name as TemplateVariable] ?? '');
}

/** What the agent must write for the runner to pick its work up: the same text goes into every template. */
export const RESULT_FORMAT = `When you are done, write \`result.json\` in the output directory:

\`\`\`json
{
  "notes": "What you changed, in a sentence or two, for the reviewers.",
  "comments": [
    { "id": "<comment id>", "status": "fixed", "reply": "What you did about it." },
    { "id": "<comment id>", "status": "cannot_do", "reply": "Why you cannot, specifically." },
    { "id": "<comment id>", "status": "needs_human", "reply": "What a person has to decide or do." }
  ],
  "cost": 0.12
}
\`\`\`

Put the new files in the output directory (a video, images for a carousel, a PDF, subtitles as .vtt or .srt, a cover image named cover.png or cover.jpg).
Every comment listed under "Comments for you" must appear in "comments": one you cannot settle is \`needs_human\`, never left out.
Do not touch comments listed under "For people only".`;
