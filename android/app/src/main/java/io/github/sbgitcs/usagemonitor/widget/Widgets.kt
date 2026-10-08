package io.github.sbgitcs.usagemonitor.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import io.github.sbgitcs.usagemonitor.MainActivity
import io.github.sbgitcs.usagemonitor.R
import io.github.sbgitcs.usagemonitor.ui.Tab
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Redraws the home screen widgets. Each widget reads its data when it is drawn; writing a new
 * stamp into every widget's state makes a running widget session draw again with fresh readings.
 * The background refresh calls this every 15 minutes, the speed notification every minute and
 * the app whenever it is opened, much like the desktop app refreshes its chips.
 */
internal enum class WidgetTier { ONE, WIDE, STRIP, LARGE }

/**
 * 1×1, 2×1, 4×1 and 4×2. A short widget is one row; 4×2 is tall enough for the full meters.
 * Width under 80dp is a single cell even when the launcher's cell is taller than it is wide.
 */
internal fun widgetTier(widthDp: Float, heightDp: Float): WidgetTier = when {
    widthDp < 80f -> WidgetTier.ONE
    widthDp < 180f -> WidgetTier.WIDE
    heightDp < 110f -> WidgetTier.STRIP
    else -> WidgetTier.LARGE
}

internal data class WidgetStat(val label: String, val value: String)

object Widgets {
    val STAMP = longPreferencesKey("stamp")

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    suspend fun updateAll(context: Context) {
        val manager = GlanceAppWidgetManager(context)
        val now = System.currentTimeMillis()
        for (widget in listOf(PlanWidget(), DataWidget(), DeviceWidget())) {
            for (id in manager.getGlanceIds(widget.javaClass)) {
                updateAppWidgetState(context, id) { it[STAMP] = now }
                widget.update(context, id)
            }
        }
    }

    /** For callers that are not coroutines. */
    fun refresh(context: Context) {
        val app = context.applicationContext
        scope.launch { runCatching { updateAll(app) } }
    }
}

internal object WidgetColors {
    val background: ColorProvider @Composable get() = widgetColor(R.color.widget_surface)
    val foreground: ColorProvider @Composable get() = widgetColor(R.color.widget_foreground)
    val muted: ColorProvider @Composable get() = widgetColor(R.color.widget_muted)
    val primary: ColorProvider @Composable get() = widgetColor(R.color.widget_primary)
    val track: ColorProvider @Composable get() = widgetColor(R.color.widget_track)
    val warn: ColorProvider @Composable get() = widgetColor(R.color.widget_warning)
    val full = ColorProvider(Color(0xFFEF4444))

    @Composable
    fun forPercent(pct: Double, warnAt: Double): ColorProvider = when {
        pct >= 100 -> full
        pct >= warnAt -> warn
        else -> primary
    }
}

/** Resolve day/night resources using the public Color-based Glance API. */
@Composable
private fun widgetColor(resource: Int) = ColorProvider(Color(LocalContext.current.getColor(resource)))

@Composable
internal fun bodyStyle(bold: Boolean = false) = TextStyle(
    color = WidgetColors.foreground,
    fontSize = 13.sp,
    fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
)

@Composable
internal fun smallStyle() = TextStyle(color = WidgetColors.muted, fontSize = 11.sp)

@Composable
internal fun WidgetFrame(title: String, note: String?, destination: Tab = Tab.Plans, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .background(WidgetColors.background)
            .cornerRadius(16.dp)
            .padding(8.dp)
            .clickable(widgetAction(destination)),
    ) {
        Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(title, modifier = GlanceModifier.defaultWeight(), style = bodyStyle(bold = true), maxLines = 1)
            if (note != null) Text(note, style = smallStyle(), maxLines = 1)
        }
        Spacer(GlanceModifier.height(4.dp))
        content()
    }
}

@Composable
internal fun MeterRow(label: String, value: String, pct: Double, color: ColorProvider, detail: String? = null) {
    Column(modifier = GlanceModifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Row(modifier = GlanceModifier.fillMaxWidth()) {
            Text(label, modifier = GlanceModifier.defaultWeight(), style = bodyStyle(), maxLines = 1)
            Text(value, style = bodyStyle(bold = true), maxLines = 1)
        }
        Spacer(GlanceModifier.height(2.dp))
        LinearProgressIndicator(
            progress = (pct / 100).toFloat().coerceIn(0f, 1f),
            modifier = GlanceModifier.fillMaxWidth().height(4.dp),
            color = color,
            backgroundColor = WidgetColors.track,
        )
        if (detail != null) Text(detail, style = smallStyle(), maxLines = 1)
    }
}

@Composable
internal fun GlanceModifier.asWidget(destination: Tab): GlanceModifier =
    this.fillMaxSize()
        .appWidgetBackground()
        .background(WidgetColors.background)
        .cornerRadius(16.dp)
        .clickable(widgetAction(destination))

@Composable
private fun widgetAction(destination: Tab) = actionStartActivity(
    Intent(LocalContext.current, MainActivity::class.java)
        .setData(Uri.parse("usagemonitor-widget://${destination.name}"))
        .putExtra(MainActivity.WIDGET_TAB, destination.name)
        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
)

@Composable
internal fun OneCell(value: String, label: String, destination: Tab = Tab.Plans) {
    Column(
        modifier = GlanceModifier.asWidget(destination).padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            value,
            style = TextStyle(color = WidgetColors.foreground, fontSize = 15.sp, fontWeight = FontWeight.Bold),
            maxLines = 1,
        )
        Text(label, style = smallStyle(), maxLines = 1)
    }
}

@Composable
private fun StatColumn(stat: WidgetStat, modifier: GlanceModifier) {
    Column(modifier = modifier.padding(end = 4.dp)) {
        Text(stat.value, style = bodyStyle(bold = true), maxLines = 1)
        Text(stat.label, style = smallStyle(), maxLines = 1)
    }
}

@Composable
internal fun WideStats(stats: List<WidgetStat>, destination: Tab = Tab.Plans) {
    Row(
        modifier = GlanceModifier.asWidget(destination).padding(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        stats.take(2).forEach { StatColumn(it, GlanceModifier.defaultWeight()) }
    }
}

@Composable
internal fun StripStats(stats: List<WidgetStat>, destination: Tab = Tab.Plans) {
    Row(
        modifier = GlanceModifier.asWidget(destination).padding(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        stats.take(4).forEach { StatColumn(it, GlanceModifier.defaultWeight()) }
    }
}
