import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function splitOversized(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value];
  const result: string[] = [];
  for (let offset = 0; offset < value.length; offset += maxChars) result.push(value.slice(offset, offset + maxChars));
  return result;
}

export function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sections = text.split(/(?=^#{1,6}\s)/m);
  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    if (current && current.length + section.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    if (section.length > maxChars) {
      if (current) chunks.push(current);
      current = "";
      chunks.push(...splitOversized(section, maxChars));
    } else {
      current += section;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

export function isCompleteTranslation(text: string, source: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (value.includes("__AGENT_TRANSLATE_INCOMPLETE__")) return false;
  // A provider that echoes the control marker or cuts off at a JSON fence is not accepted.
  if (value.endsWith("```json") || value.endsWith("```yaml")) return false;
  // Empty/whitespace-only output is the only universal failure. Russian is allowed in code and proper nouns.
  return source.trim().length === 0 || value.length > 0;
}

export function buildTranslationPrompt(text: string, glossary = ""): { system: string; prompt: string } {
  const system = [
    "You are a translation sub-agent. Translate Russian text to clear natural English.",
    "Preserve Markdown structure, headings, code fences, links, URLs, identifiers, file paths, and placeholders exactly.",
    "Do not summarize, explain, omit, reorder, or add content.",
    "Return only the complete translated text, followed by the exact marker __AGENT_TRANSLATE_DONE__.",
    glossary.trim() ? `Glossary:\n${glossary.trim()}` : "",
  ].filter(Boolean).join("\n\n");
  return { system, prompt: `${text}\n\nTranslate every character-bearing part and finish with __AGENT_TRANSLATE_DONE__.` };
}

export function stripCompletionMarker(text: string): string {
  return text.replace(/\s*__AGENT_TRANSLATE_DONE__\s*$/u, "").trimEnd();
}
