package io.github.sbgitcs.usagemonitor.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import io.github.sbgitcs.usagemonitor.data.PairedComputer
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.direct.PlanReadings
import io.github.sbgitcs.usagemonitor.pairing.DesktopClient
import io.github.sbgitcs.usagemonitor.pairing.NotPairedException
import io.github.sbgitcs.usagemonitor.pairing.PairingInfo
import io.github.sbgitcs.usagemonitor.pairing.PairingLink
import io.github.sbgitcs.usagemonitor.widget.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Pairs with Usage Monitor on the computer: scan its QR code, type its address and code, or
 * confirm a pairing link opened from the camera app.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairScreen(settings: Settings, incoming: PairingInfo?, onPaired: (PairedComputer) -> Unit, onCancel: () -> Unit) {
    BackHandler(onBack = onCancel)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var mode by rememberSaveable { mutableIntStateOf(0) }

    fun pair(info: PairingInfo) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val client = DesktopClient(settings)
                    val computer = client.pair(info)
                    // Readings and sign-ins from a computer paired before must not carry over to the new one.
                    settings.snapshotJson = null
                    settings.snapshotAt = 0
                    PlanReadings.dropLinked(context, settings)
                    runCatching { client.refresh() }
                    computer
                }
            }
            busy = false
            result.onSuccess {
                Widgets.refresh(context)
                onPaired(it)
            }.onFailure {
                error = if (it is NotPairedException) {
                    "The computer did not accept the code. Codes last 10 minutes; turn pairing on again on the computer for a new one."
                } else {
                    it.message ?: "Pairing did not work."
                }
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pair computer", style = MaterialTheme.typography.titleLarge) },
                expandedHeight = 52.dp,
                navigationIcon = {
                    IconButton(onClick = onCancel) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (incoming != null) {
                Text("Pair with ${incoming.name}?", style = MaterialTheme.typography.titleMedium)
                Note("Usage Monitor on ${incoming.name} (${incoming.addresses.joinToString(", ")}) will share its plan meters and system readings with this phone.")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Button(enabled = !busy, onClick = { pair(incoming) }) { Text("Pair") }
                    TextButton(onClick = onCancel) { Text("Cancel") }
                }
            } else {
                Note("On the computer, click Pair on the Usage Monitor flyout, or Pair a phone in Settings. A QR code and a code appear immediately and work for 10 minutes. The phone must be on the same network as the computer. Scan the QR code, or type the address and code.")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(selected = mode == 0, onClick = { mode = 0 }, label = { Text("Scan the QR code") })
                    FilterChip(selected = mode == 1, onClick = { mode = 1 }, label = { Text("Type the code") })
                }
                if (mode == 0) {
                    ScanPane(busy, onLink = { pair(it) }, onError = { error = it })
                } else {
                    ManualPane(busy) { pair(it) }
                }
            }
            if (busy) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(6.dp))
                    Text("Pairing…")
                }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
private fun ScanPane(busy: Boolean, onLink: (PairingInfo) -> Unit, onError: (String) -> Unit) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var denied by remember { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        denied = !ok
    }
    LaunchedEffect(Unit) {
        if (!granted) ask.launch(Manifest.permission.CAMERA)
    }
    if (!granted) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Note(if (denied) "Camera access is off. Allow it, or type the code instead." else "The camera reads the QR code on the computer's screen.")
            Button(onClick = { ask.launch(Manifest.permission.CAMERA) }) { Text("Allow camera") }
        }
        return
    }
    // The same code stays in view for a while; try it once every few seconds, not every frame.
    var last by remember { mutableStateOf("") }
    var lastAt by remember { mutableLongStateOf(0L) }
    QrScanner(
        modifier = Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(16.dp)),
        onText = { text ->
            val now = SystemClock.elapsedRealtime()
            if (busy || (text == last && now - lastAt < 5000)) return@QrScanner
            last = text
            lastAt = now
            val info = PairingLink.parse(text)
            if (info == null) onError("That QR code is not a Usage Monitor pairing code.") else onLink(info)
        },
        onError = onError,
    )
}

@Composable
private fun ManualPane(busy: Boolean, onSubmit: (PairingInfo) -> Unit) {
    var address by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var bad by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
            value = address,
            onValueChange = {
                address = it
                bad = false
            },
            label = { Text("Computer's address") },
            placeholder = { Text("192.168.1.20") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = code,
            onValueChange = {
                code = it.uppercase()
                bad = false
            },
            label = { Text("Pairing code") },
            placeholder = { Text("ABCDE-FGHJK-MNPQR-STVWX") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
            modifier = Modifier.fillMaxWidth(),
        )
        if (bad) Note("Check the address (like 192.168.1.20) and the 20-character code.", color = MaterialTheme.colorScheme.error)
        Button(enabled = !busy, onClick = {
            val info = PairingLink.manual(address, code)
            if (info == null) bad = true else onSubmit(info)
        }) { Text("Pair") }
    }
}
