package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.direct.Credential
import io.github.sbgitcs.usagemonitor.direct.Http
import io.github.sbgitcs.usagemonitor.direct.HttpReply
import io.github.sbgitcs.usagemonitor.direct.UsageApi
import io.github.sbgitcs.usagemonitor.direct.UsageResult
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageApiTest {
    private val now = 1_700_000_000_000L

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private class Call(val method: String, val url: String, val headers: Map<String, String>, val body: String?)

    private class Fake(private val reply: (Call) -> HttpReply) : Http {
        val calls = mutableListOf<Call>()
        override fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?): HttpReply {
            val call = Call(method, url, headers, body?.toString(Charsets.UTF_8))
            calls.add(call)
            return reply(call)
        }
    }

    private fun ok(json: String) = HttpReply(200, json.toByteArray())

    @Test fun claudeDoesNotMakeZeroUtilizationFromAResetTime() {
        val p = UsageApi.mapClaude(JSONObject("""{"five_hour":{"resets_at":"2030-01-01T00:00:00Z"}}"""), null, now)
        assertNull(p.windows[0].usedPct)
        assertEquals(1893456000000L, p.windows[0].resetsAt)
    }

    @Test fun claudeMapsWindowsScopedLimitsAndCredits() {
        val body = JSONObject("""{
          "five_hour":{"utilization":12.5,"resets_at":"2030-01-01T00:00:00Z"},
          "seven_day":{"utilization":"40"},
          "limits":[{"kind":"weekly_scoped","percent":7,"scope":{"model":{"display_name":"Large"}}},{"kind":"other"}],
          "spend":{"enabled":true,"limit":{"amount_minor":2000},"used":{"amount_minor":500}}}""")
        val p = UsageApi.mapClaude(body, "Max", now)
        assertEquals("Claude Code", p.name)
        assertEquals("Max", p.plan)
        assertEquals("ok", p.state)
        assertEquals(listOf("five_hour", "weekly", "weekly_scoped", "credits"), p.windows.map { it.kind })
        assertEquals(12.5, p.windows[0].usedPct!!, 0.0)
        assertEquals(40.0, p.windows[1].usedPct!!, 0.0)
        assertEquals("Large weekly", p.windows[2].label)
        assertEquals(25.0, p.windows[3].usedPct!!, 0.0)
    }

    @Test fun claudeClampsNegativePercent() {
        val p = UsageApi.mapClaude(JSONObject("""{"five_hour":{"utilization":-3}}"""), null, now)
        assertEquals(0.0, p.windows[0].usedPct!!, 0.0)
    }

    @Test fun codexHandlesDailyWindowsAndBadResetTimestamps() {
        val p = UsageApi.mapCodex(JSONObject("""{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":86400,"reset_at":"bad"}}}"""), now)
        assertEquals("daily", p.windows[0].kind)
        assertEquals(20.0, p.windows[0].usedPct!!, 0.0)
        assertNull(p.windows[0].resetsAt)
    }

    @Test fun codexMapsWindowsExtrasCreditsAndPlan() {
        val body = JSONObject("""{
          "plan_type":"plus",
          "rate_limit":{
            "primary_window":{"used_percent":10,"limit_window_seconds":18000,"reset_at":1893456000},
            "secondary_window":{"remaining_percent":70,"limit_window_seconds":604800,"reset_after_seconds":60}},
          "additional_rate_limits":[{"name":"Spark","primary_window":{"used_percent":5,"limit_window_seconds":18000}}],
          "rate_limit_reset_credits":{"available_count":2}}""")
        val p = UsageApi.mapCodex(body, now)
        assertEquals("Plus", p.plan)
        assertEquals(listOf("five_hour", "weekly", "five_hour", "credits"), p.windows.map { it.kind })
        assertEquals(1893456000000L, p.windows[0].resetsAt)
        assertEquals(30.0, p.windows[1].usedPct!!, 0.0)
        assertEquals(now + 60_000, p.windows[1].resetsAt)
        assertEquals("Spark 5h", p.windows[2].label)
        assertEquals("Reset credits ×2", p.windows[3].label)
        assertNull(p.windows[3].usedPct)
    }

    @Test fun grokMonthlyFallbackIsNotMislabeledWeekly() {
        val p = UsageApi.mapGrok(JSONObject("""{"used":{"val":25},"monthlyLimit":{"val":100},"productUsage":[null,{}]}"""), now)
        assertEquals("monthly", p.windows[0].kind)
        assertEquals(25.0, p.windows[0].usedPct!!, 0.0)
        assertEquals(0, UsageApi.mapGrok(JSONObject("""{"used":{"val":25},"monthlyLimit":{"val":"0"}}"""), now).windows.size)
    }

    @Test fun grokOmittedPercentIsZeroWhilePeriodIsLive() {
        val body = JSONObject("""{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2020-01-01T00:00:00Z","end":"2099-01-01T00:00:00Z"}}}""")
        val p = UsageApi.mapGrok(body, now)
        assertEquals("weekly", p.windows[0].kind)
        assertEquals(0.0, p.windows[0].usedPct!!, 0.0)
        assertEquals(4070908800000L, p.windows[0].resetsAt)
    }

    @Test fun grokSumsProductUsageAndKeepsPrepaidCredits() {
        val body = JSONObject("""{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2099-01-01T00:00:00Z"},
          "productUsage":[{"product":"GrokBuild","usagePercent":8},{"product":"GrokChat","usagePercent":2}],
          "prepaidBalance":{"val":"12.5"}}""")
        val p = UsageApi.mapGrok(body, now)
        assertEquals("SuperGrok", p.plan)
        assertEquals(10.0, p.windows[0].usedPct!!, 0.0)
        assertEquals("Credits $12.50", p.windows[1].label)
        assertNull(p.windows[1].usedPct)
    }

    @Test fun grokOnDemandCapGivesCreditsPercent() {
        val p = UsageApi.mapGrok(JSONObject("""{"creditUsagePercent":3,"onDemandCap":{"val":200},"onDemandUsed":{"val":50}}"""), now)
        assertEquals(25.0, p.windows[1].usedPct!!, 0.0)
    }

    @Test fun grokParsesCreditPercentFromGrpcWebFrame() {
        assertEquals(34.0, UsageApi.parseGrokCredits(hex("00000000070a050d00000842"))!!, 0.0)
    }

    @Test fun grokGrpcParserSkipsTrailersAndRejectsGarbage() {
        val trailer = "grpc-status: 0".toByteArray()
        val framed = byteArrayOf(0x80.toByte(), 0, 0, 0, trailer.size.toByte()) + trailer + hex("00000000070a050d00000842")
        assertEquals(34.0, UsageApi.parseGrokCredits(framed)!!, 0.0)
        assertNull(UsageApi.parseGrokCredits(ByteArray(0)))
        assertNull(UsageApi.parseGrokCredits(hex("0000000064")))
        assertNull(UsageApi.parseGrokCredits(hex("0000000000")))
    }

    @Test fun cursorMapsPercentsPlanAndSecondsReset() {
        val usage = JSONObject("""{"billingCycleEnd":"1893456000","planUsage":{"totalPercentUsed":42,"autoPercentUsed":10,"apiPercentUsed":"5.5"}}""")
        val p = UsageApi.mapCursor(JSONObject("""{"planInfo":{"planName":"  Pro\u0001 "}}"""), usage, now)
        assertEquals("Pro", p.plan)
        assertEquals(listOf("Included", "Auto", "API"), p.windows.map { it.label })
        assertEquals(42.0, p.windows[0].usedPct!!, 0.0)
        assertEquals(1893456000000L, p.windows[0].resetsAt)
        assertEquals(5.5, p.windows[2].usedPct!!, 0.0)
        assertNull(UsageApi.mapCursor(null, JSONObject("{}"), now).plan)
    }

    @Test fun geminiNeverShowsAnotherProvidersQuotaAndKeepsKeyedModelIds() {
        assertTrue(UsageApi.mapGeminiSummary(JSONObject("""{"groups":[{"displayName":"Claude","buckets":[{"remainingFraction":0}]}]}""")).isEmpty())
        val w = UsageApi.mapGeminiModels(JSONObject("""{"models":{
          "other-provider-model":{"quotaInfo":{"remainingFraction":0}},
          "gemini-pro":{"displayName":"Pro","quotaInfo":{"remainingFraction":0.25}}}}"""))
        assertEquals(1, w.size)
        assertEquals(75.0, w[0].usedPct!!, 0.0)
        assertEquals("quota", w[0].kind)
    }

    @Test fun geminiCollectsEveryGeminiGroup() {
        val body = JSONObject("""{"groups":[
          {"displayName":"Gemini Pro","buckets":[{"remainingFraction":0.5,"window":"DAILY","resetTime":"2030-01-01T00:00:00Z"}]},
          {"displayName":"Gemini Flash","buckets":[{"remainingFraction":"0.9","window":"WEEKLY"}]}]}""")
        val w = UsageApi.mapGeminiSummary(body)
        assertEquals(listOf("Gemini Pro Daily", "Gemini Flash Weekly"), w.map { it.label })
        assertEquals(50.0, w[0].usedPct!!, 0.0)
        assertEquals(10.0, w[1].usedPct!!, 1e-9)
        assertEquals(1893456000000L, w[0].resetsAt)
    }

    @Test fun geminiQuotaKeepsTheTwoFullestBuckets() {
        val w = UsageApi.mapGeminiQuota(JSONObject("""{"buckets":[
          {"modelId":"gemini-2.5-flash","remainingFraction":0.9},
          {"modelId":"gemini-3-pro","remainingFraction":0.1},
          {"modelId":"gemini-2.5-pro","remainingFraction":0.5}]}"""))
        assertEquals(listOf("3 Pro", "Pro"), w.map { it.label })
        assertEquals("daily", w[0].kind)
    }

    @Test fun geminiPlanPrefersPaidTierAndNamesFree() {
        assertEquals("Ultra", UsageApi.geminiPlan(JSONObject("""{"paidTier":{"name":"Ultra"},"currentTier":{"id":"free-tier"}}""")))
        assertEquals("Free", UsageApi.geminiPlan(JSONObject("""{"currentTier":{"id":"free-tier","name":"Gemini Code Assist"}}""")))
        assertEquals("Standard", UsageApi.geminiPlan(JSONObject("""{"currentTier":"Standard"}""")))
        assertNull(UsageApi.geminiPlan(JSONObject("{}")))
    }

    @Test fun fetchMapsStatusCodes() {
        val cred = Credential("claude", "phone", "tok", account = "me@example.com")
        assertEquals(UsageResult.AuthFailed, UsageApi(Fake { HttpReply(401, ByteArray(0)) }).fetch(cred, now))
        val forbidden = UsageApi(Fake { HttpReply(403, ByteArray(0)) }).fetch(cred, now)
        assertTrue(forbidden is UsageResult.Failed)
        assertTrue((forbidden as UsageResult.Failed).message.contains("403"))
        assertEquals(UsageResult.Failed("rate limited", true), UsageApi(Fake { HttpReply(429, ByteArray(0)) }).fetch(cred, now))
        assertEquals(UsageResult.Failed("HTTP 500"), UsageApi(Fake { HttpReply(500, ByteArray(0)) }).fetch(cred, now))
        val reply = UsageApi(Fake { ok("""{"five_hour":{"utilization":10}}""") }).fetch(cred.copy(plan = "Pro"), now)
        val p = (reply as UsageResult.Ok).provider
        assertEquals("phone", p.source)
        assertEquals("me@example.com", p.account)
        assertEquals("Pro", p.plan)
        assertEquals(now, p.fetchedAt)
    }

    @Test fun fetchReportsNetworkErrorsAsFailed() {
        val api = UsageApi { _, _, _, _ -> throw java.io.IOException("offline") }
        assertEquals(UsageResult.Failed("offline"), api.fetch(Credential("codex", "phone", "tok"), now))
    }

    @Test fun anEmptyClaudeResponseDoesNotClaimUsageWasRead() {
        assertEquals(UsageResult.Failed("No usage report was returned for this account"),
            UsageApi(Fake { ok("{}") }).fetch(Credential("claude", "phone", "tok"), now))
    }

    @Test fun claudeRequestCarriesTokenAndBetaHeader() {
        val fake = Fake { ok("{}") }
        UsageApi(fake).fetch(Credential("claude", "phone", "abc"), now)
        val call = fake.calls.single()
        assertEquals("GET", call.method)
        assertEquals("https://api.anthropic.com/api/oauth/usage", call.url)
        assertEquals("Bearer abc", call.headers["Authorization"])
        assertEquals("oauth-2025-04-20", call.headers["anthropic-beta"])
    }

    @Test fun codexRequestCarriesAccountId() {
        val fake = Fake { ok("""{"plan_type":"pro"}""") }
        UsageApi(fake).fetch(Credential("codex", "phone", "abc", accountId = "acct-1"), now)
        val call = fake.calls.single()
        assertEquals("Bearer abc", call.headers["Authorization"])
        assertEquals("acct-1", call.headers["ChatGPT-Account-Id"])
    }

    @Test fun grokFillsOmittedPercentFromGrpcCredits() {
        val fake = Fake { call ->
            if (call.url.contains("GetGrokCreditsConfig")) HttpReply(200, hex("00000000070a050d00000842"), mapOf("grpc-status" to "0"))
            else ok("""{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2020-01-01T00:00:00Z","end":"2099-01-01T00:00:00Z"}}}""")
        }
        val reply = UsageApi(fake).fetch(Credential("grok", "phone", "tok", userId = "u1"), now)
        assertEquals(34.0, (reply as UsageResult.Ok).provider.windows[0].usedPct!!, 0.0)
        assertEquals("u1", fake.calls[0].headers["x-userid"])
        assertEquals(listOf(0, 0, 0, 0, 2, 8, 0), fake.calls[1].body!!.map { it.code })
    }

    @Test fun grokIgnoresAFailingCreditsCall() {
        val fake = Fake { call ->
            if (call.url.contains("GetGrokCreditsConfig")) HttpReply(500, ByteArray(0))
            else ok("""{"config":{"currentPeriod":{"end":"2099-01-01T00:00:00Z"}}}""")
        }
        val reply = UsageApi(fake).fetch(Credential("grok", "phone", "tok"), now)
        assertEquals(0.0, (reply as UsageResult.Ok).provider.windows[0].usedPct!!, 0.0)
    }

    @Test fun cursorFetchPostsBothCalls() {
        val fake = Fake { call ->
            if (call.url.endsWith("GetPlanInfo")) ok("""{"planInfo":{"planName":"Pro"}}""")
            else ok("""{"billingCycleEnd":"1893456000000","planUsage":{"totalPercentUsed":20}}""")
        }
        val p = (UsageApi(fake).fetch(Credential("cursor", "phone", "tok"), now) as UsageResult.Ok).provider
        assertEquals("Pro", p.plan)
        assertEquals(20.0, p.windows[0].usedPct!!, 0.0)
        assertEquals("1", fake.calls[0].headers["Connect-Protocol-Version"])
        assertEquals("{}", fake.calls[0].body)
    }

    @Test fun geminiFallsBackToTheSecondHostAndSendsIdeType() {
        val fake = Fake { call ->
            when {
                call.url.startsWith("https://daily-") -> HttpReply(500, ByteArray(0))
                call.url.endsWith("loadCodeAssist") -> ok("""{"cloudaicompanionProject":"p1","paidTier":{"name":"Pro"}}""")
                call.url.endsWith("retrieveUserQuotaSummary") -> ok("""{"groups":[{"displayName":"Gemini","buckets":[{"remainingFraction":0.75,"window":"DAILY"}]}]}""")
                else -> HttpReply(404, ByteArray(0))
            }
        }
        val cred = Credential("gemini", "phone", "tok", extra = mapOf("ide_type" to "IDE_UNSPECIFIED"))
        val p = (UsageApi(fake).fetch(cred, now) as UsageResult.Ok).provider
        assertEquals("Pro", p.plan)
        assertEquals(25.0, p.windows[0].usedPct!!, 0.0)
        assertTrue(fake.calls[0].url.startsWith("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"))
        val load = fake.calls.first { it.url.startsWith("https://cloudcode-pa.") && it.url.endsWith("loadCodeAssist") }
        assertEquals("IDE_UNSPECIFIED", JSONObject(load.body!!).getJSONObject("metadata").getString("ideType"))
        val summary = fake.calls.first { it.url.endsWith("retrieveUserQuotaSummary") }
        assertEquals("p1", JSONObject(summary.body!!).getString("project"))
        assertNotNull(summary.headers["User-Agent"])
    }

    @Test fun geminiMapsAuthAndRateLimit() {
        val cred = Credential("gemini", "phone", "tok")
        assertEquals(UsageResult.AuthFailed, UsageApi(Fake { HttpReply(401, ByteArray(0)) }).fetch(cred, now))
        val limited = Fake { call -> if (call.url.endsWith("loadCodeAssist")) ok("{}") else HttpReply(429, ByteArray(0)) }
        assertEquals(UsageResult.Failed("rate limited", true), UsageApi(limited).fetch(cred, now))
        assertEquals(2, limited.calls.size)
    }
}
