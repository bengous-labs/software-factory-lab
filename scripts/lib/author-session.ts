/**
 * What makes a session an Author: its environment holds `LAB_AUTHOR=1`. The launcher gives it through
 * the `env` of the settings file it passes at launch. Nothing else makes a session an Author: not its
 * branch, not being interactive, not being in the background.
 */
export const AUTHOR_VARIABLE = "LAB_AUTHOR";

export function isAuthor(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[AUTHOR_VARIABLE] === "1";
}
