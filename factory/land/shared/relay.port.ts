/** The relay a Publication leaves for its PR, and the session its Wakes go to. */
export interface RelayStart {
  readonly pr: number;
  /** The session that published: the relay starts its turns there. */
  readonly session: string;
  /** The repository's main checkout, where the relay runs and keeps its state. */
  readonly checkout: string;
}

/** Leaves one detached relay for the PR; `running` when one already watches it, and none is started. */
export type StartRelay = (relay: RelayStart) => "started" | "running";
