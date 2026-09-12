import type { TraceEvent } from "./model";

const OWN_ORIGIN = "geode-wikiskill";
const PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\b(?:token|api[_-]?key|password)\s*[=:]\s*[^\s]+/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

export function eligibleTrace(
  trace: Pick<TraceEvent, "origin" | "projectId">,
  consentedProjects: ReadonlySet<string>,
): boolean {
  return (
    trace.origin !== OWN_ORIGIN &&
    Boolean(trace.projectId && consentedProjects.has(trace.projectId))
  );
}

export function redactTrace(
  input: string,
  configuredSecrets: readonly string[],
): { text: string; redactions: number } {
  let text = input;
  let redactions = 0;
  const replace = (pattern: RegExp): void => {
    text = text.replace(pattern, () => {
      redactions += 1;
      return "[REDACTED]";
    });
  };
  for (const secret of configuredSecrets.filter((value) => value.length >= 4))
    replace(new RegExp(escapeRegExp(secret), "g"));
  for (const pattern of PATTERNS) replace(pattern);
  // The second pass is intentional: provider-side redaction is not trusted as a complete privacy boundary.
  for (const pattern of PATTERNS) replace(pattern);
  return { text, redactions };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
