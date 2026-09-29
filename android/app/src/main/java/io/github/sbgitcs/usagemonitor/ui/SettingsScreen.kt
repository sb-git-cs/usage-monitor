package io.github.sbgitcs.usagemonitor.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings as AndroidSettings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import io.github.sbgitcs.usagemonitor.BuildConfig
import io.github.sbgitcs.usagemonitor.data.PairedComputer
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.net.DataUsage
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.service.SpeedService
import io.github.sbgitcs.usagemonitor.update.Updater
import io.github.sbgitcs.usagemonitor.widget.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt
import kotlin.math.roundToLong

@Composable
fun SettingsScreen(settings: Settings, computer: PairedComputer?, resumes: Int, onPair: () -> Unit, onForget: () -> Unit) {
    val context = LocalContext.current
    val notificationsAllowed = remember(resumes) {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }
    var notificationsNow by remember(resumes) { mutableStateOf(notificationsAllowed) }
    var speedOn by remember { mutableStateOf(settings.speedNotification) }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notificationsNow = granted
        if (granted && speedOn) SpeedService.sync(context)
    }
    fun setSpeed(on: Boolean) {
        speedOn = on
        settings.speedNotification = on
        runCatching { SpeedService.sync(context) }
        if (on && !notificationsNow && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    ScreenList {
        item { ComputerSection(settings, computer, onPair, onForget) }
        item {
            Section("Status bar") {
                SwitchRow(
                    "Show network speed",
                    "Download and upload speed in the status bar, updated every second. It also keeps the widgets fresh. The Network speed tile in Quick Settings switches it too.",
                    speedOn,
                ) { setSpeed(it) }
            }
        }
        item { DataPlanSection(settings) }
        item { AlertSection(settings) }
        item { UpdateSection(settings, resumes) }
        item {
            Section("Permissions") {
                PermissionRow("Notifications", "Alerts, updates and the status bar speed", notificationsNow) {
                    // Android shows its own prompt once; after that, only its settings page can turn them on.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !settings.askedNotifications) {
                        settings.askedNotifications = true
                        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        openFirst(context, Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(AndroidSettings.EXTRA_APP_PACKAGE, context.packageName))
                    }
                }
                PermissionRow("Usage access", "Mobile and Wi-Fi data per app", remember(resumes) { DataUsage.hasAccess(context) }) {
                    openFirst(
                        context,
                        Intent(AndroidSettings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:${context.packageName}")),
                        Intent(AndroidSettings.ACTION_USAGE_ACCESS_SETTINGS),
                    )
                }
                PermissionRow("Install updates", "Lets Usage Monitor update itself", remember(resumes) { context.packageManager.canRequestPackageInstalls() }) {
                    openFirst(context, Intent(AndroidSettings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
                }
            }
        }
    }
}

@Composable
private fun ComputerSection(settings: Settings, computer: PairedComputer?, onPair: () -> Unit, onForget: () -> Unit) {
    var confirm by remember { mutableStateOf(false) }
    Section("Computer") {
        if (computer == null) {
            Note("Not paired. Pair with Usage Monitor on your computer to see its plan meters here and in the widget.")
            Spacer(Modifier.height(12.dp))
            Button(onClick = onPair) { Text("Pair") }
            return@Section
        }
        Text(computer.name, style = MaterialTheme.typography.bodyLarge)
        Note("${computer.addresses.joinToString(", ")} · port ${computer.port}")
        val readAt = settings.snapshotAt
        if (readAt > 0) Note("Last reading ${Format.ago(readAt, System.currentTimeMillis())}")
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onPair) { Text("Pair again") }
            TextButton(onClick = { confirm = true }) { Text("Forget") }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Forget ${computer?.name ?: "the computer"}?") },
            text = { Text("This phone stops reading its plan meters. To remove the phone on the computer as well, use Settings › Phone there.") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    onForget()
                }) { Text("Forget") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun DataPlanSection(settings: Settings) {
    val context = LocalContext.current
    var warn by remember { mutableFloatStateOf(settings.capWarnPct.toFloat()) }
    Section("Mobile data plan") {
        Note("Caps count mobile data only. Leave a cap empty for none.")
        Spacer(Modifier.height(8.dp))
        ValidatedField(
            label = "Billing cycle starts on day",
            initial = settings.billingDay.toString(),
            keyboard = KeyboardType.Number,
        ) { text ->
            val day = text.trim().toIntOrNull()?.takeIf { it in 1..31 } ?: return@ValidatedField false
            settings.billingDay = day
            true
        }
        ValidatedField(
            label = "Monthly cap",
            initial = capText(settings.monthlyCapMb),
            keyboard = KeyboardType.Decimal,
            suffix = "GB",
        ) { text ->
            val mb = parseCapMb(text) ?: return@ValidatedField false
            settings.monthlyCapMb = mb
            Widgets.refresh(context)
            true
        }
        ValidatedField(
            label = "Daily cap",
            initial = capText(settings.dailyCapMb),
            keyboard = KeyboardType.Decimal,
            suffix = "GB",
        ) { text ->
            val mb = parseCapMb(text) ?: return@ValidatedField false
            settings.dailyCapMb = mb
            Widgets.refresh(context)
            true
        }
        Spacer(Modifier.height(8.dp))
        Text("Warn at ${warn.roundToInt()}% of a cap", style = MaterialTheme.typography.bodyLarge)
        Slider(
            value = warn,
            onValueChange = { warn = it },
            onValueChangeFinished = { settings.capWarnPct = warn.roundToInt() },
            valueRange = 50f..95f,
            steps = 8,
        )
    }
}

@Composable
private fun AlertSection(settings: Settings) {
    var plan by remember { mutableStateOf(settings.planAlerts) }
    var forecast by remember { mutableStateOf(settings.forecastAlerts) }
    var quiet by remember { mutableStateOf(settings.quietEnabled) }
    Section("Alerts") {
        SwitchRow("Plan alerts", "When a plan window on the computer passes the desktop's warning level or runs out", plan) {
            plan = it
            settings.planAlerts = it
        }
        SwitchRow("Forecast alerts", "When a window is on course to run out before it resets", forecast) {
            forecast = it
            settings.forecastAlerts = it
        }
        SwitchRow("Quiet hours", "Alerts are kept silent during these hours", quiet) {
            quiet = it
            settings.quietEnabled = it
        }
        if (quiet) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    ValidatedField("From", settings.quietStart, KeyboardType.Text) { text ->
                        val t = Settings.normalizeTime(text) ?: return@ValidatedField false
                        settings.quietStart = t
                        true
                    }
                }
                Column(Modifier.weight(1f)) {
                    ValidatedField("To", settings.quietEnd, KeyboardType.Text) { text ->
                        val t = Settings.normalizeTime(text) ?: return@ValidatedField false
                        settings.quietEnd = t
                        true
                    }
                }
            }
            Note("24-hour times, like 22:00 and 07:00.")
        }
        Spacer(Modifier.height(4.dp))
        Note("Checked every 15 minutes in the background.")
    }
}

@Composable
private fun UpdateSection(settings: Settings, resumes: Int) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var auto by remember { mutableStateOf(settings.autoUpdate) }
    var channel by remember { mutableStateOf(settings.updateChannel) }
    var checking by remember { mutableStateOf(false) }
    var status by remember(resumes) { mutableStateOf(settings.updateStatus) }
    Section("Updates") {
        Note("Version ${BuildConfig.VERSION_NAME}")
        SwitchRow("Install updates automatically", "Checks GitHub when the app opens and every 6 hours, like the desktop app", auto) {
            auto = it
            settings.autoUpdate = it
        }
        Text("Channel", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp))
        for ((value, label) in listOf("stable" to "Stable releases", "beta" to "Beta releases too")) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().clickable {
                    channel = value
                    settings.updateChannel = value
                },
            ) {
                RadioButton(selected = channel == value, onClick = {
                    channel = value
                    settings.updateChannel = value
                })
                Text(label)
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(enabled = !checking, onClick = {
                checking = true
                scope.launch {
                    withContext(Dispatchers.IO) { Updater.check(context, settings, interactive = true) }
                    status = settings.updateStatus
                    checking = false
                }
            }) { Text("Check now") }
            if (checking) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
        }
        status?.let {
            Spacer(Modifier.height(4.dp))
            Note(it)
        }
    }
}

@Composable
private fun PermissionRow(title: String, detail: String, granted: Boolean, onAllow: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Note(detail)
        }
        if (granted) Text("Allowed", color = MaterialTheme.colorScheme.primary) else OutlinedButton(onClick = onAllow) { Text("Allow") }
    }
}

/** A text field that saves as soon as its text is valid, and marks it when it is not. */
@Composable
private fun ValidatedField(label: String, initial: String, keyboard: KeyboardType, suffix: String? = null, save: (String) -> Boolean) {
    var text by remember { mutableStateOf(initial) }
    var bad by remember { mutableStateOf(false) }
    val suffixText: (@Composable () -> Unit)? = suffix?.let { s -> @Composable { Text(s) } }
    OutlinedTextField(
        value = text,
        onValueChange = {
            text = it
            bad = !save(it)
        },
        label = { Text(label) },
        suffix = suffixText,
        isError = bad,
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    )
}

private fun capText(mb: Long): String = if (mb <= 0) "" else Format.gigabytes(mb * 1024 * 1024)

/** "" means no cap; otherwise gigabytes, like "1.5" or "50". */
private fun parseCapMb(text: String): Long? {
    val t = text.trim().replace(',', '.')
    if (t.isEmpty()) return 0
    val gb = t.toDoubleOrNull() ?: return null
    if (gb < 0 || gb > 100_000) return null
    return (gb * 1024).roundToLong()
}
