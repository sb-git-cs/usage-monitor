package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.direct.*
import io.github.sbgitcs.usagemonitor.data.InsightHistory
import io.github.sbgitcs.usagemonitor.model.*
import io.github.sbgitcs.usagemonitor.widget.planWidgetStats
import io.github.sbgitcs.usagemonitor.alerts.planWindowKey
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SubscriptionTest {
    private val now = 1_800_000_000_000L
    private val weekly = PlanWindow("weekly", "Weekly", 42.0, now + 86_400_000, null, null)
    private fun grok(source: String = "desktop", state: String = "ok") = Provider("grok", "Grok Build", "SuperGrok", state, null,
        listOf(weekly, PlanWindow("credits", "Credits $12.50", null, null, null, null)), account = "grok@test.invalid", source = source,
        fetchedAt = now, sharedWeekly = weekly, accountId = "grok-account")
    private fun cursor(source: String = "desktop") = Provider("cursor", "Cursor", "Pro", "ok", null,
        listOf(PlanWindow("monthly", "Included", 90.0, now + 86_400_000, null, null)), account = "unrelated@test.invalid", source = source, fetchedAt = now)

    @Test fun combinedPoolDoesNotAddPercentagesAndKeepsAdditionalUsageSeparate() {
        val original = listOf(grok(), cursor())
        assertSame(original, consolidateSubscription(original, "legacy", now))
        val x = consolidateSubscription(original, "combined", now).single()
        assertEquals("x_subscription", x.id)
        assertEquals(42.0, x.currentWindow()!!.usedPct!!, 0.0)
        assertEquals("grok-account", x.accountId)
        assertEquals("Additional Usage $12.50", x.windows[1].label)
        assertEquals(2, original.size)
        assertTrue(planWidgetStats(listOf(x)).single().label.startsWith("X Subscription"))
    }

    @Test fun additionalUsageCannotReplaceTheLegacyWeeklyPrimaryReading() {
        val p = grok().copy(windows = listOf(weekly, PlanWindow("credits", "Credits", 99.0, null, null, null)))
        assertEquals(42.0, p.currentWindow()!!.usedPct!!, 0.0)
        assertNull(p.copy(windows = p.windows.drop(1)).currentWindow())
    }

    @Test fun sharedUsageRequiresExplicitWeeklyTotalAndCursorCoverage() {
        val body = JSONObject("""{"creditUsagePercent":0,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2099-01-01T00:00:00Z"},"productUsage":[{"product":"Cursor","usagePercent":12},{"product":"GrokBuild","usagePercent":15}]}""")
        assertEquals(0.0, UsageApi.mapGrok(body, now).sharedWeekly!!.usedPct!!, 0.0)
        for (value in listOf(JSONObject.NULL, "", true, "bad", -1)) {
            body.put("creditUsagePercent", value)
            assertNull(UsageApi.mapGrok(body, now).sharedWeekly)
        }
        body.put("creditUsagePercent", 30)
        body.getJSONObject("currentPeriod").put("type", "BIWEEKLY")
        assertNull(UsageApi.mapGrok(body, now).sharedWeekly)
        body.getJSONObject("currentPeriod").put("type", "USAGE_PERIOD_TYPE_WEEKLY")
        body.remove("productUsage")
        assertNull(UsageApi.mapGrok(body, now).sharedWeekly)
        assertNull(UsageApi.mapGrok(JSONObject("""{"used":{"val":25},"monthlyLimit":{"val":100},"currentPeriod":{"type":"WEEKLY","end":"2099-01-01T00:00:00Z"}}"""), now).sharedWeekly)
    }

    @Test fun missingAndExpiredPoolIsUnavailableAndCreditsNeverBecomeThePrimaryMeter() {
        for (shared in listOf(null, weekly.copy(resetsAt = now - 1))) {
            val p = grok().copy(sharedWeekly = shared, windows = listOf(PlanWindow("credits", "Credits", 99.0, null, null, null)))
            val x = consolidateSubscription(listOf(p, cursor()), "combined", now).single()
            assertEquals("unknown", x.state)
            assertNull(x.currentWindow())
            assertEquals(2, x.windows.size)
        }
        val x = consolidateSubscription(listOf(grok(state = "stale")), "combined", now).single()
        assertEquals("stale", x.state)
        assertTrue(planWidgetStats(listOf(x)).single().label.contains("Old"))
    }

    @Test fun phoneRegimeDoesNotOverridePairedComputerAndPhoneAccountsDoNotBorrowItsPool() {
        val pc = consolidateSubscription(listOf(grok(), cursor()), "combined", now)
        assertEquals("x_subscription", PlanReadings.selectReadings(pc, emptyList(), "legacy", "combined", now).single().id)
        val phone = grok("phone").copy(accountId = "phone-account", subscriptionRegime = "combined")
        val result = PlanReadings.selectReadings(pc, listOf(phone), "combined", "combined", now).single()
        assertEquals("phone", result.source)
        assertEquals("phone-account", result.accountId)
        val legacy = PlanReadings.selectReadings(pc, listOf(phone.copy(subscriptionRegime = "legacy")), "legacy", "combined", now)
        assertEquals(listOf("grok"), legacy.map { it.id })
        val unverified = PlanReadings.selectReadings(pc, listOf(cursor("phone")), "combined", "combined", now).single()
        assertEquals("unknown", unverified.state)
        assertNull(unverified.currentWindow())
    }

    @Test fun linkedPoolReplacesStaleComputerPoolButCannotUseAnotherRegime() {
        val pc = consolidateSubscription(listOf(grok(state = "stale")), "combined", now)
        val linked = grok("linked").copy(subscriptionRegime = "combined")
        assertEquals("linked", PlanReadings.selectReadings(pc, listOf(linked), "legacy", "combined", now).single().source)
        assertEquals("desktop", PlanReadings.selectReadings(pc, listOf(linked.copy(subscriptionRegime = "legacy")), "legacy", "combined", now).single().source)
    }

    @Test fun snapshotsAndVaultPreserveMetadataAndOldPayloadsDefaultToLegacy() {
        val p = grok("linked").copy(subscriptionRegime = "combined", cacheScope = "scope")
        val parsed = DesktopSnapshot.parse(DesktopSnapshot.providersJson(listOf(p))).providers.single()
        assertEquals(p.subscriptionRegime, parsed.subscriptionRegime)
        assertEquals(p.sharedWeekly, parsed.sharedWeekly)
        assertEquals(p.cacheScope, parsed.cacheScope)
        assertEquals(p.accountId, parsed.accountId)
        assertEquals("legacy", DesktopSnapshot.parse("""{"providers":[]}""").subscriptionRegime)
        val c = Credential("grok", TokenVault.LINKED, "token", userId = "id", subscriptionRegime = "combined")
        assertEquals(c, TokenVault.decode(TokenVault.encode(listOf(c))).single())
        val old = PlanReadings.linkedCredentials(JSONObject("""{"grok":{"access_token":"token"}}""")).single()
        assertEquals("legacy", old.subscriptionRegime)
        assertNotEquals(credentialScope(c), credentialScope(c.copy(subscriptionRegime = "legacy")))
        assertNotEquals(credentialScope(c), credentialScope(c.copy(userId = "other")))
    }

    @Test fun sharedAlertsDeduplicateAcrossComputerAndLinkedReadingButIsolateAccounts() {
        val pc = consolidateSubscription(listOf(grok()), "combined", now).single()
        val linked = pc.copy(source = "linked", cacheScope = "different-cache")
        assertEquals(planWindowKey(pc, weekly), planWindowKey(linked, weekly))
        assertNotEquals(planWindowKey(pc, weekly), planWindowKey(linked.copy(accountId = "other"), weekly))
        assertNotEquals(planWindowKey(pc, weekly), planWindowKey(pc.copy(subscriptionRegime = "legacy"), weekly))
        assertNotEquals(planWindowKey(pc.copy(accountId = null), weekly), planWindowKey(linked.copy(accountId = null), weekly))
    }

    @Test fun historySeparatesRegimesAccountsAndSourcesAndExpiredComputerValuesAreNotCurrent() {
        var raw: String? = null
        for (p in listOf(grok(), grok().copy(subscriptionRegime = "combined"), grok("phone"), grok().copy(accountId = "other")))
            raw = InsightHistory.record(raw, DesktopSnapshot("", "", now, 80, listOf(p), null, null), now)
        assertEquals(4, JSONObject(raw!!).getJSONObject("series").length())
        val old = grok().copy(windows = listOf(weekly.copy(resetsAt = now - 1)))
        val expired = PlanReadings.fromDesktop(DesktopSnapshot("", "", now, 80, listOf(old), null, null), now, false, now).snapshot!!.providers.single()
        assertEquals("stale", expired.state)
        assertNull(expired.currentWindow())
    }
}
