/**
 * `env` without its `GIT_` variables, for a git run on a test's fixture repository: an inherited
 * `GIT_DIR`, which a git hook or `git rebase --exec` exports, would point that git at the real one.
 */
export function fixtureEnv(env: Readonly<Partial<Record<string, string>>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      name.startsWith("GIT_") || value === undefined ? [] : [[name, value] as const],
    ),
  );
}
