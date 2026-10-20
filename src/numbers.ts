// Splits prose so its numbers can wear a monospace accent, as on joshwcomeau.com: "2 h 29 min", "41%", "7:32 am", "4 plays".
// A number joined to a word, such as the 9 in K9, the 4 in 4th or the 10 in 10x, is left alone.
const numberPattern = /(?<![\p{L}\p{N}])\d+(?:[.,:]\d+)?(?:\s?(?:%|h\b(?:\s\d+\s?min\b)?|min\b|minutes\b|hours?\b|days?\b|points?\b|plays?\b|am\b|pm\b))?(?![\p{L}\p{N}]|[.,:]\p{N})/gu;

export interface TextPart { text: string; number: boolean }
export function numberParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(numberPattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), number: false });
    parts.push({ text: match[0], number: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), number: false });
  return parts;
}
