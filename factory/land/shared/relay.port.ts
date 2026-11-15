/** What the relay needs to resume the session of a Worker Dispatch launched, which is headless. */
export interface HeadlessSession {
  /** The model its turns run on; null when its transcript names none. */
  readonly model: string | null;
  /** The worktree it was launched in, where Claude Code keeps its conversation. */
  readonly worktree: string;
  /** Its turns bill the Owner's API key: the relay resumes it on the API Worker settings file. */
  readonly api: boolean;
}

/** The relay a Publication leaves for its PR, and the session its Wakes go to. */
export interface RelayStart {
  readonly pr: number;
  /** The session that published: the relay starts its turns there. */
  readonly session: string;
  /** Set when that session is a Worker's in a clone, which only a headless resume wakes; null for any other. */
  readonly headless: HeadlessSession | null;
  /** The repository's main checkout, where the relay runs and keeps its state. */
  readonly checkout: string;
}

/** Leaves one detached relay for the PR; `running` when one already watches it, and none is started. */
export type StartRelay = (relay: RelayStart) => "started" | "running";
