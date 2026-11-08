/** Marks a reply as the author's own, so the author's PR watch does not print it back. */
export const AUTHOR_MARK = "<!-- lab-author-reply -->";

/** Marks the author's reply as a rejection of the finding, so the Review check counts it apart from a fix. */
export const REJECT_MARK = "<!-- lab-author-reject -->";
