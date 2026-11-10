/**
 * The lab's logins as GraphQL prints them, for the code that runs outside the Merge bot's workflow,
 * which names them in `OWNER`, `AUTHOR_LOGIN` and `APP_LOGIN`. The lab is public: any GitHub login can
 * comment on a pull request, and only these three are read as the factory's own.
 */

/** The Owner, the one human of the factory. */
export const OWNER_LOGIN = "bengous";

/** The Author's machine account, which the Stop hook publishes and answers as. */
export const AUTHOR_LOGIN = "bengous-labs-author";

/** The agents' App, without REST's `[bot]` suffix. */
export const APP_LOGIN = "bengous-labs-agents";
