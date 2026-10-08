package io.github.sbgitcs.usagemonitor.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

/** A scrolling screen of cards. */
@Composable
fun ScreenList(content: LazyListScope.() -> Unit) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

@Composable
fun Section(title: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
        Column(Modifier.padding(10.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                action?.invoke()
            }
            Spacer(Modifier.height(4.dp))
            content()
        }
    }
}

/** A labelled bar, like one row of the desktop flyout. */
@Composable
fun Meter(label: String, value: String, pct: Double?, color: Color, detail: String? = null) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        }
        if (pct != null) {
            Spacer(Modifier.height(4.dp))
            LinearProgressIndicator(
                progress = { (pct / 100).toFloat().coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().height(4.dp),
                color = color,
                trackColor = MaterialTheme.colorScheme.surfaceVariant,
                gapSize = 0.dp,
                drawStopIndicator = {},
            )
        }
        if (detail != null) {
            Spacer(Modifier.height(2.dp))
            Note(detail)
        }
    }
}

@Composable
fun Figure(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Note(label)
        Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun Note(text: String, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = color)
}

@Composable
fun SwitchRow(title: String, detail: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled) { onChange(!checked) }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 8.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (detail != null) Note(detail)
        }
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

/** Compact dialog content; long text scrolls and action buttons wrap when needed. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun CompactDialog(onDismissRequest: () -> Unit, title: @Composable () -> Unit, text: @Composable () -> Unit,
                  confirmButton: @Composable () -> Unit, dismissButton: @Composable () -> Unit) {
    BasicAlertDialog(onDismissRequest = onDismissRequest) {
        Surface(shape = MaterialTheme.shapes.extraLarge, tonalElevation = 6.dp) {
            Column(Modifier.padding(16.dp)) {
                ProvideTextStyle(MaterialTheme.typography.titleLarge) { title() }
                Spacer(Modifier.height(8.dp))
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                    ProvideTextStyle(MaterialTheme.typography.bodyMedium) { text() }
                }
                Spacer(Modifier.height(8.dp))
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)) {
                    dismissButton()
                    confirmButton()
                }
            }
        }
    }
}

/** Runs [block] every [periodMs] while the app is on screen, and again whenever [key] changes. */
@Composable
fun WhileVisible(key: Any?, periodMs: Long, block: suspend () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val current by rememberUpdatedState(block)
    LaunchedEffect(key, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                current()
                delay(periodMs)
            }
        }
    }
}

/** Opens a system settings screen, trying each intent until one exists on this phone. */
fun openFirst(context: Context, vararg intents: Intent): Boolean {
    for (intent in intents) {
        try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return true
        } catch (e: ActivityNotFoundException) {
            // Try the next one.
        } catch (e: SecurityException) {
            // Some vendors guard the app-specific pages; try the next one.
        }
    }
    return false
}
