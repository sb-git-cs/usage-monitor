package io.github.sbgitcs.usagemonitor.ui

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.github.sbgitcs.usagemonitor.data.PairedComputer
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.model.DesktopSnapshot
import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.model.Provider
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.pairing.DesktopClient
import io.github.sbgitcs.usagemonitor.pairing.NotPairedException
import io.github.sbgitcs.usagemonitor.widget.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

/** The computer's plan meters and system readings, read every 30 seconds while on screen. */
@Composable
fun PlansScreen(settings: Settings, computer: PairedComputer?, onPair: () -> Unit) {
    if (computer == null) {
        ScreenList {
            item {
                Section("Pair with your computer") {
                    Note("The plan meters (Claude Code, Codex, Gemini CLI and Grok Build) come from Usage Monitor on your computer. Pair once and this phone reads them over your Wi-Fi.")
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = onPair) { Text("Pair") }
                }
            }
        }
        return
    }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var json by remember { mutableStateOf(settings.snapshotJson) }
    var readAt by remember { mutableLongStateOf(settings.snapshotAt) }
    var error by remember { mutableStateOf<String?>(null) }
    var unpaired by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val snapshot = remember(json) { json?.let { runCatching { DesktopSnapshot.parse(it) }.getOrNull() } }

    suspend fun refresh() {
        if (busy) return
        busy = true
        val result = withContext(Dispatchers.IO) { runCatching { DesktopClient(settings).refresh() } }
        result.onSuccess {
            json = it
            readAt = settings.snapshotAt
            error = null
            unpaired = false
        }.onFailure {
            error = it.message
            unpaired = it is NotPairedException
        }
        busy = false
        now = System.currentTimeMillis()
        Widgets.refresh(context)
    }

    WhileVisible(computer, 30_000) { refresh() }

    ScreenList {
        item {
            Section(
                title = snapshot?.name ?: computer.name,
                action = {
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    } else {
                        IconButton(onClick = { scope.launch { refresh() } }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
                    }
                },
            ) {
                if (readAt > 0) Note("Updated ${Format.ago(readAt, now)}" + (snapshot?.appVersion?.takeIf { it.isNotEmpty() }?.let { " · desktop app $it" } ?: ""))
                error?.let {
                    Spacer(Modifier.height(4.dp))
                    Note(if (snapshot != null) "$it Showing the last reading." else it, color = MaterialTheme.colorScheme.error)
                }
                if (unpaired) {
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = onPair) { Text("Pair again") }
                }
            }
        }
        if (snapshot != null) {
            val shown = snapshot.providers.filter { it.state != "disabled" && it.state != "not_installed" }
            items(shown, key = { it.id }) { p -> ProviderCard(p, snapshot.alertThreshold.toDouble(), now) }
            snapshot.system?.let { sys ->
                item {
                    Section("Computer") {
                        sys.cpu?.let { Meter("CPU", Format.percent(it), it, meterColor(it, 85.0)) }
                        sys.mem?.let { Meter("Memory", Format.percent(it), it, meterColor(it, 85.0)) }
                        sys.gpu?.let { Meter("GPU", Format.percent(it), it, meterColor(it, 85.0)) }
                        sys.disk?.let { Meter("Disk activity", Format.percent(it), it, meterColor(it, 90.0), sys.diskRate?.let { r -> Format.rate(r) }) }
                        sys.space?.let { Meter("Disk space used", Format.percent(it), it, meterColor(it, 90.0)) }
                        snapshot.network?.takeIf { it.state == "running" }?.let { n ->
                            Meter("Network", "↓ ${Format.rateShort(n.rxRate)}  ↑ ${Format.rateShort(n.txRate)}", null, MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProviderCard(p: Provider, warnAt: Double, now: Long) {
    Section(if (p.plan != null) "${p.name} · ${p.plan}" else p.name) {
        val numeric = p.windows.filter { it.usedPct != null }
        if (numeric.isEmpty()) {
            Note(p.hint ?: Format.state(p.state) ?: "No reading yet")
            return@Section
        }
        if (p.state != "ok") Format.state(p.state)?.let { Note(it, color = StatusColors.warn) }
        for (w in numeric) {
            val used = w.usedPct ?: continue
            Meter(w.label, Format.percent(used), used, meterColor(used, warnAt), windowDetail(w, used, now))
        }
    }
}

private fun windowDetail(w: PlanWindow, used: Double, now: Long): String? {
    val parts = mutableListOf<String>()
    w.resetsAt?.let { parts += "resets ${Format.until(it, now)}" }
    val forecast = w.forecastAt
    if (forecast != null && used < 100) parts += "100% ${Format.until(forecast, now)} at this pace"
    else w.burnPerHour?.takeIf { it > 0 }?.let { parts += String.format(Locale.US, "%.1f%% an hour", it) }
    return parts.joinToString(" · ").replaceFirstChar { it.uppercase() }.ifEmpty { null }
}
