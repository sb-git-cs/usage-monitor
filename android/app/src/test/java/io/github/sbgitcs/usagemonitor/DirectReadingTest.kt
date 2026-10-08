package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.direct.Credential
import io.github.sbgitcs.usagemonitor.direct.Http
import io.github.sbgitcs.usagemonitor.direct.HttpReply
import io.github.sbgitcs.usagemonitor.direct.PhoneSignIn
import io.github.sbgitcs.usagemonitor.direct.PlanReadings
import io.github.sbgitcs.usagemonitor.direct.TokenVault
import io.github.sbgitcs.usagemonitor.direct.UsageApi
import io.github.sbgitcs.usagemonitor.direct.UsageResult
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.model.Provider
import io.github.sbgitcs.usagemonitor.ui.usageLine
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class DirectReadingTest {
    private val now = 10_000_000L
    private fun meter(id: String, state: String = "ok", source: String = "desktop", at: Long = now, used: Double = 25.0) =
        Provider(id, id, null, state, null, listOf(PlanWindow("five_hour", "5h", used, null, null, null)),
            account = "$id@example.test", source = source, fetchedAt = at)

    @Test fun aPhoneSignInAlwaysWinsAndACurrentComputerReadingBeatsALinkedOne() {
        val merged = PlanReadings.merge(
            listOf(meter("claude"), meter("codex")),
            listOf(meter("claude", source = "phone", used = 70.0), meter("codex", source = "linked", used = 90.0)), now)
        assertEquals("phone", merged.single { it.id == "claude" }.source)
        assertEquals("desktop", merged.single { it.id == "codex" }.source)
    }

    @Test fun aLinkedReadingReplacesACachedComputerReading() {
        val merged = PlanReadings.merge(listOf(meter("grok", state = "stale", at = now - 3_600_000)),
            listOf(meter("grok", source = "linked", at = now - 60_000)), now)
        assertEquals("linked", merged.single().source)
        assertEquals("ok", merged.single().state)
    }

    @Test fun oldDirectReadingsAreMarkedCachedAndAToolTurnedOffStaysOff() {
        val merged = PlanReadings.merge(listOf(meter("cursor", state = "disabled")),
            listOf(meter("cursor", source = "linked", at = now - 40 * 60_000), meter("gemini", source = "linked", at = now - 40 * 60_000)), now)
        assertEquals("disabled", merged.single { it.id == "cursor" }.state)
        assertEquals("stale", merged.single { it.id == "gemini" }.state)
        assertEquals(listOf("gemini", "cursor"), merged.map { it.id })
    }

    @Test fun aSignedOutPhonePlaceholderDoesNotHideACurrentComputerReading() {
        val merged = PlanReadings.merge(listOf(meter("claude")), listOf(meter("claude", state = "logged_out", source = "phone")), now)
        assertEquals("desktop", merged.single().source)
    }

    @Test fun linkedTokensKeepOnlyWhatReadingUsageNeeds() {
        val json = JSONObject("""{
            "claude": {"access_token": "a", "expires_at": 5, "plan": "Max"},
            "codex": {"access_token": "b", "account_id": "acct", "expires_at": null},
            "grok": {"access_token": "c", "user_id": "7"},
            "gemini": {"access_token": "d", "ide_type": "IDE_UNSPECIFIED"},
            "cursor": {"access_token": ""},
            "copilot": {"access_token": "e"}
        }""")
        val creds = PlanReadings.linkedCredentials(json).associateBy { it.provider }
        assertEquals(setOf("claude", "codex", "grok", "gemini"), creds.keys)
        assertTrue(creds.values.all { it.origin == TokenVault.LINKED && it.refreshToken == null })
        assertEquals(5L, creds.getValue("claude").expiresAt)
        assertEquals("Max", creds.getValue("claude").plan)
        assertNull(creds.getValue("codex").expiresAt)
        assertEquals("acct", creds.getValue("codex").accountId)
        assertEquals("7", creds.getValue("grok").userId)
        assertEquals("IDE_UNSPECIFIED", creds.getValue("gemini").extra["ide_type"])
    }

    @Test fun vaultRecordsRoundTrip() {
        val list = listOf(
            Credential("codex", TokenVault.PHONE, "at", "rt", 123, accountId = "acct", account = "me@example.test"),
            Credential("gemini", TokenVault.LINKED, "g", extra = mapOf("ide_type" to "ANTIGRAVITY")),
        )
        assertEquals(list, TokenVault.decode(TokenVault.encode(list)))
    }

    @Test fun directReadingsRoundTripThroughTheSnapshotFormat() {
        val p = meter("claude", source = "phone").copy(plan = "Max", usageSummary = "Credits remaining", usageValue = "42",
            windows = listOf(PlanWindow("weekly", "Weekly", 41.5, 20_000_000, 15_000_000, 2.0)))
        val back = DesktopSnapshot.parse(DesktopSnapshot.providersJson(listOf(p))).providers.single()
        assertEquals(p, back)
    }

    @Test fun temporaryRefreshFailureNeverDiscardsTheSignInOrReadsAnExpiredToken() {
        val c = Credential("claude", TokenVault.PHONE, "old", "refresh", now - 1)
        val api = UsageApi(Http { _, _, _, _ -> fail("Expired access token must not be sent after refresh failure"); HttpReply(401, ByteArray(0)) })
        assertTrue(PlanReadings.readOne(c, api, now, { throw java.io.IOException("offline") }, { fail("No rotated token") }) is UsageResult.Failed)
        assertEquals(UsageResult.AuthFailed, PlanReadings.readOne(c, api, now, { null }, { fail("No rotated token") }))
    }

    @Test fun aNonRenewableSessionStaysUsableUntilItsActualExpiry() {
        val c = Credential("claude", TokenVault.PHONE, "access", expiresAt = now + 1)
        val api = UsageApi(Http { _, _, _, _ -> HttpReply(200, """{"five_hour":{"utilization":0}}""".toByteArray()) })
        assertTrue(PlanReadings.readOne(c, api, now, { fail("Must not renew"); null }, {}) is UsageResult.Ok)
        assertEquals(UsageResult.AuthFailed, PlanReadings.readOne(c, api, now + 1, { null }, {}))
    }

    @Test fun renewalHappensOnlyOncePerRead() {
        var renewals = 0
        val c = Credential("claude", TokenVault.PHONE, "access", "refresh", now)
        val result = PlanReadings.readOne(c, UsageApi(Http { _, _, _, _ -> HttpReply(401, ByteArray(0)) }), now,
            { renewals++; it.copy(accessToken = "new", expiresAt = now + 3_600_000) }, {})
        assertEquals(UsageResult.AuthFailed, result)
        assertEquals(1, renewals)
    }

    @Test fun configurationErrorsAndMalformedRefreshRepliesAreRetryable() {
        val c = Credential("claude", TokenVault.PHONE, "access", "refresh", now)
        for ((status, body) in listOf(400 to """{"error":"invalid_scope"}""", 401 to "gateway error", 200 to "{}", 200 to """{"access_token":null}""")) {
            assertThrows(java.io.IOException::class.java) { PhoneSignIn.renew(c, Http { _, _, _, _ -> HttpReply(status, body.toByteArray()) }) }
        }
    }

    @Test fun retiredProvidersCannotReappearFromTheDirectCache() {
        assertTrue(PlanReadings.merge(emptyList(), listOf(meter("copilot", source = "phone")), now).isEmpty())
    }

    @Test fun pkceChallengeAndJwtClaimsAreEncodedCorrectly() {
        // S256: base64url(SHA-256(verifier)) without padding, checked against Node's crypto.
        assertEquals("hmiH11vABnX8lfye5tTbDWdhwBulcEGLglN0s7dFBvM", PhoneSignIn.challenge("dBjftJeZ4CVP-mJ92K9qWnj9n1HBcvpqQQkXpJ9Ce8I"))
        val payload = Base64.getUrlEncoder().withoutPadding().encodeToString("""{"sub":"u-1","exp":99}""".toByteArray())
        assertEquals("u-1", PhoneSignIn.claims("h.$payload.s")!!.getString("sub"))
        assertNull(PhoneSignIn.claims("not-a-jwt"))
    }

    @Test fun claudePlanComesFromTheProfile() {
        assertEquals("Max 20x", PhoneSignIn.claudePlan(JSONObject("""{"organization":{"rate_limit_tier":"default_claude_max_20x"}}""")))
        assertEquals("Pro", PhoneSignIn.claudePlan(JSONObject("""{"account":{"has_claude_pro":true}}""")))
        assertNull(PhoneSignIn.claudePlan(JSONObject("{}")))
    }

    @Test fun renewingKeepsTheOldRefreshTokenWhenNoneIsReturnedAndReportsARefusal() {
        val sent = mutableListOf<String>()
        fun http(status: Int, body: String) = Http { _, url, _, b -> sent += url + " " + String(b ?: ByteArray(0)); HttpReply(status, body.toByteArray()) }
        val claude = Credential("claude", TokenVault.PHONE, "old", "rt", 0)
        val renewed = PhoneSignIn.renew(claude, http(200, """{"access_token":"new","expires_in":3600}"""))!!
        assertEquals("new", renewed.accessToken)
        assertEquals("rt", renewed.refreshToken)
        assertTrue(sent.last().contains("\"scope\":\"user:profile\""))
        assertNull(PhoneSignIn.renew(claude, http(400, """{"error":"invalid_grant"}""")))
        assertNull(PhoneSignIn.renew(claude.copy(refreshToken = null), http(200, "{}")))
        assertThrows(java.io.IOException::class.java) { PhoneSignIn.renew(claude, http(503, "")) }
        assertNull("Cursor sessions are not renewed", PhoneSignIn.renew(Credential("cursor", TokenVault.PHONE, "c", "r"), http(200, "{}")))
    }

    @Test fun codexRenewalReadsTheAccountFromTheNewIdToken() {
        val enc = Base64.getUrlEncoder().withoutPadding()
        val id = "h." + enc.encodeToString("""{"email":"me@example.test","https://api.openai.com/auth":{"chatgpt_account_id":"acct-2"}}""".toByteArray()) + ".s"
        val access = "h." + enc.encodeToString("""{"exp":2000}""".toByteArray()) + ".s"
        val c = Credential("codex", TokenVault.PHONE, "old", "rt", 0, accountId = "acct-1")
        val next = PhoneSignIn.renew(c, Http { _, _, _, _ -> HttpReply(200, """{"access_token":"$access","id_token":"$id","refresh_token":"rt-2"}""".toByteArray()) })!!
        assertEquals("acct-2", next.accountId)
        assertEquals("me@example.test", next.account)
        assertEquals("rt-2", next.refreshToken)
        assertEquals(2_000_000L, next.expiresAt)
    }

    @Test fun renewalIsDueEarlierForCodex() {
        assertTrue(PhoneSignIn.dueForRenewal(Credential("codex", TokenVault.PHONE, "a", expiresAt = now + 3_600_000), now))
        assertFalse(PhoneSignIn.dueForRenewal(Credential("grok", TokenVault.PHONE, "a", expiresAt = now + 3_600_000), now))
        assertTrue(PhoneSignIn.dueForRenewal(Credential("grok", TokenVault.PHONE, "a", expiresAt = now + 60_000), now))
        assertFalse(PhoneSignIn.dueForRenewal(Credential("grok", TokenVault.PHONE, "a"), now))
    }

    @Test fun theHomeRowSaysWhenAWindowResetsOrRunsOut() {
        val w = PlanWindow("five_hour", "5h", 62.0, now + 2 * 3_600_000, null, null)
        val weekly = PlanWindow("weekly", "Weekly", 41.0, null, null, null)
        val p = meter("claude").copy(windows = listOf(w, weekly))
        assertEquals("5h · resets in 2 h · Weekly 41%", usageLine(p, w, now))
        val racing = w.copy(forecastAt = now + 40 * 60_000)
        assertEquals("5h · full in 40 min at this pace · Weekly 41%", usageLine(p.copy(windows = listOf(racing, weekly)), racing, now))
        assertEquals("Signed out on the computer", usageLine(p.copy(state = "logged_out"), null, now))
    }
}
