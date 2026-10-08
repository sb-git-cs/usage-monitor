package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.model.MeterConnection
import io.github.sbgitcs.usagemonitor.model.MeterSignIn
import io.github.sbgitcs.usagemonitor.model.Provider
import org.junit.Assert.*
import org.junit.Test

class MeterConnectionTest {
    private val meter = Provider("codex", "Codex", null, "ok", null, emptyList(), account = "account@example.test")

    @Test fun sourceAndSignInBelongToTheReading() {
        assertEquals("Computer", MeterConnection.from(meter).source)
        assertEquals("Phone", MeterConnection.from(meter.copy(source = "phone")).source)
        assertEquals("Direct", MeterConnection.from(meter.copy(source = "linked")).source)
        assertEquals("PC", MeterConnection.from(meter).shortSource)
        assertEquals(MeterSignIn.SIGNED_IN, MeterConnection.from(meter).signIn)
        assertEquals(MeterSignIn.SIGNED_IN, MeterConnection.from(meter.copy(source = "phone", account = "phone-owner")).signIn)
    }

    @Test fun oldOrFailedReportsDoNotClaimCurrentSignIn() {
        assertEquals(MeterSignIn.LAST_KNOWN, MeterConnection.from(meter.copy(state = "stale")).signIn)
        assertEquals(MeterSignIn.UNVERIFIED, MeterConnection.from(meter.copy(state = "error")).signIn)
        assertEquals(MeterSignIn.UNVERIFIED, MeterConnection.from(meter.copy(state = "stale", account = null)).signIn)
        assertEquals(MeterSignIn.SIGNED_OUT, MeterConnection.from(meter.copy(state = "logged_out")).signIn)
        assertEquals(MeterSignIn.SIGNED_OUT, MeterConnection.from(meter.copy(state = "not_installed")).signIn)
    }

    @Test fun noReadingOrIdentityCannotBecomeSignedInByOpeningABrowser() {
        assertEquals("Not connected", MeterConnection.from(null).source)
        assertEquals(MeterSignIn.SIGNED_OUT, MeterConnection.from(null).signIn)
        assertEquals(MeterSignIn.UNVERIFIED, MeterConnection.from(meter.copy(account = null)).signIn)
        assertEquals(MeterSignIn.SIGNED_IN, MeterConnection.from(meter.copy(account = null, usageSummary = "12 AI credits")).signIn)
    }
}
