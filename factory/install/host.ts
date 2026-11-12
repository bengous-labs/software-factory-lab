/**
 * What names the repository the factory is installed in. Every other source file of the factory takes these
 * from here (`host-names.test.ts`), so installing the factory elsewhere changes this directory alone.
 */

/** The repository, as GitHub names it: its owner, then its name. */
export const REPOSITORY = "bengous-labs/software-factory-lab";

/** The Trunk: the branch changes land on. */
export const TRUNK = "dev";

/** The release branch, which no agent publishes. */
export const RELEASE_BRANCH = "main";

/** The directory under `~/.config/` that holds the Author's token and the Worker settings file. */
export const CONFIG_DIR = "software-factory-lab";
