package io.github.sbgitcs.usagemonitor.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.sbgitcs.usagemonitor.model.MeterConnection
import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.model.Provider
import io.github.sbgitcs.usagemonitor.net.Format

/** The data source as a small tag: Computer, Direct or Phone. */
@Composable
fun MeterSource(provider: Provider) {
    val source = MeterConnection.from(provider).source
    val phone = provider.source != "desktop"
    Surface(color = if (phone) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.secondaryContainer,
        contentColor = if (phone) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSecondaryContainer,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.semantics { contentDescription = "Data source: $source" }) {
        Text(source, modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp), style = MaterialTheme.typography.labelSmall)
    }
}

/** Title, one status line and Refresh. */
@Composable
fun DashboardHeader(status: String, busy: Boolean, onRefresh: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("AI plans", style = MaterialTheme.typography.titleMedium)
            Note(status)
        }
        IconButton(enabled = !busy, onClick = onRefresh) {
            if (busy) CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp).semantics { contentDescription = "Updating" })
            else Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
        }
    }
}

/**
 * One tool in a row: name and plan, the window that matters most as a bar and a big number, and
 * one line with when it resets (or runs out at this pace), the next window and the source.
 */
@Composable
fun UsageRow(p: Provider, warnAt: Double, now: Long, onClick: () -> Unit) {
    val window = p.currentWindow()
    val used = window?.usedPct
    val current = p.state == "ok"
    val hasReading = current || p.state == "stale"
    val color = if (current && used != null) meterColor(used, warnAt) else MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(p.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false))
                p.plan?.let {
                    Text("  $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
            }
            if (hasReading && used != null) {
                Spacer(Modifier.height(4.dp))
                LinearProgressIndicator(
                    progress = { (used / 100).toFloat().coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth().height(5.dp),
                    color = color,
                    trackColor = MaterialTheme.colorScheme.surfaceVariant,
                    gapSize = 0.dp,
                    drawStopIndicator = {},
                )
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(usageLine(p, window, now), style = MaterialTheme.typography.bodySmall,
                    color = if (current && window?.forecastAt != null) StatusColors.warn else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                // The header names the computer, so only readings made on this phone are tagged.
                if (p.source != "desktop") {
                    Text("  ", style = MaterialTheme.typography.bodySmall)
                    MeterSource(p)
                }
            }
        }
        Text(if (hasReading) p.usageValue ?: Format.percent(used) else "—",
            style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = color,
            textAlign = TextAlign.End, maxLines = 1, modifier = Modifier.padding(start = 10.dp).widthIn(min = 56.dp))
    }
}

/** "5h · resets in 2 h · Weekly 41%", "5h · full in 40 min at this pace", or why there is no reading. */
internal fun usageLine(p: Provider, window: PlanWindow?, now: Long): String {
    if (p.state != "ok" && p.state != "stale") return p.hint ?: Format.state(p.state) ?: "No reading yet"
    if (window == null) return p.hint ?: p.usageSummary ?: p.windows.firstOrNull()?.label ?: "No usage window"
    val parts = mutableListOf(window.label)
    val forecast = window.forecastAt
    when {
        p.state == "stale" -> parts += "last reading ${Format.ago(p.fetchedAt ?: now, now)}"
        forecast != null && (window.usedPct ?: 0.0) < 100 -> parts += "full ${Format.until(forecast, now)} at this pace"
        window.resetsAt != null -> parts += "resets ${Format.until(window.resetsAt, now)}"
    }
    p.windows.filter { it !== window && it.usedPct != null }.maxByOrNull { it.usedPct ?: 0.0 }?.let {
        parts += "${it.label} ${Format.percent(it.usedPct)}"
    }
    return parts.joinToString(" · ")
}
