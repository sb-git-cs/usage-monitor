package io.github.sbgitcs.usagemonitor.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.net.AppData
import io.github.sbgitcs.usagemonitor.net.DataPlan
import io.github.sbgitcs.usagemonitor.net.DataStatus
import io.github.sbgitcs.usagemonitor.net.DataUsage
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.net.SpeedMeter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Live speed, mobile and Wi-Fi data today and this billing cycle, and the apps that used it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DataScreen(settings: Settings, resumes: Int) {
    val context = LocalContext.current
    val access = remember(resumes) { DataUsage.hasAccess(context) }
    val meter = remember { SpeedMeter() }
    var speed by remember { mutableStateOf(0.0 to 0.0) }
    var status by remember { mutableStateOf<DataStatus?>(null) }
    var apps by remember { mutableStateOf<List<AppData>>(emptyList()) }
    var period by rememberSaveable { mutableIntStateOf(0) }

    WhileVisible(Unit, 1000) { speed = meter.sample() }
    WhileVisible(access to period, 60_000) {
        if (!access) return@WhileVisible
        val (s, a) = withContext(Dispatchers.IO) {
            val now = ZonedDateTime.now(DataPlan.zone())
            val s = DataUsage.status(context, settings.billingDay, now)
            val start = if (period == 0) DataPlan.dayStart(now).toInstant().toEpochMilli() else (s?.cycleStart ?: 0L)
            s to DataUsage.perApp(context, start, now.toInstant().toEpochMilli()).take(40)
        }
        status = s
        apps = a
    }

    ScreenList {
        item {
            Section("Right now") {
                Row {
                    Figure("Download", Format.rateShort(speed.first), Modifier.weight(1f))
                    Figure("Upload", Format.rateShort(speed.second), Modifier.weight(1f))
                }
                Spacer(Modifier.height(4.dp))
                Note("Live network speed · This phone")
            }
        }
        if (!access) {
            item {
                Section("Allow Usage access") {
                    Note("Android keeps count of each app's mobile and Wi-Fi data. Usage Monitor needs Usage access to read those counts. Nothing leaves your phone.")
                    Spacer(Modifier.height(6.dp))
                    Button(onClick = {
                        openFirst(
                            context,
                            Intent(AndroidSettings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:${context.packageName}")),
                            Intent(AndroidSettings.ACTION_USAGE_ACCESS_SETTINGS),
                        )
                    }) { Text("Open Usage access") }
                }
            }
            return@ScreenList
        }
        val s = status ?: return@ScreenList
        item { TodayCard(settings, s) }
        item { CycleCard(settings, s) }
        item {
            Section("Apps") {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(selected = period == 0, onClick = { period = 0 }, label = { Text("Today") })
                    FilterChip(selected = period == 1, onClick = { period = 1 }, label = { Text("This cycle") })
                }
                if (apps.isEmpty()) Note("No data used yet.")
            }
        }
        items(apps, key = { it.uid }) { app -> AppRow(app) }
    }
}

@Composable
private fun TodayCard(settings: Settings, s: DataStatus) {
    Section("Today") {
        Row {
            Figure("Mobile", Format.bytes(s.today), Modifier.weight(1f))
            Figure("Wi-Fi", Format.bytes(s.todayTotals.wifi), Modifier.weight(1f))
        }
        val cap = settings.dailyCapMb * 1024 * 1024
        if (cap > 0) {
            val pct = s.today * 100.0 / cap
            Meter("Daily mobile cap", "${Format.bytes(s.today)} of ${Format.bytes(cap)}", pct, meterColor(pct, settings.capWarnPct.toDouble()))
        }
    }
}

@Composable
private fun CycleCard(settings: Settings, s: DataStatus) {
    val date = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
    val zone = DataPlan.zone()
    val from = date.format(Instant.ofEpochMilli(s.cycleStart).atZone(zone))
    val to = date.format(Instant.ofEpochMilli(s.cycleEnd).atZone(zone))
    Section("Billing cycle") {
        Note("$from to $to")
        Spacer(Modifier.height(6.dp))
        Row {
            Figure("Mobile", Format.bytes(s.cycle), Modifier.weight(1f))
            Figure("Wi-Fi", Format.bytes(s.cycleTotals.wifi), Modifier.weight(1f))
        }
        val cap = settings.monthlyCapMb * 1024 * 1024
        val projected = DataPlan.projected(s.cycle, settings.billingDay, ZonedDateTime.now(zone))
        if (cap > 0) {
            val pct = s.cycle * 100.0 / cap
            Meter(
                "Monthly mobile cap",
                "${Format.bytes(s.cycle)} of ${Format.bytes(cap)}",
                pct,
                meterColor(pct, settings.capWarnPct.toDouble()),
                "On pace for ${Format.bytes(projected)} by the end of the cycle" + if (projected > cap) ", past the cap" else "",
            )
        } else {
            Spacer(Modifier.height(4.dp))
            Note("On pace for ${Format.bytes(projected)} of mobile data this cycle. Set a cap in Settings to be warned before you reach it.")
        }
        if (s.cycleTotals.roaming > 0) Note("Roaming: ${Format.bytes(s.cycleTotals.roaming)}")
    }
}

@Composable
private fun AppRow(app: AppData) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 6.dp)) {
            Column(Modifier.weight(1f).padding(end = 6.dp)) {
                Text(app.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Note("Mobile ${Format.bytes(app.mobile)} · Wi-Fi ${Format.bytes(app.wifi)}")
            }
            Text(Format.bytes(app.total), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        }
        HorizontalDivider()
    }
}
