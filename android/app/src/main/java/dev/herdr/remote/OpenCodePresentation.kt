package dev.herdr.remote

/** Archived caller compatibility. OpenCode output receives no special interpretation. */
internal fun openCodePresentation(text: String): TerminalPresentation = terminalPresentation(text, "opencode")
