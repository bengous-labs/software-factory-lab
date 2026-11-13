/** What the relay needs to resume an API Worker's session headless. */
export interface HeadlessSession {
  /** The model its turns run on; null when its transcript names none. */
  readonly model: string | null;
  /** The worktree it was launched in, where Claude Code keeps its conversation. */
  readonly worktree: string;
}

/** The relay a Publication leaves for its PR, and the session its Wakes go to. */
export interface RelayStart {
  readonly pr: number;
  /** The session that published: the relay starts its turns there. */
  readonly session: string;
  /** Set when that session is an API Worker's, which only a headless resume wakes; null for any other. */
  readonly headless: HeadlessSession | null;
  /**
   * The clone a background Worker's session works in, where a resume finds it; null for an API Worker's,
   * whose headless resume names its own, and for a session that works in the relay's own checkout.
   */
  readonly clone: string | null;
  /** The repository's main checkout, where the relay runs and keeps its state. */
  readonly checkout: string;
}

/** Leaves one detached relay for the PR; `running` when one already watches it, and none is started. */
export type StartRelay = (relay: RelayStart) => "started" | "running";
