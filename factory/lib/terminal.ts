/** `text` without its control characters: an issue title is written by its author, and printed to a terminal. */
export function printableOf(text: string): string {
  return text.replaceAll(/\p{Cc}/gu, "");
}
