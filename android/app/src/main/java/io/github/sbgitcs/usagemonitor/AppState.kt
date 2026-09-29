package io.github.sbgitcs.usagemonitor

/** Set by MainActivity; lets background code decide between opening a screen and posting a notification. */
object AppState {
    @Volatile var foreground: Boolean = false
}
