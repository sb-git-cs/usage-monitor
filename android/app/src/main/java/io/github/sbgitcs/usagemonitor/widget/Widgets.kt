package io.github.sbgitcs.usagemonitor.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.actionStartActivity
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
    val warn = ColorProvider(Color(0xFFF59E0B))
    val full = ColorProvider(Color(0xFFEF4444))

    @Composable
    fun forPercent(pct: Double, warnAt: Double): ColorProvider = when {
        pct >= 100 -> full
        pct >= warnAt -> warn
        else -> GlanceTheme.colors.primary
    }
}

@Composable
internal fun bodyStyle(bold: Boolean = false) = TextStyle(
    color = GlanceTheme.colors.onSurface,
    fontSize = 13.sp,
    fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
)

@Composable
internal fun smallStyle() = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp)

@Composable
internal fun WidgetFrame(title: String, note: String?, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .background(GlanceTheme.colors.widgetBackground)
            .cornerRadius(16.dp)
            .padding(12.dp)
            .clickable(actionStartActivity<MainActivity>()),
    ) {
        Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(title, modifier = GlanceModifier.defaultWeight(), style = bodyStyle(bold = true), maxLines = 1)
            if (note != null) Text(note, style = smallStyle(), maxLines = 1)
        }
        Spacer(GlanceModifier.height(6.dp))
        content()
    }
}

@Composable
internal fun MeterRow(label: String, value: String, pct: Double, color: ColorProvider, detail: String? = null) {
    Column(modifier = GlanceModifier.fillMaxWidth().padding(bottom = 6.dp)) {
        Row(modifier = GlanceModifier.fillMaxWidth()) {
            Text(label, modifier = GlanceModifier.defaultWeight(), style = bodyStyle(), maxLines = 1)
            Text(value, style = bodyStyle(bold = true), maxLines = 1)
        }
        Spacer(GlanceModifier.height(2.dp))
        LinearProgressIndicator(
            progress = (pct / 100).toFloat().coerceIn(0f, 1f),
            modifier = GlanceModifier.fillMaxWidth().height(4.dp),
            color = color,
            backgroundColor = GlanceTheme.colors.secondaryContainer,
        )
        if (detail != null) Text(detail, style = smallStyle(), maxLines = 1)
    }
}
