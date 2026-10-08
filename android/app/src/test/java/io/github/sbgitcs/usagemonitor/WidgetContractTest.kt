package io.github.sbgitcs.usagemonitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import io.github.sbgitcs.usagemonitor.model.Provider
import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.widget.planWidgetStats
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class WidgetContractTest {
    @Test fun compactWidgetsLabelCachedValuesAndNeverDisplayFailedReadingsAsCurrent() {
        fun meter(id: String, state: String, used: Double) = Provider(id, id, null, state, null,
            listOf(PlanWindow("five_hour", "5h", used, null, null, null)), source = "phone")
        val stats = planWidgetStats(listOf(meter("Claude", "stale", 95.0), meter("Codex", "ok", 20.0),
            meter("Grok", "logged_out", 80.0), meter("Cursor", "fetch_failed", 70.0)))
        assertEquals("Codex Phone", stats.first().label)
        assertEquals("20%", stats.first().value)
        assertEquals("95%", stats[1].value)
        assertTrue(stats[1].label.contains("Old"))
        assertEquals("Sign in", stats[2].value)
        assertEquals("Retry", stats[3].value)
    }

    @Test
    fun everyWidgetPresetAllowsGrowingAndShrinkingBothDimensions() {
        val vectors = File(requireNotNull(System.getProperty("phoneVectors")))
        val root = requireNotNull(vectors.parentFile?.parentFile?.parentFile)
        val main = File(root, "android/app/src/main")
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val builder = factory.newDocumentBuilder()
        val manifest = builder.parse(File(main, "AndroidManifest.xml"))
        val metadata = manifest.getElementsByTagName("meta-data")
        val android = "http://schemas.android.com/apk/res/android"
        var checked = 0
        for (i in 0 until metadata.length) {
            val entry = metadata.item(i) as org.w3c.dom.Element
            if (entry.getAttributeNS(android, "name") != "android.appwidget.provider") continue
            val name = entry.getAttributeNS(android, "resource").removePrefix("@xml/")
            val widget = builder.parse(File(main, "res/xml/$name.xml")).documentElement
            assertEquals(name, "horizontal|vertical", widget.getAttributeNS(android, "resizeMode"))
            assertEquals(name, "40dp", widget.getAttributeNS(android, "minResizeWidth"))
            assertEquals(name, "40dp", widget.getAttributeNS(android, "minResizeHeight"))
            assertTrue(name, widget.getAttributeNS(android, "maxResizeWidth").isEmpty())
            assertTrue(name, widget.getAttributeNS(android, "maxResizeHeight").isEmpty())
            checked++
        }
        assertEquals("All advertised widgets must be resizable", 12, checked)
    }
}
