/** A Bash tool call as a PreToolUse hook reads it: its command, cut into simple commands and operators. */

import { objectAt, optionalStringAt, parseJson, stringAt } from "./plain-json.ts";

const SOURCE = "the PreToolUse input";

/** The Bash command the tool call on `stdin` runs, and the directory it runs in. */
export function bashCallOf(stdin: string) {
  const input = objectAt(SOURCE, parseJson(SOURCE, stdin));
  const cwd = stringAt(SOURCE, input, "cwd");
  const toolInput = objectAt(SOURCE, input["tool_input"], ["tool_input"]);

  return { command: optionalStringAt(SOURCE, toolInput, "command", ["tool_input"]) ?? "", cwd };
}

/** A shell control operator, newline read as `;`. */
type Operator = "&&" | "||" | ";" | "|" | "&" | "(" | ")";

/** One part of a Bash command: a simple command's words, or the operator between two. */
export type Part = readonly string[] | Operator;

/** The one-character operators, by the character that spells them. */
const OPERATORS: ReadonlyMap<string, Operator> = new Map([
  [";", ";"],
  ["\n", ";"],
  ["&", "&"],
  ["|", "|"],
  ["(", "("],
  [")", ")"],
]);

/** The operator that starts at `command[index]`, or null when none does. */
function operatorAt(command: string, index: number): Operator | null {
  const char = command[index] ?? "";

  if ((char === "&" || char === "|") && command[index + 1] === char) {
    return char === "&" ? "&&" : "||";
  }

  return OPERATORS.get(char) ?? null;
}

/** `command` cut into simple commands, each a list of words with quotes removed, and the operators between them. */
export function partsOf(command: string): readonly Part[] {
  const parts: Part[] = [];
  let words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;

  const endWord = () => {
    if (word !== null) {
      words.push(word);
      word = null;
    }
  };

  const endCommand = () => {
    endWord();

    if (words.length > 0) {
      parts.push(words);
      words = [];
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const operator = quote === null ? operatorAt(command, index) : null;

    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        word = (word ?? "") + char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (operator !== null) {
      endCommand();
      parts.push(operator);
      index += operator.length - 1;
    } else if (/\s/u.test(char)) {
      endWord();
    } else {
      word = (word ?? "") + char;
    }
  }

  endCommand();

  return parts;
}
