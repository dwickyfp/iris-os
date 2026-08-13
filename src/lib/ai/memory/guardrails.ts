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

export function sanitizeMemoryContent(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 2_000);
}
