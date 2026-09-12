const SENSITIVE = [
  /\b(password|passcode|api[ _-]?key|secret|token)\b/i,
  /\b(card number|credit card|rekening|nomor rekening|nik|passport)\b/i,
  /\b(diagnosis|medical record|kondisi medis|kesehatan mental)\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
];

const INSTRUCTION =
  /\b(ignore (previous|all)|system prompt|you are chatgpt|execute|run this command|jailbreak)\b/i;

export function isSafeMemoryContent(content: string) {
  return (
    !SENSITIVE.some((pattern) => pattern.test(content)) &&
    !INSTRUCTION.test(content)
  );
}

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const LONG_DIGITS = /\b\d[\d\s-]{6,}\d\b/g;

/**
 * Beyond the blocklist, actively redacts common PII shapes (email addresses
 * and long digit runs such as phone/account numbers) so stored text is safe
 * even when a pattern above does not match.
 */
export function redactPII(content: string) {
  return content
    .replace(EMAIL, "[redacted-email]")
    .replace(LONG_DIGITS, "[redacted-number]");
}

export function sanitizeMemoryContent(content: string) {
  return redactPII(content.replace(/\s+/g, " ").trim()).slice(0, 2_000);
}
