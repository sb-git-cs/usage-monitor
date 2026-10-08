package io.github.sbgitcs.usagemonitor.direct

import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.model.Provider
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.time.Instant
import java.time.OffsetDateTime
import java.util.Locale

/** One provider's sign-in as the phone holds it. */
data class Credential(
    val provider: String,
    val origin: String,
    val accessToken: String,
    val refreshToken: String? = null,
    val expiresAt: Long? = null,
    val accountId: String? = null,
    val userId: String? = null,
    val plan: String? = null,
    val account: String? = null,
    val extra: Map<String, String> = emptyMap(),
)

data class HttpReply(val status: Int, val body: ByteArray, val headers: Map<String, String> = emptyMap()) {
    fun text(): String = body.toString(Charsets.UTF_8)
}

/** Blocking HTTP; lowercase header names in replies. */
fun interface Http { fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?): HttpReply }

sealed interface UsageResult {
    data class Ok(val provider: Provider) : UsageResult
    data object AuthFailed : UsageResult
    data class Failed(val message: String, val rateLimited: Boolean = false) : UsageResult
}

/** Reads each tool's plan usage straight from its own service with an access token. Blocking. */
class UsageApi(private val http: Http = UrlHttp) {

    /** Never throws: network trouble comes back as [UsageResult.Failed]. */
    fun fetch(c: Credential, now: Long = System.currentTimeMillis()): UsageResult = try {
        val result = when (c.provider) {
            "claude" -> getJson(CLAUDE_URL, claudeHeaders(c.accessToken)) { UsageResult.Ok(mapClaude(it, c.plan, now)) }
            "codex" -> getJson(CODEX_URL, codexHeaders(c)) { UsageResult.Ok(mapCodex(it, now)) }
            "grok" -> fetchGrok(c, now)
            "cursor" -> fetchCursor(c, now)
            "gemini" -> fetchGemini(c, now)
            else -> UsageResult.Failed("Unknown tool")
        }
        if (result is UsageResult.Ok && result.provider.windows.isEmpty() && result.provider.usageSummary == null)
            UsageResult.Failed("No usage report was returned for this account")
        else if (result is UsageResult.Ok) UsageResult.Ok(result.provider.copy(account = c.account, source = "phone", fetchedAt = now)) else result
    } catch (e: Exception) {
        UsageResult.Failed(e.message ?: "network error")
    }

    private fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray? = null) = http.send(method, url, headers, body)

    private fun json(r: HttpReply): JSONObject? = runCatching { JSONObject(r.text()) }.getOrNull()

    private fun postJson(url: String, headers: Map<String, String>, body: JSONObject) =
        send("POST", url, headers + ("Content-Type" to "application/json"), body.toString().toByteArray())

    /** The failure for a non-200 reply, or null when the reply is usable. */
    private fun statusError(status: Int): UsageResult? = when (status) {
        200 -> null
        401 -> UsageResult.AuthFailed
        403 -> UsageResult.Failed("Usage access denied (HTTP 403). Check the account's permissions or sign in again.")
        429 -> UsageResult.Failed("rate limited", true)
        else -> UsageResult.Failed("HTTP $status")
    }

    private fun getJson(url: String, headers: Map<String, String>, map: (JSONObject) -> UsageResult): UsageResult {
        val r = send("GET", url, headers)
        return statusError(r.status) ?: json(r)?.let(map) ?: UsageResult.Failed("HTTP ${r.status}")
    }

    private fun fetchGrok(c: Credential, now: Long): UsageResult =
        getJson(GROK_URL, grokHeaders(c.accessToken, c.userId)) { body ->
            val billing = body.optJSONObject("config") ?: body
            if (weeklyPct(billing) == null) {
                runCatching { fetchGrokCredits(c.accessToken) }.getOrNull()?.let { billing.put("creditUsagePercent", it) }
            }
            UsageResult.Ok(mapGrok(body, now))
        }

    private fun fetchGrokCredits(token: String): Double? {
        val headers = mapOf(
            "Authorization" to "Bearer $token",
            "Content-Type" to "application/grpc-web+proto",
            "x-grpc-web" to "1",
            "X-XAI-Token-Auth" to "xai-grok-cli",
            "Accept" to "application/grpc-web+proto",
            "Origin" to "https://grok.com",
            "Referer" to "https://grok.com/?_s=usage",
            "User-Agent" to "grok-cli/1.0",
        )
        val r = send("POST", GROK_GRPC_URL, headers, byteArrayOf(0, 0, 0, 0, 2, 0x08, 0x00))
        if (r.status != 200) return null
        val status = r.headers["grpc-status"]
        if (!status.isNullOrEmpty() && status != "0") return null
        return parseGrokCredits(r.body)
    }

    private fun fetchCursor(c: Credential, now: Long): UsageResult {
        val headers = mapOf("Authorization" to "Bearer ${c.accessToken}", "Connect-Protocol-Version" to "1", "User-Agent" to "usage-monitor")
        val plan = postJson(CURSOR_PLAN_URL, headers, JSONObject())
        val usage = postJson(CURSOR_USAGE_URL, headers, JSONObject())
        if (usage.status == 401) return UsageResult.AuthFailed
        if (plan.status == 429 || usage.status == 429) return UsageResult.Failed("rate limited", true)
        val body = (if (usage.status == 200) json(usage) else null) ?: return UsageResult.Failed("HTTP ${usage.status}")
        return UsageResult.Ok(mapCursor(if (plan.status == 200) json(plan) else null, body, now))
    }

    private sealed interface Host {
        data class Ok(val plan: String?, val windows: List<PlanWindow>) : Host
        data object Auth : Host
        data class Fail(val status: Int?) : Host
    }

    private fun fetchGemini(c: Credential, now: Long): UsageResult {
        val metadata = JSONObject().put("ideType", c.extra["ide_type"] ?: "ANTIGRAVITY")
            .put("platform", "PLATFORM_UNSPECIFIED").put("pluginType", "GEMINI")
        val loadBody = JSONObject().put("metadata", metadata)
        var last: Host.Fail? = null
        for (host in GEMINI_HOSTS) {
            val r = try { geminiHost(host, c.accessToken, loadBody) } catch (e: IOException) { last = Host.Fail(null); continue }
            when (r) {
                Host.Auth -> return UsageResult.AuthFailed
                is Host.Ok -> return UsageResult.Ok(Provider("gemini", "Gemini", r.plan, "ok", null, r.windows, source = "phone", fetchedAt = now))
                is Host.Fail -> { last = r; if (r.status == 429) break }
            }
        }
        val status = last?.status
        return when (status) {
            429 -> UsageResult.Failed("rate limited", true)
            null -> UsageResult.Failed("quota unavailable")
            else -> UsageResult.Failed("HTTP $status")
        }
    }

    private fun geminiHost(host: String, token: String, loadBody: JSONObject): Host {
        val headers = mapOf("Authorization" to "Bearer $token", "User-Agent" to "antigravity/windows/amd64")
        fun call(method: String, body: JSONObject) = postJson("$host/v1internal:$method", headers, body)
        val load = call("loadCodeAssist", loadBody)
        if (load.status == 401) return Host.Auth
        val loaded = (if (load.status == 200) json(load) else null) ?: return Host.Fail(load.status)
        val plan = geminiPlan(loaded)
        val project = extractProject(loaded)
        val quotaBody = JSONObject().also { if (project != null) it.put("project", project) }
        val steps = listOf<Pair<String, (JSONObject) -> List<PlanWindow>>>(
            "retrieveUserQuotaSummary" to { mapGeminiSummary(it) },
            "retrieveUserQuota" to { mapGeminiQuota(it) },
            "fetchAvailableModels" to { mapGeminiModels(it) },
        )
        val statuses = mutableListOf<Int>()
        for ((method, map) in steps) {
            val r = call(method, quotaBody)
            if (r.status == 429) return Host.Fail(429)
            if (r.status == 401) return Host.Auth
            val windows = (if (r.status == 200) json(r) else null)?.let(map).orEmpty()
            if (windows.isNotEmpty()) return Host.Ok(plan, windows)
            statuses.add(r.status)
        }
        // The first non-200 in the order models, quota, summary, like the desktop.
        return Host.Fail(statuses.reversed().firstOrNull { it != 200 })
    }

    companion object {
        private const val CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage"
        private const val CODEX_URL = "https://chatgpt.com/backend-api/wham/usage"
        private const val GROK_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
        private const val GROK_GRPC_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"
        private const val CURSOR_PLAN_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"
        private const val CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
        private val GEMINI_HOSTS = listOf("https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com")

        private fun claudeHeaders(token: String) = mapOf(
            "Authorization" to "Bearer $token",
            "anthropic-beta" to "oauth-2025-04-20",
            "anthropic-version" to "2023-06-01",
            "x-app" to "cli",
            "User-Agent" to "claude-cli/2.1.201 (external, cli)",
            "anthropic-dangerous-direct-browser-access" to "true",
        )

        private fun codexHeaders(c: Credential) = mapOf(
            "Authorization" to "Bearer ${c.accessToken}",
            "ChatGPT-Account-Id" to (c.accountId ?: ""),
            "User-Agent" to "Mozilla/5.0 usage-monitor/1.0",
        )

        private fun grokHeaders(token: String, userId: String?) = buildMap {
            put("Authorization", "Bearer $token")
            put("Accept", "application/json")
            put("X-XAI-Token-Auth", "xai-grok-cli")
            put("User-Agent", "grok-cli/1.0")
            if (!userId.isNullOrEmpty()) put("x-userid", userId)
        }

        // JSON helpers that follow the desktop's loosely typed reads.
        private fun JSONObject.v(key: String): Any? = opt(key).takeUnless { it == JSONObject.NULL }
        private fun JSONObject.obj(key: String): JSONObject? = v(key) as? JSONObject
        private fun JSONObject.list(key: String): List<Any?> =
            (v(key) as? JSONArray)?.let { a -> List(a.length()) { a.opt(it).takeUnless { x -> x == JSONObject.NULL } } }.orEmpty()
        private fun JSONObject.first(vararg keys: String): String =
            keys.firstNotNullOfOrNull { k -> v(k)?.toString()?.takeIf { it.isNotEmpty() } } ?: ""

        /** Number(value) when finite; null for blanks, booleans and anything else. */
        private fun num(v: Any?): Double? = when (v) {
            is Number -> v.toDouble()
            is String -> v.trim().toDoubleOrNull()
            else -> null
        }?.takeIf { it.isFinite() }

        private fun isoMs(v: Any?): Long? {
            val s = (v as? String)?.trim().orEmpty()
            if (s.isEmpty()) return null
            return runCatching { Instant.parse(s).toEpochMilli() }
                .recoverCatching { OffsetDateTime.parse(s).toInstant().toEpochMilli() }.getOrNull()
        }

        private fun like(pattern: String, text: String) = Regex(pattern, RegexOption.IGNORE_CASE).containsMatchIn(text)

        /** The desktop's windowOf: a negative percent is raised to 0, an unreadable one becomes null. */
        private fun window(kind: String, label: String, used: Any?, resetsAt: Long?) =
            PlanWindow(kind, label, num(used)?.coerceAtLeast(0.0), resetsAt, null, null)

        private fun labelWindow(kind: String, label: String) = PlanWindow(kind, label, null, null, null, null)

        private fun provider(id: String, name: String, plan: String?, windows: List<PlanWindow>, now: Long) =
            Provider(id, name, plan, "ok", null, windows, source = "phone", fetchedAt = now)

        private fun truthy(v: Any?) = v != null && v != "" && v != false

        fun mapClaude(body: JSONObject, plan: String?, now: Long): Provider {
            val windows = mutableListOf<PlanWindow>()
            for ((key, kind, label) in listOf(Triple("five_hour", "five_hour", "5h"), Triple("seven_day", "weekly", "Weekly"))) {
                val w = body.obj(key) ?: continue
                if (w.v("utilization") != null || truthy(w.v("resets_at"))) windows.add(window(kind, label, w.v("utilization"), isoMs(w.v("resets_at"))))
            }
            for (lim in body.list("limits")) {
                if (lim !is JSONObject || lim.v("kind") != "weekly_scoped") continue
                val name = lim.obj("scope")?.obj("model")?.first("display_name").orEmpty()
                if (name.isNotEmpty()) windows.add(window("weekly_scoped", "$name weekly", lim.v("percent"), isoMs(lim.v("resets_at"))))
            }
            val spend = body.obj("spend")
            val used = spend?.obj("used")
            val limit = spend?.obj("limit")
            if (spend != null && spend.v("enabled") == true && used != null && limit != null) {
                val max = num(limit.v("amount_minor"))
                val pct = if (max != null && max != 0.0) num(used.v("amount_minor"))?.let { it / max * 100 } else null
                windows.add(window("credits", "Credits", pct, null))
            }
            return provider("claude", "Claude Code", plan, windows, now)
        }

        fun mapCodex(body: JSONObject, now: Long): Provider {
            val windows = mutableListOf<PlanWindow>()
            val rl = body.obj("rate_limit")
            for ((key, fallback) in listOf("primary_window" to "5h", "secondary_window" to "Weekly")) {
                val w = rl?.obj(key) ?: continue
                val used = w.v("used_percent") ?: w.v("remaining_percent")?.let { 100 - (num(it) ?: Double.NaN) } ?: continue
                windows.add(codexWindow(w, used, fallback, now))
            }
            for (extra in body.list("additional_rate_limits")) {
                if (extra !is JSONObject) continue
                val w = extra.obj("primary_window") ?: continue
                val used = w.v("used_percent") ?: continue
                windows.add(codexWindow(w, used, extra.first("name", "id").ifEmpty { "extra" }, now))
            }
            val count = num(body.obj("rate_limit_reset_credits")?.v("available_count"))
            if (count != null && count > 0) windows.add(labelWindow("credits", "Reset credits ×${count.toLong()}"))
            val plan = (body.v("plan_type") as? String)?.takeIf { it.isNotEmpty() }?.replaceFirstChar { it.uppercase() }
            return provider("codex", "Codex", plan, windows, now)
        }

        private fun codexWindow(w: JSONObject, used: Any?, fallback: String, now: Long): PlanWindow {
            val seconds = num(w.v("limit_window_seconds")) ?: Double.NaN
            var kind = "weekly_scoped"
            var label = fallback
            if (seconds in 14400.0..21600.0) { kind = "five_hour"; label = "5h" }
            else if (seconds in 518400.0..691200.0) { kind = "weekly"; label = "Weekly" }
            else if (seconds in 82800.0..90000.0) { kind = "daily"; label = "Daily" }
            else if (label.isEmpty()) {
                val h = Math.round(seconds / 3600)
                label = if (h >= 24) "${Math.round(h / 24.0)}d" else "${h}h"
            }
            if (fallback.isNotEmpty() && fallback != "5h" && fallback != "Weekly") label = "$fallback ${if (label == fallback) "" else label}".trim()
            val resets = when {
                w.v("reset_at") != null -> num(w.v("reset_at"))?.let { (it * 1000).toLong() }
                w.v("reset_after_seconds") != null -> num(w.v("reset_after_seconds"))?.let { now + (it * 1000).toLong() }
                else -> null
            }
            return window(kind, label, used, resets)
        }

        private fun productPercents(cfg: JSONObject): List<Double> =
            cfg.list("productUsage").mapNotNull { p -> if (p is JSONObject && p.v("product") is String) num(p.v("usagePercent")) else null }

        private fun weeklyPct(cfg: JSONObject): Double? {
            num(cfg.v("creditUsagePercent"))?.let { return it }
            val products = productPercents(cfg)
            if (products.isNotEmpty()) return products.sum()
            val used = num(cfg.obj("used")?.v("val"))
            val limit = num(cfg.obj("monthlyLimit")?.v("val"))
            return if (used != null && limit != null && limit > 0) used / limit * 100 else null
        }

        private fun periodEnd(cfg: JSONObject): Long? = isoMs(cfg.obj("currentPeriod")?.first("end")?.ifEmpty { null } ?: cfg.v("billingPeriodEnd"))

        private fun hasActivePeriod(cfg: JSONObject, now: Long): Boolean {
            val period = cfg.obj("currentPeriod")
            val startRaw = period?.first("start").orEmpty().ifEmpty { cfg.first("billingPeriodStart") }
            val endRaw = period?.first("end").orEmpty().ifEmpty { cfg.first("billingPeriodEnd") }
            if (startRaw.isEmpty() && endRaw.isEmpty()) return false
            val start = isoMs(startRaw)
            val end = isoMs(endRaw)
            return when {
                start != null && end != null -> start <= now && now < end
                end != null -> now < end
                else -> start != null && start <= now
            }
        }

        fun mapGrok(body: JSONObject, now: Long): Provider {
            val cfg = body.obj("config") ?: body
            val windows = mutableListOf<PlanWindow>()
            var pct = weeklyPct(cfg)
            val fromCredits = num(cfg.v("creditUsagePercent")) != null || productPercents(cfg).isNotEmpty()
            // proto3 JSON omits a 0.0 creditUsagePercent; a live period still reads as 0%.
            if (pct == null && hasActivePeriod(cfg, now)) pct = 0.0
            if (pct != null) {
                val type = cfg.obj("currentPeriod")?.first("type").orEmpty()
                val monthly = when {
                    like("WEEKLY", type) -> false
                    like("MONTHLY", type) -> true
                    fromCredits -> false
                    else -> (num(cfg.obj("monthlyLimit")?.v("val")) ?: 0.0) > 0
                }
                windows.add(window(if (monthly) "monthly" else "weekly", if (monthly) "Monthly" else "Weekly", pct, periodEnd(cfg)))
            }
            val prepaid = num(cfg.obj("prepaidBalance")?.v("val"))
            val cap = num(cfg.obj("onDemandCap")?.v("val"))
            val used = num(cfg.obj("onDemandUsed")?.v("val")) ?: 0.0
            if (cap != null && cap > 0) windows.add(window("credits", "Credits", used / cap * 100, null))
            else if (prepaid != null && prepaid > 0) windows.add(labelWindow("credits", "Credits $" + String.format(Locale.US, "%.2f", prepaid)))
            return provider("grok", "Grok Build", "SuperGrok", windows, now)
        }

        private class Cursor(val bytes: ByteArray, var at: Int = 0)

        /** Reads a protobuf varint as an unsigned 32-bit value; null when it runs off the end. */
        private fun varint(c: Cursor): Long? {
            var result = 0
            var shift = 0
            while (c.at < c.bytes.size && shift <= 35) {
                val b = c.bytes[c.at++].toInt() and 0xff
                result = result or ((b and 0x7f) shl shift)
                if ((b and 0x80) == 0) return result.toLong() and 0xFFFFFFFFL
                shift += 7
            }
            return null
        }

        private fun firstGrpcWebMessage(bytes: ByteArray): ByteArray? {
            var offset = 0
            while (offset + 5 <= bytes.size) {
                val flag = bytes[offset].toInt() and 0xff
                val length = ByteBuffer.wrap(bytes, offset + 1, 4).int.toLong() and 0xFFFFFFFFL
                offset += 5
                if (offset + length > bytes.size) return null
                val frame = bytes.copyOfRange(offset, offset + length.toInt())
                offset += length.toInt()
                if (flag != 0) continue
                if (frame.size >= 11 && frame.copyOfRange(0, 11).toString(Charsets.US_ASCII) == "grpc-status") continue
                return frame
            }
            return null
        }

        /** Calls [onField] with (field, wire type, payload) for length-delimited and fixed-width fields. */
        private fun walkProto(buf: ByteArray, onField: (Int, Int, ByteArray) -> Unit) {
            val c = Cursor(buf)
            while (c.at < buf.size) {
                val tag = varint(c) ?: return
                val field = (tag shr 3).toInt()
                val wire = (tag and 7).toInt()
                when (wire) {
                    2 -> {
                        val len = varint(c) ?: return
                        val end = c.at + len
                        if (end > buf.size) return
                        onField(field, wire, buf.copyOfRange(c.at, end.toInt()))
                        c.at = end.toInt()
                    }
                    5, 1 -> {
                        val n = if (wire == 5) 4 else 8
                        if (c.at + n > buf.size) return
                        onField(field, wire, buf.copyOfRange(c.at, c.at + n))
                        c.at += n
                    }
                    0 -> varint(c) ?: return
                    else -> return
                }
            }
        }

        /** creditUsagePercent from a grpc-web GetGrokCreditsConfig reply, or null. */
        fun parseGrokCredits(bytes: ByteArray): Double? {
            val message = firstGrpcWebMessage(bytes) ?: return null
            var config: ByteArray? = null
            walkProto(message) { field, wire, value -> if (field == 1 && wire == 2) config = value }
            var percent: Double? = null
            walkProto(config ?: message) { field, wire, value ->
                if (field != 1) return@walkProto
                val buf = ByteBuffer.wrap(value).order(ByteOrder.LITTLE_ENDIAN)
                if (wire == 5) percent = buf.float.toDouble() else if (wire == 1) percent = buf.double
            }
            return percent?.takeIf { it.isFinite() }
        }

        fun mapCursor(plan: JSONObject?, usage: JSONObject, now: Long): Provider {
            val n = num(usage.v("billingCycleEnd"))
            val end = if (n == null || n <= 0) null else (if (n < 1e12) n * 1000 else n).toLong()
            val spend = usage.obj("planUsage") ?: JSONObject()
            val windows = listOf("Included" to "totalPercentUsed", "Auto" to "autoPercentUsed", "API" to "apiPercentUsed")
                .mapNotNull { (label, key) -> num(spend.v(key))?.let { window("monthly", label, it, end) } }
            val name = plan?.obj("planInfo")?.first("planName").orEmpty().replace(Regex("[\\u0000-\\u001f]"), "").trim()
            return provider("cursor", "Cursor", name.take(40).ifEmpty { null }, windows, now)
        }

        private fun usedFromFraction(v: Any?): Double? = num(v)?.let { ((1 - it) * 100).coerceIn(0.0, 100.0) }

        private fun extractProject(data: JSONObject): String? {
            val p = data.v("cloudaicompanionProject")
            if (p is String && p.isNotEmpty()) return p
            return (p as? JSONObject)?.first("id")?.ifEmpty { null }
        }

        /** The tier's name and id, whether it arrives as a string or an object. */
        private fun tier(v: Any?): Pair<String?, String?> = when {
            v is String && v.isNotEmpty() -> v to v
            v is JSONObject -> v.first("name", "id").ifEmpty { null } to v.first("id").ifEmpty { null }
            else -> null to null
        }

        fun geminiPlan(load: JSONObject): String? {
            tier(load.v("paidTier")).first?.let { return it }
            val (name, id) = tier(load.v("currentTier"))
            if (name == null) return null
            return if (id == "free-tier" || like("free", name)) "Free" else name
        }

        private fun classifyBucket(b: JSONObject): Pair<String, String> {
            val label = b.first("displayName", "bucketId")
            val joined = "$label ${b.first("window")}"
            return when {
                like("five.?hour|5h|FIVE_HOUR", joined) -> "five_hour" to "5h"
                like("week", joined) -> "weekly" to "Weekly"
                like("day|daily|RPD", joined) -> "daily" to "Daily"
                else -> "weekly_scoped" to label.ifEmpty { "Quota" }
            }
        }

        fun mapGeminiSummary(data: JSONObject): List<PlanWindow> {
            val groups = data.list("groups").filterIsInstance<JSONObject>().filter { like("gemini", it.first("displayName", "name", "groupId")) }
            return groups.flatMap { group ->
                group.list("buckets").filterIsInstance<JSONObject>().mapNotNull { b ->
                    val used = usedFromFraction(b.v("remainingFraction")) ?: return@mapNotNull null
                    val (kind, label) = classifyBucket(b)
                    val full = if (groups.size > 1) "${group.first("displayName", "name", "groupId")} $label" else label
                    window(kind, full, used, isoMs(b.v("resetTime")))
                }
            }
        }

        private fun shortModel(id: String): String = when {
            like("3\\.?8.*flash|3-flash|3\\.8", id) -> "3 Flash"
            like("3.*pro", id) -> "3 Pro"
            like("flash", id) -> "Flash"
            like("pro", id) -> "Pro"
            else -> id.removePrefix("models/").removePrefix("gemini-").take(14).ifEmpty { "Model" }
        }

        fun mapGeminiQuota(data: JSONObject): List<PlanWindow> =
            data.list("buckets").filterIsInstance<JSONObject>().mapNotNull { b ->
                usedFromFraction(b.v("remainingFraction"))?.let { Triple(it, b.first("modelId", "id"), isoMs(b.v("resetTime"))) }
            }.sortedByDescending { it.first }.take(2).map { (used, id, reset) -> window("daily", shortModel(id), used, reset) }

        fun mapGeminiModels(data: JSONObject): List<PlanWindow> {
            val raw = data.v("models")
            val models = when (raw) {
                is JSONArray -> List(raw.length()) { raw.opt(it) }.filterIsInstance<JSONObject>()
                is JSONObject -> raw.keys().asSequence().mapNotNull { id ->
                    raw.obj(id)?.let { m -> JSONObject(m.toString()).also { copy -> if (m.first("model").isEmpty()) copy.put("model", id) } }
                }.toList()
                else -> emptyList()
            }
            class Entry(val used: Double, val name: String, val id: String, val reset: Long?)
            return models.mapNotNull { m ->
                val quota = m.obj("quotaInfo") ?: return@mapNotNull null
                val used = usedFromFraction(quota.v("remainingFraction")) ?: return@mapNotNull null
                Entry(used, m.first("displayName", "label", "model", "name"), m.first("model", "name"), isoMs(quota.v("resetTime")))
            }.sortedByDescending { it.used }.filter { like("gemini", "${it.name} ${it.id}") }.take(2)
                .map { window("quota", shortModel(it.name), it.used, it.reset) }
        }
    }
}

/** HttpURLConnection implementation; reads error streams too and never throws for an HTTP status. */
object UrlHttp : Http {
    override fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?): HttpReply {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 8_000
            conn.readTimeout = 12_000
            conn.instanceFollowRedirects = false
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val status = conn.responseCode
            val bytes = (if (status >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() } ?: ByteArray(0)
            val replyHeaders = conn.headerFields.filterKeys { it != null }.mapKeys { it.key.lowercase() }.mapValues { it.value.firstOrNull().orEmpty() }
            return HttpReply(status, bytes, replyHeaders)
        } finally {
            conn.disconnect()
        }
    }
}
