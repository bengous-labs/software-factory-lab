/** Marks a reply as posted for the Author, so the relay of the Author's PR does not deliver it back. */
export const AUTHOR_MARK = "<!-- lab-author-reply -->";

/** Marks the comment that puts the Author's question to the Owner, so a later stop does not post it again. */
export const QUESTION_MARK = "<!-- lab-author-question -->";

/** Marks the author's reply as a rejection of the finding, so the Review check counts it apart from a fix. */
export const REJECT_MARK = "<!-- lab-author-reject -->";

/** Opens the hidden list, in the Stop hook's one comment on a PR, of the findings the Author says it fixed. */
export const FIXED_MARK = "<!-- lab-author-fixed";
