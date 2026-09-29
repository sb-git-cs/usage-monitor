package io.github.sbgitcs.usagemonitor.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

/** Follows the system's light or dark mode and, from Android 12, the wallpaper colours. */
@Composable
fun UsageMonitorTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val scheme = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        dark -> darkColorScheme(primary = Color(0xFF93C5FD), secondary = Color(0xFF86EFAC))
        else -> lightColorScheme(primary = Color(0xFF2563EB), secondary = Color(0xFF16A34A))
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

/** The desktop's meter colours: normal, past the warning point, full. */
object StatusColors {
    val warn = Color(0xFFF59E0B)
    val full = Color(0xFFEF4444)
}

@Composable
fun meterColor(pct: Double, warnAt: Double): Color = when {
    pct >= 100 -> StatusColors.full
    pct >= warnAt -> StatusColors.warn
    else -> MaterialTheme.colorScheme.primary
}
