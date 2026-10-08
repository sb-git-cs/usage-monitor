package io.github.sbgitcs.usagemonitor.direct

import android.content.Context
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.widget.Widgets

/**
 * What a sign-in in progress asks for: open [url], then type [code] there (device sign-in), or
 * paste back the code the page shows ([needsPaste]).
 */
data class SignInStep(
    val provider: String,
    val url: String? = null,
    val code: String? = null,
    val needsPaste: Boolean = false,
    val done: Boolean = false,
    val error: String? = null,
    val busy: Boolean = false,
    val notice: String? = null,
)

/**
 * Signs this phone in to a tool the way its own command-line sign-in does, so usage can be read
 * without the computer. Each phone sign-in is separate from the computer's and has its own tokens.
 * Gemini is not offered: its Google sign-in needs the Antigravity client secret.
 */
object PhoneSignIn {
    val providers = listOf("claude", "codex", "grok", "cursor")

    private const val CLAUDE_CLIENT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    private const val CLAUDE_REDIRECT = "https://platform.claude.com/oauth/code/callback"
    private const val CLAUDE_TOKEN = "https://platform.claude.com/v1/oauth/token"
    private const val CLAUDE_PROFILE = "https://api.anthropic.com/api/oauth/profile"
    // Reading usage needs only the profile scope, not inference.
    private const val CLAUDE_SCOPE = "user:profile"
    private const val OPENAI = "https://auth.openai.com"
    private const val CODEX_CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann"
    private const val XAI = "https://auth.x.ai/oauth2"
    private const val GROK_CLIENT = "b1a00492-073a-47ea-816f-4c329264a828"
    private const val GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val random = SecureRandom()
    private val _step = MutableStateFlow<SignInStep?>(null)
    val step: StateFlow<SignInStep?> = _step
    private var job: Job? = null
    private var pasted: CompletableDeferred<String>? = null
    private var attempt = 0L

    /** Starts signing in to [provider]; the result is saved in the vault and [step] reports progress. */
    fun start(context: Context, provider: String, http: Http = UrlHttp) {
        val app = context.applicationContext
        start(provider, http) { credential, reading ->
            PlanReadings.saveSignIn(app, Settings(app), credential, reading)
            Widgets.refresh(app)
        }
    }

    @Synchronized
    internal fun start(provider: String, http: Http, save: suspend (Credential, UsageResult) -> Unit) {
        cancel()
        val currentAttempt = attempt
        val waiting = CompletableDeferred<String>()
        pasted = waiting
        fun report(value: SignInStep) = synchronized(this) {
            if (attempt != currentAttempt) throw kotlinx.coroutines.CancellationException()
            _step.value = value
        }
        _step.value = SignInStep(provider)
        job = scope.launch {
            try {
                val c = when (provider) {
                    "claude" -> claude(http, ::report) { waiting.await() }
                    "codex" -> codex(http, ::report)
                    "grok" -> grok(http, ::report)
                    "cursor" -> cursor(http, ::report)
                    else -> throw IOException("This tool cannot be signed in on the phone.")
                }
                currentCoroutineContext().ensureActive()
                report(SignInStep(provider, busy = true))
                val reading = UsageApi(http).fetch(c)
                currentCoroutineContext().ensureActive()
                if (reading is UsageResult.AuthFailed) throw IOException("The service did not accept this sign-in for usage. Sign in again.")
                save(c, reading)
                currentCoroutineContext().ensureActive()
                report(SignInStep(provider, done = true, notice = (reading as? UsageResult.Failed)?.let {
                    "Sign-in saved. Usage is not available yet: ${it.message}. The phone will retry automatically."
                }))
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                report(SignInStep(provider, error = e.message ?: "Sign-in failed."))
            }
        }
    }

    /** The code the Claude page shows after approval. */
    @Synchronized
    fun paste(code: String) {
        val current = _step.value ?: return
        if (!current.needsPaste || code.isBlank()) return
        _step.value = current.copy(needsPaste = false, busy = true)
        pasted?.complete(code.trim())
    }

    @Synchronized
    fun cancel() {
        attempt++
        job?.cancel()
        job = null
        pasted = null
        _step.value = null
    }

    internal suspend fun claude(http: Http, report: (SignInStep) -> Unit, awaitCode: suspend () -> String): Credential {
        val verifier = randomText(32)
        val state = randomText(16)
        val url = "https://claude.com/cai/oauth/authorize?code=true&client_id=$CLAUDE_CLIENT&response_type=code" +
            "&redirect_uri=${enc(CLAUDE_REDIRECT)}&scope=${enc(CLAUDE_SCOPE)}&code_challenge=${challenge(verifier)}" +
            "&code_challenge_method=S256&state=$state"
        report(SignInStep("claude", url = url, needsPaste = true))
        val code = claudeCode(awaitCode(), state)
        val tokens = postJson(http, CLAUDE_TOKEN, JSONObject().put("grant_type", "authorization_code").put("code", code)
            .put("redirect_uri", CLAUDE_REDIRECT).put("client_id", CLAUDE_CLIENT).put("code_verifier", verifier).put("state", state))
        val access = accessToken(tokens)
        val profile = runCatching {
            JSONObject(http.send("GET", CLAUDE_PROFILE, mapOf("Authorization" to "Bearer $access", "anthropic-beta" to "oauth-2025-04-20"), null).text())
        }.getOrNull()
        return Credential("claude", TokenVault.PHONE, access, tokens.optString("refresh_token").ifEmpty { null },
            expiry(tokens), plan = profile?.let(::claudePlan),
            account = profile?.optJSONObject("account")?.optString("email")?.ifEmpty { null }
                ?: tokens.optJSONObject("account")?.optString("email_address")?.ifEmpty { null })
    }

    /** Accept the displayed code#state or the provider callback URL, never an arbitrary URL. */
    internal fun claudeCode(answer: String, state: String): String {
        val raw = answer.trim()
        val code: String
        val returnedState: String?
        if (raw.startsWith("https://")) {
            val uri = runCatching { URI(raw) }.getOrNull()
                ?: throw IOException("Paste the complete code from the approval page.")
            if (uri.scheme != "https" || uri.host != "platform.claude.com" || uri.path != "/oauth/code/callback" || uri.userInfo != null || uri.port != -1)
                throw IOException("Paste the code or callback URL from the Claude approval page.")
            val fields = uri.rawQuery.orEmpty().split('&').associate {
                URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('=', ""), "UTF-8")
            }
            code = fields["code"].orEmpty()
            returnedState = fields["state"] ?: uri.fragment
        } else {
            code = raw.substringBefore('#')
            returnedState = if ('#' in raw) raw.substringAfter('#') else null
        }
        if (returnedState != null && returnedState != state) throw IOException("That code is from another sign-in. Start again and copy the new code.")
        if (!code.matches(Regex("[A-Za-z0-9_-]+"))) throw IOException("Paste the complete code from the approval page, without any extra text.")
        return code
    }

    /** Codex's device sign-in: type a code at auth.openai.com/codex/device. */
    private suspend fun codex(http: Http, report: (SignInStep) -> Unit): Credential {
        val start = postJson(http, "$OPENAI/api/accounts/deviceauth/usercode", JSONObject().put("client_id", CODEX_CLIENT))
        val id = start.getString("device_auth_id")
        val userCode = start.optString("user_code").ifEmpty { start.getString("usercode") }
        report(SignInStep("codex", url = "$OPENAI/codex/device", code = userCode))
        val interval = start.optString("interval").toLongOrNull()?.coerceIn(1, 30) ?: 5
        val grant = poll(15 * 60 / interval.toInt(), { interval * 1000 }) {
            val r = http.send("POST", "$OPENAI/api/accounts/deviceauth/token", JSON,
                JSONObject().put("device_auth_id", id).put("user_code", userCode).toString().toByteArray())
            when (r.status) {
                200 -> JSONObject(r.text())
                403, 404 -> null
                else -> throw IOException("Codex sign-in failed (HTTP ${r.status}).")
            }
        }
        val tokens = postForm(http, "$OPENAI/oauth/token", mapOf("grant_type" to "authorization_code",
            "code" to grant.getString("authorization_code"), "redirect_uri" to "$OPENAI/deviceauth/callback",
            "client_id" to CODEX_CLIENT, "code_verifier" to grant.getString("code_verifier")))
        return codexCredential(tokens, null)
    }

    private fun codexCredential(tokens: JSONObject, previous: Credential?): Credential {
        val access = accessToken(tokens)
        val id = tokens.optString("id_token").ifEmpty { null }?.let(::claims)
        val auth = id?.optJSONObject("https://api.openai.com/auth")
        return Credential("codex", TokenVault.PHONE, access, tokens.optString("refresh_token").ifEmpty { previous?.refreshToken },
            claims(access)?.optLong("exp")?.takeIf { it > 0 }?.times(1000),
            accountId = auth?.optString("chatgpt_account_id")?.ifEmpty { null } ?: previous?.accountId,
            account = id?.optString("email")?.ifEmpty { null } ?: previous?.account)
    }

    /** Grok's device sign-in (RFC 8628) with the Grok Build command line's public client. */
    private suspend fun grok(http: Http, report: (SignInStep) -> Unit): Credential {
        val start = postForm(http, "$XAI/device/code", mapOf("client_id" to GROK_CLIENT, "scope" to GROK_SCOPE))
        val device = start.getString("device_code")
        report(SignInStep("grok", url = start.optString("verification_uri_complete").ifEmpty { start.getString("verification_uri") },
            code = start.optString("user_code").ifEmpty { null }))
        var interval = start.optLong("interval", 5).coerceIn(1, 30)
        val tries = (start.optLong("expires_in", 900) / interval).toInt().coerceAtLeast(1)
        val tokens = poll(tries, { interval * 1000 }) {
            val r = form(http, "$XAI/token", mapOf("grant_type" to "urn:ietf:params:oauth:grant-type:device_code",
                "device_code" to device, "client_id" to GROK_CLIENT))
            val body = runCatching { JSONObject(r.text()) }.getOrNull()
            when {
                r.status == 200 && body != null -> body
                body?.optString("error") == "authorization_pending" -> null
                body?.optString("error") == "slow_down" -> { interval += 5; null }
                else -> throw IOException(body?.optString("error_description")?.ifEmpty { null } ?: "Grok sign-in failed (HTTP ${r.status}).")
            }
        }
        return grokCredential(tokens, null)
    }

    private fun grokCredential(tokens: JSONObject, previous: Credential?): Credential {
        val access = accessToken(tokens)
        val id = tokens.optString("id_token").ifEmpty { null }?.let(::claims)
        return Credential("grok", TokenVault.PHONE, access, tokens.optString("refresh_token").ifEmpty { previous?.refreshToken },
            expiry(tokens), userId = claims(access)?.optString("sub")?.ifEmpty { null },
            account = id?.optString("email")?.ifEmpty { null } ?: previous?.account)
    }

    /** Cursor's browser sign-in: approve on cursor.com while the phone waits for the result. */
    private suspend fun cursor(http: Http, report: (SignInStep) -> Unit): Credential {
        val verifier = randomText(32)
        val uuid = UUID.randomUUID().toString()
        report(SignInStep("cursor", url = "https://cursor.com/loginDeepControl?challenge=${challenge(verifier)}&uuid=$uuid&mode=login&redirectTarget=cli"))
        var wait = 1000L
        val tokens = poll(150, { wait.also { wait = (wait * 1.2).toLong().coerceAtMost(10_000) } }) {
            val r = http.send("GET", "https://api2.cursor.sh/auth/poll?uuid=$uuid&verifier=$verifier", JSON, null)
            when (r.status) {
                200 -> JSONObject(r.text()).takeIf { it.optString("accessToken").isNotEmpty() }
                404 -> null
                else -> throw IOException("Cursor sign-in failed (HTTP ${r.status}).")
            }
        }
        val access = tokens.getString("accessToken")
        // Cursor's session lasts 60 days; then the phone asks to sign in again.
        return Credential("cursor", TokenVault.PHONE, access, null, claims(access)?.optLong("exp")?.takeIf { it > 0 }?.times(1000))
    }

    /**
     * Renews a phone sign-in. Returns null when the tool no longer accepts it (sign in again);
     * throws IOException when the tool could not be reached, so the old token is kept for later.
     */
    fun renew(c: Credential, http: Http = UrlHttp): Credential? {
        val refresh = c.refreshToken ?: return null
        val r = when (c.provider) {
            "claude" -> http.send("POST", CLAUDE_TOKEN, JSON, JSONObject().put("grant_type", "refresh_token")
                .put("refresh_token", refresh).put("client_id", CLAUDE_CLIENT).put("scope", CLAUDE_SCOPE).toString().toByteArray())
            "codex" -> http.send("POST", "$OPENAI/oauth/token", JSON, JSONObject().put("client_id", CODEX_CLIENT)
                .put("grant_type", "refresh_token").put("refresh_token", refresh).put("scope", "openid profile email").toString().toByteArray())
            "grok" -> form(http, "$XAI/token", mapOf("grant_type" to "refresh_token", "refresh_token" to refresh, "client_id" to GROK_CLIENT))
            else -> return null
        }
        val tokens = runCatching { JSONObject(r.text()) }.getOrNull()
        val error = tokens?.optString("error")
        if (r.status in setOf(400, 401) && error in setOf("invalid_grant", "invalid_token", "refresh_token_expired", "refresh_token_reused", "refresh_token_revoked")) return null
        if (r.status != 200) throw IOException("HTTP ${r.status}")
        if (tokens == null) throw IOException("Invalid token response")
        return when (c.provider) {
            "codex" -> codexCredential(tokens, c)
            "grok" -> grokCredential(tokens, c)
            else -> c.copy(accessToken = accessToken(tokens),
                refreshToken = tokens.optString("refresh_token").ifEmpty { refresh }, expiresAt = expiry(tokens))
        }
    }

    private fun accessToken(tokens: JSONObject): String = tokens.optString("access_token")
        .takeIf { !tokens.isNull("access_token") && it.isNotBlank() }
        ?: throw IOException("The service returned no access token. Try again.")

    /** Whether a phone sign-in should be renewed now; Codex's 10-day tokens are renewed a day early. */
    fun dueForRenewal(c: Credential, now: Long): Boolean {
        val expires = c.expiresAt ?: return false
        return expires - now < if (c.provider == "codex") 24 * 3_600_000L else 5 * 60_000L
    }

    internal fun claudePlan(profile: JSONObject): String? {
        val tier = profile.optJSONObject("organization")?.optString("rate_limit_tier").orEmpty()
        val account = profile.optJSONObject("account")
        return when {
            "max_20" in tier -> "Max 20x"
            "max_5" in tier -> "Max 5x"
            account?.optBoolean("has_claude_max") == true -> "Max"
            account?.optBoolean("has_claude_pro") == true -> "Pro"
            else -> null
        }
    }

    internal fun claims(jwt: String): JSONObject? = runCatching {
        JSONObject(String(Base64.getUrlDecoder().decode(jwt.split('.')[1].trimEnd('='))))
    }.getOrNull()

    internal fun challenge(verifier: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))

    private fun randomText(bytes: Int): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(bytes).also(random::nextBytes))

    private fun expiry(tokens: JSONObject): Long? =
        tokens.optLong("expires_in").takeIf { it > 0 }?.let { System.currentTimeMillis() + it * 1000 }

    /** Calls [attempt] until it returns a value, waiting [wait] ms between tries. */
    private suspend fun poll(tries: Int, wait: () -> Long, attempt: () -> JSONObject?): JSONObject {
        repeat(tries) {
            delay(wait())
            attempt()?.let { return it }
        }
        throw IOException("The sign-in timed out. Start again.")
    }

    private val JSON = mapOf("Content-Type" to "application/json", "Accept" to "application/json")

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun form(http: Http, url: String, fields: Map<String, String>) = http.send("POST", url,
        mapOf("Content-Type" to "application/x-www-form-urlencoded", "Accept" to "application/json"),
        fields.entries.joinToString("&") { "${enc(it.key)}=${enc(it.value)}" }.toByteArray())

    private fun postForm(http: Http, url: String, fields: Map<String, String>): JSONObject = ok(form(http, url, fields))

    private fun postJson(http: Http, url: String, body: JSONObject): JSONObject =
        ok(http.send("POST", url, JSON, body.toString().toByteArray()))

    private fun ok(r: HttpReply): JSONObject {
        val body = runCatching { JSONObject(r.text()) }.getOrNull()
        if (r.status == 200 && body != null) return body
        val reason = body?.optString("error_description")?.ifEmpty { null } ?: body?.optString("error")?.ifEmpty { null }
        throw IOException(reason ?: "The sign-in was refused (HTTP ${r.status}).")
    }
}
