package io.github.sbgitcs.usagemonitor.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.sbgitcs.usagemonitor.device.BatteryHistory
import io.github.sbgitcs.usagemonitor.device.BatteryLogic
import io.github.sbgitcs.usagemonitor.device.BatteryMonitor
import io.github.sbgitcs.usagemonitor.device.BatteryReading
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

@Composable
fun BatterySummaryChip(reading: BatteryReading?, onClick: () -> Unit) {
    val low = reading?.state == "discharging" && (reading.percent ?: 100) <= 20
    AssistChip(onClick = onClick, label = {
        Text("Phone battery ${reading?.percent?.let { "$it%" } ?: "—"} · ${reading?.description ?: "Unavailable"}",
            color = if (low) { if ((reading?.percent ?: 100) <= 10) MaterialTheme.colorScheme.error else StatusColors.warn }
                else MaterialTheme.colorScheme.onSurface)
    })
}

@Composable
fun BatteryHistorySection() {
    val context = LocalContext.current
    val history = remember { BatteryHistory.get(context) }
    var days by remember { mutableIntStateOf(7) }
    var points by remember { mutableStateOf(history.view(days)) }
    var selected by remember(days, points.size) { mutableIntStateOf((points.size - 1).coerceAtLeast(0)) }
    var clearing by remember { mutableStateOf(false) }
    var showAll by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(history.error) }
    WhileVisible(days, 10_000) {
        points = withContext(Dispatchers.IO) {
            runCatching { BatteryMonitor.refresh(context) }
            history.view(days)
        }
        error = history.error
    }
    val date = remember { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT) }
    Section("Battery history · this phone") {
        Note("30 days stored locally. Shading marks charging; gaps mark missing observations. Background updates may be delayed by Android.")
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (d in listOf(1, 7, 14, 30)) FilterChip(selected = days == d, onClick = { days = d; points = history.view(d) },
                label = { Text(if (d == 1) "24h" else "${d}d") })
        }
        if (error) Note("Battery history could not be saved.", color = MaterialTheme.colorScheme.error)
        if (points.isEmpty()) Note("No observations yet. History begins when the app reads the battery.")
        else {
            val line = MaterialTheme.colorScheme.primary
            val charging = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.15f)
            val grid = MaterialTheme.colorScheme.outlineVariant
            val first = points.first().t
            val span = (points.last().t - first).coerceAtLeast(60_000).toFloat()
            Note("Battery level (%) · 100 at top, 0 at bottom")
            Canvas(Modifier.fillMaxWidth().height(150.dp).semantics { contentDescription = "Battery percentage history. Use the slider below to inspect readings." }) {
                fun x(p: BatteryReading) = (p.t - first) / span * size.width
                fun y(p: BatteryReading) = size.height * (1 - (p.percent ?: 0) / 100f)
                for (pct in listOf(0f, 0.5f, 1f)) drawLine(grid, Offset(0f, size.height * pct), Offset(size.width, size.height * pct))
                for (i in points.indices) {
                    val p = points[i]
                    val prev = points.getOrNull(i - 1)
                    if (prev != null && !p.gap && p.t - prev.t <= BatteryLogic.GAP && p.state == prev.state) {
                        if (p.state == "charging") drawRect(charging, Offset(x(prev), 0f), Size(x(p) - x(prev), size.height))
                        drawLine(line, Offset(x(prev), y(prev)), Offset(x(p), y(p)), strokeWidth = 2.dp.toPx())
                    } else drawCircle(line, 2.dp.toPx(), Offset(x(p), y(p)))
                }
                points.getOrNull(selected)?.let { drawCircle(line, 4.dp.toPx(), Offset(x(it), y(it))) }
            }
            Note("${date.format(Date(points.first().t))} – ${date.format(Date(points.last().t))}")
            if (points.size > 1) Slider(value = selected.toFloat(), onValueChange = { selected = it.toInt() },
                valueRange = 0f..points.lastIndex.toFloat(), modifier = Modifier.semantics { contentDescription = "Select battery observation" })
            points.getOrNull(selected)?.let { Note("${date.format(Date(it.t))} · ${it.percent}% · ${it.state} · ${it.description}${it.source?.let { source -> " ($source)" } ?: ""}") }
            val sessions = BatteryLogic.sessions(points)
            Text("Observed charge / discharge sessions", style = MaterialTheme.typography.titleSmall)
            for (s in if (showAll) sessions else sessions.take(20)) {
                Text("${if (s.first.state == "charging") "Charging" else "Discharging"} · ${s.first.percent}% → ${s.last.percent}% · ${(s.last.percent ?: 0) - (s.first.percent ?: 0)} pp", style = MaterialTheme.typography.bodyMedium)
                Note("${date.format(Date(s.first.t))} – ${date.format(Date(s.last.t))} · ${(s.last.t - s.first.t) / 60_000}m observed${if (s.partial) " · Partial" else ""}")
            }
            if (!showAll && sessions.size > 20) TextButton(onClick = { showAll = true }) { Text("Show all sessions") }
            Note("Partial sessions have an unobserved start or end. No activity is inferred during gaps.")
        }
        TextButton(onClick = { clearing = true }) { Text("Clear battery history") }
    }
    if (clearing) AlertDialog(onDismissRequest = { clearing = false }, title = { Text("Clear battery history?") },
        text = { Text("This removes battery observations stored on this phone.") },
        confirmButton = { TextButton(onClick = { history.clear(); points = history.view(days); error = history.error; clearing = false }) { Text("Clear") } },
        dismissButton = { TextButton(onClick = { clearing = false }) { Text("Cancel") } })
}
