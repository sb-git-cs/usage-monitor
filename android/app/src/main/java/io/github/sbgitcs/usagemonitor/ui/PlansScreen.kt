package io.github.sbgitcs.usagemonitor.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
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
import io.github.sbgitcs.usagemonitor.direct.PlanReadings
import io.github.sbgitcs.usagemonitor.model.MeterConnection
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

/**
 * Every plan meter, whether read from the computer or directly on this phone, refreshed every 30
 * seconds while on screen.
 */
@Composable
fun PlansScreen(settings: Settings, computer: PairedComputer?, onPair: () -> Unit, onAccounts: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var view by remember { mutableStateOf(PlanReadings.read(settings)) }
    var readAt by remember { mutableLongStateOf(settings.snapshotAt) }
    var error by remember { mutableStateOf<String?>(null) }
    var unpaired by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var selected by remember { mutableStateOf<String?>(null) }
    val snapshot = view.snapshot
    val shown = snapshot?.providers.orEmpty().filter { it.state != "disabled" && it.state != "not_installed" }
    val warnAt = snapshot?.alertThreshold?.toDouble() ?: 80.0

    suspend fun refresh(force: Boolean) {
        if (busy) return
        busy = true
        val result = runCatching { PlanReadings.refresh(context, settings, force) }
        result.onSuccess {
            view = it
            readAt = settings.snapshotAt
            error = settings.lastError
            unpaired = false
        }.onFailure {
            error = it.message
            unpaired = it is NotPairedException
        }
        busy = false
        now = System.currentTimeMillis()
        Widgets.refresh(context)
    }

    WhileVisible(computer, 30_000) { refresh(false) }

    if (computer == null && shown.isEmpty()) {
        ScreenList {
            item {
                Section("See your AI plan usage") {
                    Note("Pair with Usage Monitor on your computer, or sign in to Claude Code, Codex, Grok or Cursor on this phone.")
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Button(onClick = onPair) { Text("Pair computer") }
                        OutlinedButton(onClick = onAccounts) { Text("Sign in") }
                    }
                }
            }
        }
        return
    }

    val direct = shown.count { it.source != "desktop" }
    val status = listOfNotNull(
        when {
            computer == null -> "On this phone"
            view.computerCached -> "${computer.name} away" + if (readAt > 0) " · last ${Format.ago(readAt, now)}" else ""
            readAt > 0 -> "${computer.name} · ${Format.ago(readAt, now)}"
            else -> computer.name
        },
        if (computer != null && direct > 0) "$direct direct" else null,
    ).joinToString(" · ")

    ScreenList {
        item { DashboardHeader(status, busy, onRefresh = { scope.launch { refresh(true) } }) }
        if (unpaired || (snapshot == null && error != null)) item {
            Section(if (unpaired) "Pair again" else "Computer not reached") {
                error?.let { Note(it, color = MaterialTheme.colorScheme.error) }
                if (unpaired) {
                    Spacer(Modifier.height(6.dp))
                    Button(onClick = onPair) { Text("Pair again") }
                }
            }
        }
        if (shown.isNotEmpty()) item {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
                shown.forEachIndexed { i, p ->
                    if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    UsageRow(p, warnAt, now) { selected = p.id }
                }
            }
        }
        snapshot?.system?.let { sys ->
            item {
                Section(if (view.computerCached) "${snapshot.name} · last reading" else snapshot.name) {
                    val parts = listOfNotNull(
                        sys.cpu?.let { "CPU ${Format.percent(it)}" },
                        sys.mem?.let { "RAM ${Format.percent(it)}" },
                        sys.gpu?.let { "GPU ${Format.percent(it)}" },
                        sys.space?.let { "Disk ${Format.percent(it)} full" },
                    )
                    if (parts.isNotEmpty()) Text(parts.joinToString(" · "), style = MaterialTheme.typography.bodyMedium)
                    snapshot.network?.takeIf { it.state == "running" && !view.computerCached }?.let { n ->
                        Note("Network ↓ ${Format.rateShort(n.rxRate)}  ↑ ${Format.rateShort(n.txRate)}")
                    }
                }
            }
        }
    }
    shown.firstOrNull { it.id == selected }?.let { p ->
        CompactDialog(onDismissRequest = { selected = null },
            title = { Text(if (p.plan != null) "${p.name} · ${p.plan}" else p.name) },
            text = { ProviderDetails(settings, p, warnAt, now) },
            confirmButton = { TextButton(onClick = { selected = null }) { Text("Close") } },
            dismissButton = { TextButton(onClick = { selected = null; onAccounts() }) { Text("Accounts") } })
    }
}

@Composable
private fun ProviderDetails(settings: Settings, p: Provider, warnAt: Double, now: Long) {
    val scope = rememberCoroutineScope()
    var switching by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    fun ask(accountId: String?) {
        if (switching) return
        switching = true
        scope.launch {
            note = withContext(Dispatchers.IO) {
                runCatching { DesktopClient(settings).switchAccount(p.id, accountId) }.fold(
                    onSuccess = {
                        if (accountId == null) "Confirm the switch on your computer, then finish sign-in there."
                        else "Confirm the switch on your computer."
                    },
                    onFailure = { it.message ?: "The computer could not switch the account." },
                )
            }
            switching = false
        }
    }
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            MeterSource(p)
            Note("  " + (p.account?.takeIf { it.isNotBlank() } ?: MeterConnection.from(p).signInLabel) +
                (p.fetchedAt?.let { " · ${Format.ago(it, now)}" } ?: ""))
        }
        p.usageSummary?.let { Text(it) }
        val numeric = p.windows.filter { it.usedPct != null }
        if (numeric.isEmpty()) {
            if (p.usageSummary == null || p.state != "ok") Note(p.hint ?: Format.state(p.state) ?: "No reading yet")
        } else {
            if (p.state != "ok") Format.state(p.state)?.let { Note(it, color = StatusColors.warn) }
            for (w in numeric) {
                val used = w.usedPct ?: continue
                Meter(w.label, Format.percent(used), used,
                    if (p.state == "ok") meterColor(used, warnAt) else MaterialTheme.colorScheme.onSurfaceVariant,
                    if (p.state == "ok") windowDetail(w, used, now) else "Last reading · ${w.label}")
            }
        }
        if (p.accounts.size > 1) {
            Spacer(Modifier.height(6.dp))
            for (choice in p.accounts) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().clickable(enabled = !switching && !choice.active) { ask(choice.id) },
                ) {
                    RadioButton(selected = choice.active, onClick = null, enabled = !switching)
                    Text(choice.label)
                }
            }
        }
        if (p.source != "phone") TextButton(enabled = !switching, onClick = { ask(null) }) {
            Text(if (p.account.isNullOrBlank()) "Sign in on computer" else "Switch computer account")
        }
        note?.let { Note(it) }
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
