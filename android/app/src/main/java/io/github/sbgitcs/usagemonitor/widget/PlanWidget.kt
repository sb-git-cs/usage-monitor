package io.github.sbgitcs.usagemonitor.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.currentState
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.text.Text
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.direct.PlanReadings
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.model.Provider
import io.github.sbgitcs.usagemonitor.model.MeterConnection
import io.github.sbgitcs.usagemonitor.net.Format

/** Keep compact widgets useful offline and never show an old percentage as a live reading. */
internal fun planWidgetStats(providers: List<Provider>): List<WidgetStat> = providers
    .filter { it.state != "disabled" && it.state != "not_installed" }
    .sortedWith(compareByDescending<Provider> { it.state == "ok" }.thenByDescending { it.currentWindow()?.usedPct ?: -1.0 })
    .map { p ->
        val source = MeterConnection.from(p).shortSource
        val label = "${p.name.substringBefore(' ')} $source" + if (p.state == "stale") " · Old" else ""
        val value = when (p.state) {
            "ok", "stale" -> p.usageValue ?: Format.percent(p.currentWindow()?.usedPct)
            "logged_out" -> "Sign in"
            "fetch_failed", "error" -> "Retry"
            else -> "—"
        }
        WidgetStat(label, value)
    }

/** Every plan meter, from the last reading on the computer or this phone. Layout follows the widget's size. */
class PlanWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    private class Model(val paired: Boolean, val snapshot: DesktopSnapshot?, val readAt: Long, val error: String?, val computerCached: Boolean)

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val stamp = currentState(Widgets.STAMP) ?: 0L
            val model = remember(stamp) { read(context) }
            GlanceTheme { Content(model) }
        }
    }

    private fun read(context: Context): Model {
        val settings = Settings(context)
        val view = PlanReadings.read(settings)
        val connected = settings.computer != null || !view.snapshot?.providers.isNullOrEmpty()
        return Model(connected, view.snapshot, settings.snapshotAt, settings.lastError, view.computerCached)
    }

    @Composable
    private fun Content(model: Model) {
        val size = LocalSize.current
        val stats = planStats(model)
        when (widgetTier(size.width.value, size.height.value)) {
            WidgetTier.ONE -> OneCell(stats.first().value, stats.first().label)
            WidgetTier.WIDE -> WideStats(stats.take(2))
            WidgetTier.STRIP -> StripStats(stats.take(4))
            WidgetTier.LARGE -> Large(model)
        }
    }

    private fun planStats(model: Model): List<WidgetStat> {
        if (!model.paired) return listOf(WidgetStat("Plans", "Connect"))
        val snapshot = model.snapshot ?: return listOf(WidgetStat("Plans", "…"))
        return planWidgetStats(snapshot.providers).ifEmpty { listOf(WidgetStat("Plans", "None")) }
    }

    @Composable
    private fun Large(model: Model) {
        val now = System.currentTimeMillis()
        val snapshot = model.snapshot
        val providers = snapshot?.providers.orEmpty()
        val usesComputer = providers.any { it.source == "desktop" }
        val latest = providers.mapNotNull { it.fetchedAt }.maxOrNull()
        val note = if (usesComputer && model.computerCached) "PC cached"
            else latest?.let { Format.ago(it, now) }
                ?: model.readAt.takeIf { it > 0 }?.let { Format.ago(it, now) }
        WidgetFrame(if (usesComputer) snapshot?.name ?: "Plan meters" else "Plan meters", note) {
            when {
                !model.paired -> Text("Open Usage Monitor to pair a computer or sign in.", style = smallStyle())
                snapshot == null -> Text(model.error ?: "Waiting for the first reading from the computer.", style = smallStyle())
                else -> {
                    val shown = snapshot.providers.filter { it.state != "disabled" && it.state != "not_installed" }
                    if (shown.isEmpty()) Text("No plans are turned on in the desktop app.", style = smallStyle())
                    LazyColumn {
                        items(shown) { p -> ProviderRow(p, snapshot.alertThreshold.toDouble(), now) }
                        snapshot.system?.takeUnless { model.computerCached }?.let { sys ->
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
        val cached = p.state == "stale"
        val source = MeterConnection.from(p).shortSource
        val w = p.currentWindow()
        val used = w?.usedPct
        if (w == null || used == null || p.state !in setOf("ok", "stale")) {
            Column(modifier = GlanceModifier.fillMaxWidth().padding(bottom = 4.dp)) {
                Text("${p.name} · $source", style = bodyStyle(), maxLines = 1)
                val detail = if (p.state == "ok") p.usageSummary ?: p.hint
                    else p.hint ?: Format.state(p.state)
                Text(detail ?: "No reading yet", style = smallStyle(), maxLines = 2)
            }
            return
        }
        val forecast = w.forecastAt
        val detail = when {
            cached -> "${w.label} · last reading ${Format.ago(p.fetchedAt ?: now, now)}"
            forecast != null && used < 100 -> "${w.label} · full ${Format.until(forecast, now)} at this pace"
            w.resetsAt != null -> "${w.label} · resets ${Format.until(w.resetsAt, now)}"
            else -> w.label
        }
        MeterRow(p.name, Format.percent(used), used,
            if (cached) WidgetColors.muted else WidgetColors.forPercent(used, warnAt), "$detail · $source")
    }
}

class PlanWidgetReceiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PlanWidget()
}
