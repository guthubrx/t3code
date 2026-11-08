/** One title policy for native and externally managed subagents. */
export function subagentThreadTitle(input: {
  readonly parentTitle: string;
  readonly title?: string | null;
  readonly prompt: string;
  readonly ordinal: number;
}): string {
  const detail = (
    input.title?.trim() ||
    input.prompt.trim() ||
    `${input.parentTitle} subagent ${input.ordinal}`
  ).replace(/\s+/gu, " ");
  if (detail.length <= 72) return detail;
  let end = 69;
  const previous = detail.charCodeAt(end - 1);
  const next = detail.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  const word = detail.lastIndexOf(" ", end);
  if (word >= 36) end = word;
  return `${detail.slice(0, end).trimEnd()}...`;
}
