package io.github.sbgitcs.usagemonitor.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.sbgitcs.usagemonitor.BuildConfig
import io.github.sbgitcs.usagemonitor.data.InsightHistory
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.direct.PlanReadings
import io.github.sbgitcs.usagemonitor.net.DataUsage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsightsScreen(settings: Settings, onDisplayChanged: () -> Unit, onAccounts: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var days by remember { mutableIntStateOf(7) }
    // The history file can be megabytes; it is read off the main thread below.
    var data by remember { mutableStateOf(JSONObject()) }
    var view by remember { mutableStateOf(PlanReadings.read(settings)) }
    var message by remember { mutableStateOf<String?>(null) }
    var exportText by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf(settings.themeMode) }
    var scale by remember { mutableStateOf(settings.textScale) }
    var hidden by remember { mutableStateOf(settings.hiddenProviders) }
    var snooze by remember { mutableStateOf(settings.snoozeUntil) }
    var busy by remember { mutableStateOf(false) }
    val time: (Long) -> String = { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it)) }
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null) scope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { context.contentResolver.openOutputStream(uri)?.use { it.write(exportText.toByteArray()) } ?: error("File could not be opened") } }
            message = if (result.isSuccess) "Report saved." else "Could not save the report. Check folder permissions and free space."
        }
    }
    WhileVisible(Unit, 10_000) {
        data = withContext(Dispatchers.IO) { InsightHistory.read(settings.insightsJson) }
        view = PlanReadings.read(settings)
    }
    val series = data.optJSONObject("series") ?: JSONObject()
    val cutoff = System.currentTimeMillis() - days * InsightHistory.DAY
    val observations = series.keys().asSequence().mapNotNull { series.optJSONObject(it) }.mapNotNull { s ->
        val points = s.optJSONArray("points") ?: JSONArray()
        val visible = (0 until points.length()).mapNotNull { points.optJSONObject(it) }.filter { it.optLong("at") >= cutoff }
        if (visible.isEmpty()) null else s to visible
    }.toList()
    val events = data.optJSONArray("events") ?: JSONArray()
    ScreenList {
        item { BatteryHistorySection() }
        item {
            Section("Plan history") {
                Note("Observed quota percentages, separated by account and reset. Retained for 31 days; these are not token counts or costs. Unidentified accounts cannot be separated reliably.")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (d in listOf(1, 7, 30)) FilterChip(selected = days == d, onClick = { days = d }, label = { Text(if (d == 1) "24h" else "${d}d") })
                }
                TextButton(onClick = {
                    exportText = JSONObject().put("unit", "quota_percent_used").put("days", days).put("series", JSONArray(observations.map { (s, points) ->
                        JSONObject(s.toString()).put("points", JSONArray(points))
                    })).toString(2)
                    export.launch("usage-history.json")
                }) { Text("Export history") }
                message?.let { Note(it) }
                if (observations.isEmpty()) Note("No observations yet. History begins when a current usage reading is received.")
            }
        }
        items(observations) { (s, points) ->
            Section("${PlanReadings.NAMES[s.optString("provider")] ?: s.optString("provider")} · ${s.optString("label")}") {
                Note("Account ${s.optString("account_ref")} · ${points.size} observations")
                val color = MaterialTheme.colorScheme.primary
                val description = "Quota usage ${points.first().optDouble("used")} to ${points.last().optDouble("used")}% across reset windows"
                Canvas(Modifier.fillMaxWidth().height(100.dp).semantics { contentDescription = description }) {
                    val first = points.first().optLong("at")
                    val span = (points.last().optLong("at") - first).coerceAtLeast(1)
                    var previous: Offset? = null
                    var segment: String? = null
                    for (p in points) {
                        val xy = Offset(((p.optLong("at") - first).toFloat() / span * size.width), (1 - p.optDouble("used").coerceIn(0.0, 100.0).toFloat() / 100) * size.height)
                        if (previous != null && segment == p.optString("segment")) drawLine(color, previous!!, xy, strokeWidth = 3f)
                        drawCircle(color, radius = 3f, center = xy)
                        previous = xy; segment = p.optString("segment")
                    }
                }
                Note("${time(points.first().optLong("at"))} — ${time(points.last().optLong("at"))}")
            }
        }
        item {
            Section("Notification centre") {
                Note(if (snooze > System.currentTimeMillis()) "Alerts snoozed until ${time(snooze)}. Events are still recorded." else "Alerts active; quiet hours still apply.")
                Row {
                    TextButton(onClick = { settings.snoozeUntil = System.currentTimeMillis() + 60 * 60_000L; snooze = settings.snoozeUntil }) { Text("Snooze 1 hour") }
                    TextButton(onClick = { settings.snoozeUntil = 0; snooze = 0 }) { Text("Resume") }
                }
                if (events.length() == 0) Note("No warnings recorded yet.")
            }
        }
        items((0 until events.length()).reversed().mapNotNull { events.optJSONObject(it) }.take(50)) { e ->
            Section(e.optString("title")) { Text(e.optString("body")); Note("${time(e.optLong("at"))} · ${e.optString("delivery")}") }
        }
        item {
            Section("Diagnostics") {
                val allowed = androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()
                Note("Notifications: ${if (allowed) "allowed" else "permission needed"} · Usage access: ${if (DataUsage.hasAccess(context)) "allowed" else "permission needed"}")
                Note("Computer: ${if (settings.computer == null) "not paired" else if (view.computerCached) "cached / unreachable" else "current"}")
                view.snapshot?.providers?.forEach { p -> Note("${p.name}: ${p.state} · ${p.source} · last read ${p.fetchedAt?.let(time) ?: "unknown"}") }
                TextButton(enabled = !busy, onClick = { scope.launch {
                    busy = true
                    runCatching { PlanReadings.refresh(context, settings, force = true) }.onSuccess { view = it; message = "Readings refreshed." }.onFailure { message = "Refresh failed. Review Accounts and your computer connection." }
                    data = withContext(Dispatchers.IO) { InsightHistory.read(settings.insightsJson) }
                    busy = false
                } }) { Text(if (busy) "Refreshing…" else "Retry readings") }
                TextButton(onClick = onAccounts) { Text("Open Accounts") }
                TextButton(onClick = {
                    exportText = JSONObject().put("version", BuildConfig.VERSION_NAME).put("platform", "android").put("notifications_allowed", allowed)
                        .put("usage_access", DataUsage.hasAccess(context)).put("computer_paired", settings.computer != null)
                        .put("providers", JSONArray(view.snapshot?.providers.orEmpty().map { p -> JSONObject().put("id", p.id).put("state", p.state).put("source", p.source).putOpt("last_read", p.fetchedAt) })).toString(2)
                    export.launch("usage-diagnostics.json")
                }) { Text("Export redacted support report") }
                Note("Support reports exclude credentials, account identities, addresses and notification text.")
            }
        }
        item {
            Section("Display preferences") {
                Row { for (m in listOf("system", "light", "dark")) TextButton(onClick = { mode = m; settings.themeMode = m; onDisplayChanged() }) { Text(if (mode == m) "✓ $m" else m) } }
                Row { for (v in listOf(1f, 1.15f, 1.3f)) TextButton(onClick = { scale = v; settings.textScale = v; onDisplayChanged() }) { Text("${if (scale == v) "✓ " else ""}${(v * 100).toInt()}%") } }
                Note("Shown on Home; widgets keep all providers.")
                for (id in PlanReadings.MOBILE) Row {
                    Checkbox(checked = id !in hidden, onCheckedChange = { checked -> hidden = if (checked) hidden - id else hidden + id; settings.hiddenProviders = hidden })
                    Text(PlanReadings.NAMES[id] ?: id)
                }
            }
        }
    }
}
