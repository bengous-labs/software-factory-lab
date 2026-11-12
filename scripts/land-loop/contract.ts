/**
 * The names the factory stores outside its code, each in its one place: GitHub's ruleset, the labels and
 * checks of open pull requests, posted comments and existing state records hold them, so each keeps its
 * spelling whatever the code calls the thing. A step reads another step's work through these names, never
 * through its code. `stored-names.test.ts` pins each value.
 */

/** Who lands a change: `auto`, the Merge bot alone, or `owner`, with a Land approval. */
export type LandRoute = "auto" | "owner";

/**
 * The Land route as the `land:*` labels and the state record store it. An external name: open PRs
 * and existing records carry `human` for `owner`, so the stored value stays; anything but `auto`
 * reads as `owner`, the safe side.
 */
export type StoredLandRoute = "auto" | "human";

export const landRouteOf = (stored: string): LandRoute => (stored === "auto" ? "auto" : "owner");

export const storedLandRouteOf = (route: LandRoute): StoredLandRoute => (route === "auto" ? "auto" : "human");

export type ReviewDepth = "none" | "light" | "deep";

/** The label that carries a Land route. An external name: open PRs carry it, so the string stays. */
export const landLabelOf = (route: LandRoute): string => `land:${storedLandRouteOf(route)}`;

/** The label that carries a Review depth. An external name: open PRs carry it, so the string stays. */
export const reviewLabelOf = (depth: ReviewDepth): string => `review:${depth}`;

/** The label of a Land approval. An external name: the owner puts it by hand, so the string stays. */
export const LAND_APPROVAL_LABEL = "land-ok";

/** The Review check's name. An external name: GitHub's ruleset requires it, so the string stays. */
export const REVIEW_CHECK = "agent-review";

/** The Land gate's check name. An external name: GitHub's ruleset requires it, so the string stays. */
export const LAND_GATE = "land-gate";

/**
 * The CI checks a change lands on, the jobs of `.github/workflows/ci.yml`. External names: the workflow
 * names its jobs so, so the strings stay. The ruleset requires `validate` alone; the Land gate waits for both.
 */
export const CI_CHECKS = ["validate", "mutation"] as const;

/**
 * The review job's number for the Delta read of a push after Review round 3: the job, its artifact and
 * its posted marker are keyed by a number, but the Delta read is no round, and the state record never
 * counts it among the three.
 */
export const DELTA_READ = 4;

/** The state record's marker. An external name: existing PR records carry it, so the string stays. */
export const MERGE_BOT_STATE_MARKER = "<!-- lab-conductor-state";

/** The marker of the App's reply that lands a finding open. An external name: posted replies carry it, so the string stays. */
export const LANDED_OPEN_MARKER = "<!-- lab-landed-open -->";
