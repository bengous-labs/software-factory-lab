/** Marks a reply as posted for the Author, so the relay of the Author's PR does not deliver it back. */
export const AUTHOR_MARK = "<!-- lab-author-reply -->";

/** Marks the author's reply as a rejection of the finding, so the Review check counts it apart from a fix. */
export const REJECT_MARK = "<!-- lab-author-reject -->";
