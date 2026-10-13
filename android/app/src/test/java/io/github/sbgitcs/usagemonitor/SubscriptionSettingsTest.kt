package io.github.sbgitcs.usagemonitor

import android.app.Application
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.data.PairedComputer
import io.github.sbgitcs.usagemonitor.direct.PlanReadings
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class SubscriptionSettingsTest {
    @Test fun independentPhoneViewCarriesItsOwnRegime() {
        val settings = Settings(RuntimeEnvironment.getApplication())
        settings.subscriptionRegime = "combined"
        settings.directJson = """{"providers":[{"id":"grok","display_name":"Grok Build","source":"phone","subscription_regime":"combined","status":{"state":"unknown"},"windows":[]}]}"""
        val snapshot = PlanReadings.read(settings).snapshot!!
        assertEquals("combined", snapshot.subscriptionRegime)
        assertEquals("x_subscription", snapshot.providers.single().id)
        assertEquals("phone", snapshot.providers.single().source)
    }
    @Test fun optInDefaultsOffPersistsAndKeepsPairingAndOtherPreferences() {
        val context = RuntimeEnvironment.getApplication()
        val first = Settings(context)
        assertEquals("legacy", first.subscriptionRegime)
        val pc = PairedComputer("Test PC", listOf("192.0.2.1"), 47329, "device", "test-key")
        first.computer = pc
        first.directJson = "{\"providers\":[]}"
        first.themeMode = "dark"
        first.subscriptionRegime = "combined"
        val restarted = Settings(context)
        assertEquals("combined", restarted.subscriptionRegime)
        assertEquals(pc, restarted.computer)
        assertEquals(first.directJson, restarted.directJson)
        assertEquals("dark", restarted.themeMode)
        restarted.subscriptionRegime = "legacy"
        assertEquals("legacy", Settings(context).subscriptionRegime)
        restarted.subscriptionRegime = "bad"
        assertEquals("legacy", Settings(context).subscriptionRegime)
    }
}
