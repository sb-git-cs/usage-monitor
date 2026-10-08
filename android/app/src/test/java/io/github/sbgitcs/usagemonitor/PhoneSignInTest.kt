package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.direct.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class PhoneSignInTest {
    @After fun cancel() = PhoneSignIn.cancel()

    private fun reply(status: Int, text: String) = HttpReply(status, text.toByteArray())
    private fun query(url: String) = URI(url).rawQuery.split('&').associate {
        URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8")
    }
    private suspend fun step(predicate: (SignInStep) -> Boolean) = withTimeout(5_000) {
        PhoneSignIn.step.first { it != null && predicate(it) }!!
    }
    private fun http(usageStatus: Int = 200) = Http { _, url, _, _ ->
        when {
            url.endsWith("/token") -> reply(200, """{"access_token":"access","refresh_token":"refresh","expires_in":3600}""")
            url.endsWith("/profile") -> reply(200, """{"account":{"email":"phone@example.test","has_claude_pro":true}}""")
            else -> reply(usageStatus, """{"five_hour":{"utilization":17}}""")
        }
    }

    @Test fun claudeExchangesThePastedCodeWithTheMatchingPkceVerifier() = runBlocking {
        var fields = emptyMap<String, String>()
        var exchanged = false
        val credential = PhoneSignIn.claude(Http { method, url, _, body ->
            if (url.endsWith("/token")) {
                val json = JSONObject(String(body!!))
                assertEquals("POST", method)
                assertEquals("authorization-code", json.getString("code"))
                assertEquals(fields["state"], json.getString("state"))
                assertEquals(fields["redirect_uri"], json.getString("redirect_uri"))
                assertEquals(fields["code_challenge"], PhoneSignIn.challenge(json.getString("code_verifier")))
                exchanged = true
            }
            http().send(method, url, emptyMap(), body)
        }, { fields = query(it.url!!) }) { "  authorization-code#${fields.getValue("state")}  " }
        assertTrue(exchanged)
        assertEquals("user:profile", fields["scope"])
        assertEquals("phone@example.test", credential.account)
        assertEquals("Pro", credential.plan)
    }

    @Test fun acceptsTheDisplayedCodeAndCallbackButRejectsWrongStateAndExtraText() {
        assertEquals("abc_123", PhoneSignIn.claudeCode("abc_123#state", "state"))
        assertEquals("abc_123", PhoneSignIn.claudeCode("abc_123", "state"))
        assertEquals("abc_123", PhoneSignIn.claudeCode("https://platform.claude.com/oauth/code/callback?code=abc_123&state=state", "state"))
        for (bad in listOf("", "abc#wrong", "abc#", "code: abc", "abc def", "https://other.test/?code=abc&state=state")) {
            assertThrows(IOException::class.java) { PhoneSignIn.claudeCode(bad, "state") }
        }
    }

    @Test fun aRefusedUsageTokenIsNotSavedOrReportedConnected() = runBlocking {
        val saves = AtomicInteger()
        PhoneSignIn.start("claude", http(401)) { _, _ -> saves.incrementAndGet() }
        val waiting = step { it.needsPaste }
        PhoneSignIn.paste("code#${query(waiting.url!!).getValue("state")}")
        val failed = step { it.error != null }
        assertFalse(failed.done)
        assertEquals(0, saves.get())
    }

    @Test fun anUnavailableUsageReportKeepsAuthorizationAndExplainsThePendingReading() = runBlocking {
        var saved: UsageResult? = null
        PhoneSignIn.start("claude", http(503)) { _, reading -> saved = reading }
        val waiting = step { it.needsPaste }
        PhoneSignIn.paste("code#${query(waiting.url!!).getValue("state")}")
        val done = step { it.done }
        assertTrue(saved is UsageResult.Failed)
        assertTrue(done.notice!!.contains("Sign-in saved"))
    }

    @Test fun cancellingABlockingExchangeCannotSaveOrOverwriteANewerSignIn() = runBlocking {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val saves = AtomicInteger()
        val blocking = Http { method, url, headers, body ->
            if (url.endsWith("/token")) {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }
            http().send(method, url, headers, body).also { if (url.endsWith("/profile")) finished.countDown() }
        }
        PhoneSignIn.start("claude", blocking) { _, _ -> saves.incrementAndGet() }
        val waiting = step { it.needsPaste }
        PhoneSignIn.paste("code#${query(waiting.url!!).getValue("state")}")
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        assertTrue(PhoneSignIn.step.value!!.busy)
        PhoneSignIn.cancel()
        PhoneSignIn.start("claude", http()) { _, _ -> saves.incrementAndGet() }
        val newer = step { it.needsPaste }
        release.countDown()
        assertTrue(finished.await(5, TimeUnit.SECONDS))
        assertEquals(newer, PhoneSignIn.step.value)
        // Completing the new attempt also proves only it can commit.
        PhoneSignIn.paste("new-code#${query(newer.url!!).getValue("state")}")
        step { it.done }
        assertEquals(1, saves.get())
    }
}
