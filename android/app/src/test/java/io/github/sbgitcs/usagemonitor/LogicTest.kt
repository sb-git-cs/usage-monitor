package io.github.sbgitcs.usagemonitor

import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.net.DataPlan
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.update.UpdateManifest
import io.github.sbgitcs.usagemonitor.update.Versions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class LogicTest {
    private val zone = ZoneId.of("Asia/Kolkata")

    private fun at(y: Int, m: Int, d: Int, h: Int = 12) = ZonedDateTime.of(y, m, d, h, 0, 0, 0, zone)

    @Test
    fun billingCycleStartsOnTheBillingDayAndClampsShortMonths() {
        assertEquals(at(2026, 9, 15, 0), DataPlan.cycleStart(15, at(2026, 9, 29)))
        assertEquals(at(2026, 8, 15, 0), DataPlan.cycleStart(15, at(2026, 9, 3)))
        assertEquals(at(2026, 2, 28, 0), DataPlan.cycleStart(31, at(2026, 3, 10)))
        assertEquals(at(2026, 3, 31, 0), DataPlan.cycleEnd(31, at(2026, 3, 10)))
        assertEquals(at(2026, 10, 1, 0), DataPlan.cycleEnd(1, at(2026, 9, 29)))
        assertEquals(at(2026, 9, 29, 0), DataPlan.dayStart(at(2026, 9, 29, 18)))
    }

    @Test
    fun cycleProjectionScalesTheUseSoFar() {
        // 10 of 30 days gone, 3 GB used: about 9 GB by the end.
        val gb = 1024L * 1024 * 1024
        val projected = DataPlan.projected(3 * gb, 1, at(2026, 9, 11, 0))
        assertTrue(projected in (8.9 * gb).toLong()..(9.1 * gb).toLong())
    }

    @Test
    fun versionsSortLikeTheDesktop() {
        assertEquals(1, Versions.compare("1.10.0", "1.9.9"))
        assertEquals(0, Versions.compare("v1.3.0", "1.3"))
        assertEquals(1, Versions.compare("1.3.0", "1.3.0-beta.1"))
        assertEquals(1, Versions.compare("1.3.0-beta.10", "1.3.0-beta.2"))
        assertEquals(-1, Versions.compare("1.2.0", "1.3.0-beta.1"))
    }

    @Test
    fun updateManifestIsValidatedBeforeUse() {
        val good = """{"version":"1.3.0","version_code":1030099,"file":"UsageMonitor-1.3.0.apk","sha256":"${"ab".repeat(32)}","size":12345}"""
        assertEquals(1030099, UpdateManifest.parse(good)!!.versionCode)
        assertNull(UpdateManifest.parse(good.replace("UsageMonitor-1.3.0.apk", "../evil.apk")))
        assertNull(UpdateManifest.parse(good.replace("ab".repeat(32), "xyz")))
        assertNull(UpdateManifest.parse("not json"))
    }

    @Test
    fun snapshotParsesMetersForecastsAndMissingValues() {
        val json = """{"v":1,"app_version":"1.3.0","name":"Studio PC","generated_at":"2026-09-29T10:00:00.000Z","alert_threshold":70,
          "providers":[{"id":"claude","display_name":"Claude Code","plan":"Max 20x","status":{"state":"ok","hint":null},
            "windows":[{"kind":"weekly","label":"Weekly","used_pct":91,"resets_at":"2026-10-02T10:00:00.000Z","forecast_at":null,"burn_per_hour":null},
                       {"kind":"five_hour","label":"5h","used_pct":62.5,"resets_at":"2026-09-29T12:10:00.000Z","forecast_at":"2026-09-29T11:20:00.000Z","burn_per_hour":28.5}]},
            {"id":"grok","display_name":"Grok Build","plan":null,"status":{"state":"logged_out","hint":"Run grok login"},"windows":[]}],
          "system":{"cpu":12.5,"mem":null,"gpu":null,"disk":8,"disk_rate":null,"space":71.2},"network":{"state":"running","rx_rate":1024,"tx_rate":10},"extra":"ignored"}"""
        val s = DesktopSnapshot.parse(json)
        assertEquals(70, s.alertThreshold)
        assertEquals("Studio PC", s.name)
        val claude = s.providers.first()
        assertEquals("5h", claude.currentWindow()!!.label)
        assertEquals(28.5, claude.currentWindow()!!.burnPerHour!!, 0.0)
        assertTrue(claude.currentWindow()!!.forecastAt!! < claude.currentWindow()!!.resetsAt!!)
        assertNull(claude.windows.first().forecastAt)
        assertEquals("Run grok login", s.providers[1].hint)
        assertNull(s.providers[1].currentWindow())
        assertNull(s.system!!.mem)
        assertEquals(12.5, s.system!!.cpu!!, 0.0)
    }

    @Test
    fun formattingMatchesTheDesktop() {
        assertEquals("0 B", Format.bytes(0.0))
        assertEquals("1.50 MB", Format.bytes(1.5 * 1024 * 1024))
        assertEquals("120 MB/s", Format.rateShort(120.0 * 1024 * 1024))
        assertEquals("8.8 KB/s", Format.rateShort(8.8 * 1024))
        assertEquals("1.2" to "MB/s", Format.rateIcon(1.2 * 1024 * 1024))
        assertEquals("—", Format.percent(null))
    }

    @Test
    fun relativeTimesReadNaturally() {
        val now = 1_000_000_000L
        val min = 60_000L
        assertEquals("just now", Format.ago(now - 20_000, now))
        assertEquals("5 min ago", Format.ago(now - 5 * min, now))
        assertEquals("3 h ago", Format.ago(now - 190 * min, now))
        assertEquals("2 days ago", Format.ago(now - 49 * 60 * min, now))
        assertEquals("in 45 min", Format.until(now + 45 * min - 10_000, now))
        assertEquals("in 2 h", Format.until(now + 120 * min, now))
        assertEquals("in 2 h 10 min", Format.until(now + 130 * min, now))
        assertEquals("in 1 day", Format.until(now + 30 * 60 * min, now))
        assertEquals("in 3 days", Format.until(now + 70 * 60 * min, now))
        assertEquals("in 0 min", Format.until(now - min, now))
    }

    @Test
    fun capsAndQuietHoursAreParsedStrictly() {
        assertEquals("1.5", Format.gigabytes(1536L * 1024 * 1024))
        assertEquals("50", Format.gigabytes(50L * 1024 * 1024 * 1024))
        assertEquals("07:05", Settings.normalizeTime("7:05"))
        assertEquals("22:00", Settings.normalizeTime(" 22:00 "))
        assertNull(Settings.normalizeTime("24:00"))
        assertNull(Settings.normalizeTime("7:5"))
        assertNull(Settings.normalizeTime("seven"))
        assertEquals("Signed out on the computer", Format.state("logged_out"))
        assertNull(Format.state("ok"))
    }
}
