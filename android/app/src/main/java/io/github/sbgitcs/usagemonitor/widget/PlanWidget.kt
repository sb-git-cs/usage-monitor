package io.github.sbgitcs.usagemonitor.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.currentState
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.text.Text
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.model.Provider
import io.github.sbgitcs.usagemonitor.net.Format

/** The computer's plan meters (Claude Code, Codex, Gemini, Grok Build), from the last reading. */
class PlanWidget : GlanceAppWidget() {
    private class Model(val paired: Boolean, val snapshot: DesktopSnapshot?, val readAt: Long, val error: String?)

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val stamp = currentState(Widgets.STAMP) ?: 0L
            val model = remember(stamp) { read(context) }
            GlanceTheme { Content(model) }
        }
    }

    private fun read(context: Context): Model {
        val settings = Settings(context)
        val snapshot = settings.snapshotJson?.let { runCatching { DesktopSnapshot.parse(it) }.getOrNull() }
        return Model(settings.computer != null, snapshot, settings.snapshotAt, settings.lastError)
    }

    @Composable
    private fun Content(model: Model) {
        val now = System.currentTimeMillis()
        val snapshot = model.snapshot
        val note = if (snapshot != null && model.readAt > 0) Format.ago(model.readAt, now) else null
        WidgetFrame(snapshot?.name ?: "Plan meters", note) {
            when {
                !model.paired -> Text("Open Usage Monitor and pair it with your computer.", style = smallStyle())
                snapshot == null -> Text(model.error ?: "Waiting for the first reading from the computer.", style = smallStyle())
                else -> {
                    val shown = snapshot.providers.filter { it.state != "disabled" && it.state != "not_installed" }
                    if (shown.isEmpty()) Text("No plans are turned on in the desktop app.", style = smallStyle())
                    LazyColumn {
                        items(shown) { p -> ProviderRow(p, snapshot.alertThreshold.toDouble(), now) }
                        snapshot.system?.let { sys ->
                            item {
                                val parts = listOfNotNull(
                                    sys.cpu?.let { "CPU ${Format.percent(it)}" },
                                    sys.mem?.let { "RAM ${Format.percent(it)}" },
                                    sys.gpu?.let { "GPU ${Format.percent(it)}" },
                                    sys.space?.let { "Disk ${Format.percent(it)} full" },
                                )
                                if (parts.isNotEmpty()) Text(parts.joinToString(" · "), style = smallStyle(), maxLines = 1)
                            }
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun ProviderRow(p: Provider, warnAt: Double, now: Long) {
        val w = p.currentWindow()
        val used = w?.usedPct
        if (w == null || used == null) {
            Column(modifier = GlanceModifier.fillMaxWidth().padding(bottom = 6.dp)) {
                Text(p.name, style = bodyStyle(), maxLines = 1)
                Text(p.hint ?: Format.state(p.state) ?: "No reading yet", style = smallStyle(), maxLines = 1)
            }
            return
        }
        val forecast = w.forecastAt
        val detail = when {
            forecast != null && used < 100 -> "${w.label}: 100% ${Format.until(forecast, now)} at this pace"
            w.resetsAt != null -> "${w.label}: resets ${Format.until(w.resetsAt, now)}"
            else -> w.label
        }
        MeterRow(p.name, Format.percent(used), used, WidgetColors.forPercent(used, warnAt), detail)
    }
}

class PlanWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PlanWidget()
}
