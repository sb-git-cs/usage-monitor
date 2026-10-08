package io.github.sbgitcs.usagemonitor.model

enum class MeterSignIn { SIGNED_IN, LAST_KNOWN, SIGNED_OUT, UNVERIFIED }

/**
 * Account identity is evidence only for the source that supplied this reading: the computer,
 * this phone reading directly with the computer's sign-in, or a sign-in made on this phone.
 */
data class MeterConnection(val source: String, val signIn: MeterSignIn) {
    /** For tight spaces such as widgets. */
    val shortSource: String get() = when (source) {
        "Computer" -> "PC"
        "Not connected" -> "—"
        else -> source
    }

    val signInLabel: String get() = when (signIn) {
        MeterSignIn.SIGNED_IN -> "Signed in"
        MeterSignIn.LAST_KNOWN -> "Signed in · last known"
        MeterSignIn.SIGNED_OUT -> "Not signed in"
        MeterSignIn.UNVERIFIED -> "Sign-in unverified"
    }

    companion object {
        fun from(provider: Provider?): MeterConnection {
            val source = when {
                provider == null -> "Not connected"
                provider.source == "phone" -> "Phone"
                provider.source == "linked" -> "Direct"
                else -> "Computer"
            }
            val signIn = when {
                provider == null || provider.state in setOf("logged_out", "not_installed") -> MeterSignIn.SIGNED_OUT
                provider.state == "ok" && (!provider.account.isNullOrBlank() || provider.currentWindow() != null || provider.usageSummary != null) -> MeterSignIn.SIGNED_IN
                provider.state == "stale" && !provider.account.isNullOrBlank() -> MeterSignIn.LAST_KNOWN
                else -> MeterSignIn.UNVERIFIED
            }
            return MeterConnection(source, signIn)
        }
    }
}
