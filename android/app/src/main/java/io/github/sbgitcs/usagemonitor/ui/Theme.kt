package io.github.sbgitcs.usagemonitor.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val lightColors = lightColorScheme(
    primary = Color(0xFF2563EB), onPrimary = Color.White,
    primaryContainer = Color(0xFFDBEAFE), onPrimaryContainer = Color(0xFF1E3A8A),
    secondary = Color(0xFF475569), secondaryContainer = Color(0xFFE8EEF6),
    onSecondaryContainer = Color(0xFF334155),
    tertiary = Color(0xFF0F766E), tertiaryContainer = Color(0xFFCCFBF1),
    onTertiaryContainer = Color(0xFF115E59),
    background = Color(0xFFF5F7FB), onBackground = Color(0xFF0F172A),
    surface = Color.White, onSurface = Color(0xFF0F172A),
    surfaceVariant = Color(0xFFE8EEF6), onSurfaceVariant = Color(0xFF526176),
    surfaceContainer = Color(0xFFF0F4FA), surfaceContainerLow = Color.White,
    outline = Color(0xFF94A3B8), outlineVariant = Color(0xFFDFE6EF),
)
private val darkColors = darkColorScheme(
    primary = Color(0xFF93C5FD), onPrimary = Color(0xFF102F61),
    primaryContainer = Color(0xFF1E3A5F), onPrimaryContainer = Color(0xFFDBEAFE),
    secondary = Color(0xFFCBD5E1), secondaryContainer = Color(0xFF26354B),
    onSecondaryContainer = Color(0xFFE2E8F0),
    tertiary = Color(0xFF5EEAD4), tertiaryContainer = Color(0xFF134E4A),
    onTertiaryContainer = Color(0xFFCCFBF1),
    background = Color(0xFF0B1220), onBackground = Color(0xFFE2E8F0),
    surface = Color(0xFF131E30), onSurface = Color(0xFFE2E8F0),
    surfaceVariant = Color(0xFF26354B), onSurfaceVariant = Color(0xFFADBBD0),
    surfaceContainer = Color(0xFF172338), surfaceContainerLow = Color(0xFF131E30),
    outline = Color(0xFF667892), outlineVariant = Color(0xFF2D3D54),
)
private val baseType = Typography()
private val appType = Typography(
    titleLarge = baseType.titleLarge.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = baseType.titleMedium.copy(fontWeight = FontWeight.SemiBold),
    titleSmall = baseType.titleSmall.copy(fontWeight = FontWeight.SemiBold),
)

/** A consistent palette in both system light and dark mode. */
@Composable
fun UsageMonitorTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) darkColors else lightColors,
        typography = appType,
        shapes = Shapes(small = RoundedCornerShape(8.dp), medium = RoundedCornerShape(12.dp),
            large = RoundedCornerShape(16.dp), extraLarge = RoundedCornerShape(20.dp)),
        content = content,
    )
}

/** The desktop's meter colours: normal, past the warning point, full. */
object StatusColors {
    val warn = Color(0xFFB66A06)
    val full = Color(0xFFEF4444)
}

@Composable
fun meterColor(pct: Double, warnAt: Double): Color = when {
    pct >= 100 -> StatusColors.full
    pct >= warnAt -> StatusColors.warn
    else -> MaterialTheme.colorScheme.primary
}
