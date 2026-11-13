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

/** The directory under `~/.config/` that holds the Author's token and the Worker settings files. */
export const CONFIG_DIR = "software-factory-lab";

/** The file under the Owner's home that holds the Console API key an API Worker bills, by its path from that home. */
export const API_KEY_FILE = ".api-agent/key";

/** The directory under the Owner's home that holds the clone of each Worker, background or API, by its path from that home. */
export const API_CLONES_DIR = `.local/share/${CONFIG_DIR}/api-workers`;
