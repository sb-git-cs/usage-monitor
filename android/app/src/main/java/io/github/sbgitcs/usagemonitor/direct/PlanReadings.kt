package io.github.sbgitcs.usagemonitor.direct

import android.content.Context
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.model.Provider
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.pairing.DesktopClient
import io.github.sbgitcs.usagemonitor.pairing.DirectReadingOffException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import io.github.sbgitcs.usagemonitor.widget.Widgets
import org.json.JSONObject
import java.io.IOException

data class PlanView(val snapshot: DesktopSnapshot?, val computerCached: Boolean)

/**
 * The app, widgets and alerts share these meters. Each tool reads from, in order: a sign-in made
 * on this phone; the computer while its reading is current; else directly with the computer's
 * linked token. Copilot is metered only on the computer.
 */
object PlanReadings {
    val MOBILE = listOf("claude", "codex", "gemini", "grok", "cursor")
    val NAMES = mapOf("claude" to "Claude Code", "codex" to "Codex", "gemini" to "Gemini", "grok" to "Grok Build", "cursor" to "Cursor")
    private const val FRESH_MS = 30 * 60_000L
    private const val DIRECT_EVERY_MS = 2 * 60_000L
    private const val TOKENS_EVERY_MS = 10 * 60_000L
    private val backoffUntil = mutableMapOf<String, Long>()
    // App, foreground service and WorkManager must never rotate the same refresh token together.
    private val mutex = Mutex()

    /** Reads the computer, then whatever must be read directly. [force] skips the direct-read spacing. */
    suspend fun refresh(context: Context, settings: Settings, force: Boolean = false): PlanView = withContext(Dispatchers.IO) {
        mutex.withLock {
            val vault = TokenVault(context)
            val now = System.currentTimeMillis()
            if (settings.computer != null) {
                val client = DesktopClient(settings)
                runCatching { client.refresh() }
                if (settings.directLink != "off" && (force || now - settings.tokensAt > TOKENS_EVERY_MS)) fetchTokens(client, settings, vault)
            }
            currentCoroutineContext().ensureActive()
            readDirect(settings, vault, force, UsageApi())
            read(settings)
        }
    }

    fun read(settings: Settings, now: Long = System.currentTimeMillis()): PlanView {
        val view = desktopView(settings, now)
        val direct = directReadings(settings)
        if (direct.isEmpty()) return view
        val providers = merge(view.snapshot?.providers.orEmpty(), direct, now)
        val snapshot = view.snapshot?.copy(providers = providers)
            ?: DesktopSnapshot("", "This phone", now, 80, providers, null, null)
        return PlanView(snapshot, view.computerCached)
    }

    private fun desktopView(settings: Settings, now: Long): PlanView {
        val desktop = settings.snapshotJson?.let { runCatching { DesktopSnapshot.parse(it) }.getOrNull() }
        return fromDesktop(desktop, settings.snapshotAt, settings.lastError != null, now)
    }

    /** Asks the computer to allow direct reading; it confirms there. */
    suspend fun requestLink(context: Context, settings: Settings) = withContext(Dispatchers.IO) {
        mutex.withLock {
            val client = DesktopClient(settings)
            settings.directLink = if (client.link()) "on" else "asked"
            if (settings.directLink == "on") fetchTokens(client, settings, TokenVault(context))
        }
        Widgets.refresh(context)
    }

    /** Checks whether the computer has approved direct reading yet. */
    suspend fun checkLink(context: Context, settings: Settings) = withContext(Dispatchers.IO) {
        mutex.withLock {
            if (settings.computer != null) fetchTokens(DesktopClient(settings), settings, TokenVault(context))
        }
        Widgets.refresh(context)
    }

    /** Stops direct reading with the computer's sign-ins and drops what it linked. */
    suspend fun stopLink(context: Context, settings: Settings) = withContext(Dispatchers.IO) {
        mutex.withLock {
            runCatching { DesktopClient(settings).unlink() }
            dropLinkedLocked(context, settings)
        }
        Widgets.refresh(context)
    }

    /** Forgets everything the computer linked, for example when it is unpaired. */
    suspend fun dropLinked(context: Context, settings: Settings) = withContext(Dispatchers.IO) {
        mutex.withLock { dropLinkedLocked(context, settings) }
        Widgets.refresh(context)
    }

    private fun dropLinkedLocked(context: Context, settings: Settings) {
        settings.directLink = "off"
        settings.tokensAt = 0
        TokenVault(context).replaceLinked(emptyList())
        saveDirect(settings, directReadings(settings).filter { it.source != "linked" })
    }

    /** Signs a tool out on this phone only. */
    suspend fun signOut(context: Context, settings: Settings, provider: String) = withContext(Dispatchers.IO) {
        mutex.withLock {
            TokenVault(context).remove(provider, TokenVault.PHONE)
            backoffUntil.remove(provider)
            saveDirect(settings, directReadings(settings).filterNot { it.id == provider && it.source == "phone" })
        }
        Widgets.refresh(context)
    }

    /** Persist authorization and its first usage result together, even if Accounts is no longer visible. */
    suspend fun saveSignIn(context: Context, settings: Settings, credential: Credential, reading: UsageResult) = withContext(Dispatchers.IO) {
        mutex.withLock {
            currentCoroutineContext().ensureActive()
            TokenVault(context).put(credential)
            val now = System.currentTimeMillis()
            backoffUntil.remove(credential.provider)
            val provider = when (reading) {
                is UsageResult.Ok -> reading.provider.copy(source = "phone")
                is UsageResult.Failed -> {
                    if (reading.rateLimited) backoffUntil[credential.provider] = now + 15 * 60_000L
                    placeholder(credential.provider, "phone", "fetch_failed", reading.message, credential.account, now)
                }
                UsageResult.AuthFailed -> error("Cannot save a refused sign-in")
            }
            saveDirect(settings, directReadings(settings).filterNot { it.id == credential.provider } + provider)
        }
    }

    private fun fetchTokens(client: DesktopClient, settings: Settings, vault: TokenVault) {
        try {
            val linked = linkedCredentials(client.tokens())
            vault.replaceLinked(linked)
            val ids = linked.map { it.provider }.toSet()
            saveDirect(settings, directReadings(settings).filter { it.source != "linked" || it.id in ids })
            settings.directLink = "on"
            settings.tokensAt = System.currentTimeMillis()
        } catch (e: DirectReadingOffException) {
            // Still waiting for approval, or the computer stopped it.
            if (settings.directLink == "on") {
                settings.directLink = "off"
                vault.replaceLinked(emptyList())
                saveDirect(settings, directReadings(settings).filter { it.source != "linked" })
            }
        } catch (e: IOException) {
            // The computer is out of reach; the tokens already here keep working until they expire.
        }
    }

    private fun readDirect(settings: Settings, vault: TokenVault, force: Boolean, api: UsageApi) {
        val now = System.currentTimeMillis()
        val desktop = desktopView(settings, now).snapshot?.providers.orEmpty().associateBy { it.id }
        val cache = directReadings(settings).associateBy { it.id }.toMutableMap()
        val creds = vault.all()
        var changed = false
        for (id in MOBILE) {
            val phone = creds.firstOrNull { it.provider == id && it.origin == TokenVault.PHONE }
            val linked = creds.firstOrNull { it.provider == id && it.origin == TokenVault.LINKED }
            val computerCurrent = desktop[id]?.state == "ok"
            val c = phone ?: linked?.takeIf { !computerCurrent } ?: continue
            val source = if (c.origin == TokenVault.PHONE) "phone" else "linked"
            val last = cache[id]?.takeIf { it.source == source }
            if (!force && last != null && now - (last.fetchedAt ?: 0) < DIRECT_EVERY_MS) continue
            if ((backoffUntil[id] ?: 0) > now) continue
            val reading = readOne(c, api, now, { PhoneSignIn.renew(it) }, vault::put)
            val known = desktop[id]
            cache[id] = when (reading) {
                is UsageResult.Ok -> reading.provider.copy(source = source,
                    account = reading.provider.account ?: if (source == "linked") known?.account else c.account,
                    plan = reading.provider.plan ?: if (source == "linked") known?.plan else c.plan)
                is UsageResult.AuthFailed -> {
                    vault.remove(id, c.origin)
                    if (source == "phone") placeholder(id, source, "logged_out", "Signed out on this phone. Sign in again.", c.account, now)
                    else placeholder(id, source, "logged_out", "Computer sign-in expired. Reconnect the computer to update it.", c.account, now)
                }
                is UsageResult.Failed -> {
                    if (reading.rateLimited) backoffUntil[id] = now + 15 * 60_000L
                    last?.copy(state = "stale", hint = "Could not read: ${reading.message}")
                        ?: placeholder(id, source, "fetch_failed", "Could not read: ${reading.message}", c.account, now)
                }
            }
            changed = true
        }
        if (changed) saveDirect(settings, cache.values.toList())
    }

    /** Reads one tool, renewing a phone sign-in first when it is about to expire or was refused. */
    internal fun readOne(c: Credential, api: UsageApi, now: Long,
                         renew: (Credential) -> Credential?, save: (Credential) -> Unit): UsageResult {
        return try {
            var cred = c
            var renewed = false
            if (cred.origin == TokenVault.PHONE && cred.refreshToken != null && PhoneSignIn.dueForRenewal(cred, now)) {
                cred = renew(cred)?.also(save) ?: return UsageResult.AuthFailed
                renewed = true
            }
            if ((cred.expiresAt ?: Long.MAX_VALUE) <= now) return UsageResult.AuthFailed
            val result = api.fetch(cred, now)
            if (result !is UsageResult.AuthFailed || renewed || cred.origin != TokenVault.PHONE || cred.refreshToken == null) result
            else renew(cred)?.also(save)?.let { api.fetch(it, now) } ?: result
        } catch (e: IOException) {
            UsageResult.Failed("Sign-in could not be refreshed. Try again when the service is available.")
        }
    }

    private fun placeholder(id: String, source: String, state: String, hint: String, account: String?, now: Long) =
        Provider(id, NAMES[id] ?: id, null, state, hint, emptyList(), account = account, source = source, fetchedAt = now)

    private fun directReadings(settings: Settings): List<Provider> =
        settings.directJson?.let { runCatching { DesktopSnapshot.parse(it).providers }.getOrNull() }.orEmpty()

    private fun saveDirect(settings: Settings, providers: List<Provider>) {
        settings.directJson = DesktopSnapshot.providersJson(providers)
    }

    internal fun linkedCredentials(tokens: JSONObject): List<Credential> = MOBILE.mapNotNull { id ->
        val t = tokens.optJSONObject(id) ?: return@mapNotNull null
        val access = t.optString("access_token").ifEmpty { return@mapNotNull null }
        fun text(key: String) = if (t.isNull(key)) null else t.optString(key).ifEmpty { null }
        Credential(id, TokenVault.LINKED, access, expiresAt = t.optLong("expires_at").takeIf { it > 0 },
            accountId = text("account_id"), userId = text("user_id"), plan = text("plan"),
            extra = text("ide_type")?.let { mapOf("ide_type" to it) }.orEmpty())
    }

    /**
     * Picks each tool's reading: a phone sign-in; a current computer reading; a current direct
     * reading; else whichever is newer. A tool turned off on the computer stays off.
     */
    internal fun merge(desktop: List<Provider>, direct: List<Provider>, now: Long): List<Provider> {
        val fromDesktop = desktop.associateBy { it.id }
        val read = direct.associateBy { it.id }.mapValues { (_, p) ->
            if (p.state == "ok" && now - (p.fetchedAt ?: 0) > FRESH_MS)
                p.copy(state = "stale", hint = "Last reading ${Format.ago(p.fetchedAt ?: 0, now)}") else p
        }
        val ids = MOBILE.filter { it in fromDesktop || it in read }
        return ids.mapNotNull { id ->
            val d = fromDesktop[id]
            val x = read[id]
            when {
                x?.source == "phone" && x.state != "logged_out" -> x
                x == null -> d
                d == null -> x
                d.state in setOf("ok", "disabled", "not_installed") -> d
                x.state == "ok" -> x
                (x.fetchedAt ?: 0) > (d.fetchedAt ?: 0) -> x
                else -> d
            }
        }
    }

    internal fun fromDesktop(desktop: DesktopSnapshot?, desktopAt: Long, desktopFailed: Boolean, now: Long): PlanView {
        val cached = desktop != null && (desktopFailed || desktopAt <= 0 || now - desktopAt > FRESH_MS)
        val providers = desktop?.providers.orEmpty().filter { it.id != "copilot" }.map { p ->
            if (cached && p.state != "disabled" && p.state != "not_installed")
                p.copy(state = "stale", hint = "Computer unavailable · Last reading ${Format.ago(desktopAt, now)}") else p
        }
        return PlanView(desktop?.copy(providers = providers), cached)
    }
}
