/**
 * Git's configuration for a fixture repository, through its environment: no commit is signed. A
 * fixture's commit needs no signature, and where the user's own git configuration asks for one the
 * signing key can be out of reach: in a Worker's sandbox, whose own unsigned configuration goes with
 * the `GIT_` variables.
 */
const UNSIGNED = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" };

/**
 * `env` without its `GIT_` variables, for a git run on a test's fixture repository: an inherited
 * `GIT_DIR`, which a git hook or `git rebase --exec` exports, would point that git at the real one. The
 * one configuration it gives git is `UNSIGNED`.
 */
export function fixtureEnv(env: Readonly<Partial<Record<string, string>>>): Record<string, string> {
  return Object.fromEntries([
    ...Object.entries(env).flatMap(([name, value]) =>
      name.startsWith("GIT_") || value === undefined ? [] : [[name, value] as const],
    ),
    ...Object.entries(UNSIGNED),
  ]);
}
