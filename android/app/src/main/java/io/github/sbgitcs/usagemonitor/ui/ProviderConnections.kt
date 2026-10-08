package io.github.sbgitcs.usagemonitor.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.sbgitcs.usagemonitor.data.PairedComputer
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.direct.PhoneSignIn
import io.github.sbgitcs.usagemonitor.direct.PlanReadings
import io.github.sbgitcs.usagemonitor.direct.TokenVault
import io.github.sbgitcs.usagemonitor.model.MeterConnection
import io.github.sbgitcs.usagemonitor.net.Format
import io.github.sbgitcs.usagemonitor.widget.Widgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Where each meter reads from, the computer link, and signing in on this phone. */
@Composable
fun AccountsScreen(settings: Settings, computer: PairedComputer?, onPair: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Bumped after any change, so the rows read the vault and the meters again.
    var version by remember { mutableIntStateOf(0) }
    var providers by remember { mutableStateOf(PlanReadings.read(settings).snapshot?.providers.orEmpty()) }
    var phoneSignIns by remember { mutableStateOf(emptySet<String>()) }
    var linked by remember { mutableStateOf(emptyMap<String, Long?>()) }
    var signingOut by remember { mutableStateOf<String?>(null) }
    val step by PhoneSignIn.step.collectAsState()

    fun reload() {
        scope.launch {
            val all = withContext(Dispatchers.IO) { TokenVault(context).all() }
            phoneSignIns = all.filter { it.origin == TokenVault.PHONE }.map { it.provider }.toSet()
            linked = all.filter { it.origin == TokenVault.LINKED }.associate { it.provider to it.expiresAt }
            providers = PlanReadings.read(settings).snapshot?.providers.orEmpty()
        }
    }
    WhileVisible(version, 5_000) { reload() }
    LaunchedEffect(step?.done) {
        if (step?.done == true) {
            version++
        }
    }

    ScreenList {
        item { LinkCard(settings, computer, linked, onPair) { version++ } }
        item {
            Section("Usage accounts") {
                Note("Sign in on this phone to read a tool without the computer. Sign-ins stay encrypted on this phone and are used only to read usage.")
                PlanReadings.MOBILE.forEachIndexed { i, id ->
                    if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    AccountRow(
                        name = PlanReadings.NAMES.getValue(id),
                        meter = providers.firstOrNull { it.id == id },
                        signedInHere = id in phoneSignIns,
                        canSignIn = id in PhoneSignIn.providers,
                        onSignIn = { PhoneSignIn.start(context, id) },
                        onSignOut = { signingOut = id },
                    )
                }
            }
        }
    }

    step?.let { s -> SignInDialog(s) }
    signingOut?.let { id ->
        val name = PlanReadings.NAMES.getValue(id)
        CompactDialog(onDismissRequest = { signingOut = null },
            title = { Text("Sign out of $name?") },
            text = { Text("This phone forgets its $name sign-in. The computer's sign-in is not affected.") },
            confirmButton = {
                TextButton(onClick = {
                    signingOut = null
                    scope.launch {
                        withContext(Dispatchers.IO) { PlanReadings.signOut(context, settings, id) }
                        Widgets.refresh(context)
                        version++
                    }
                }) { Text("Sign out") }
            },
            dismissButton = { TextButton(onClick = { signingOut = null }) { Text("Cancel") } })
    }
}

/** Direct reading with the computer's sign-ins: off, waiting for approval, or on. */
@Composable
private fun LinkCard(settings: Settings, computer: PairedComputer?, linked: Map<String, Long?>, onPair: () -> Unit, onChange: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(settings.directLink) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            runCatching { block() }.onFailure { error = it.message }
            state = settings.directLink
            busy = false
            onChange()
        }
    }
    // Picks up an approval made on the computer while this screen is open.
    WhileVisible(state, 5_000) {
        if (state == "asked") {
            PlanReadings.checkLink(context, settings)
            if (settings.directLink != state) {
                state = settings.directLink
                onChange()
            }
        }
    }
    Section("Computer link", action = { if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }) {
        when {
            computer == null -> {
                Note("Pair with Usage Monitor on your computer to use its sign-ins here.")
                Spacer(Modifier.height(6.dp))
                Button(onClick = onPair) { Text("Pair") }
            }
            state == "on" -> {
                val now = System.currentTimeMillis()
                val live = linked.filterValues { it == null || it > now }
                Note(if (live.isEmpty()) "Linked with ${computer.name}. No current sign-ins yet; they arrive with the next reading."
                    else "Reads ${live.keys.joinToString { PlanReadings.NAMES[it] ?: it }} directly when ${computer.name} is away.")
                if (settings.tokensAt > 0) Note("Sign-ins updated ${Format.ago(settings.tokensAt, now)}")
                TextButton(enabled = !busy, onClick = { run { PlanReadings.stopLink(context, settings) } }) { Text("Stop direct reading") }
            }
            state == "asked" -> {
                Note("Approve on ${computer.name}. This updates on its own.")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(enabled = !busy, onClick = { run { PlanReadings.requestLink(context, settings) } }) { Text("Ask again") }
                    TextButton(enabled = !busy, onClick = { run { PlanReadings.stopLink(context, settings) } }) { Text("Cancel") }
                }
            }
            else -> {
                Note("Keep meters current away from ${computer.name}: the phone reads usage directly with its sign-ins until each expires (Claude about 8 hours, Gemini 1 hour, others days).")
                Spacer(Modifier.height(6.dp))
                Button(enabled = !busy, onClick = { run { PlanReadings.requestLink(context, settings) } }) { Text("Link sign-ins") }
            }
        }
        error?.let { Note(it, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun AccountRow(name: String, meter: io.github.sbgitcs.usagemonitor.model.Provider?, signedInHere: Boolean, canSignIn: Boolean,
                       onSignIn: () -> Unit, onSignOut: () -> Unit) {
    val connection = MeterConnection.from(meter)
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 6.dp)) {
            Text(name, style = MaterialTheme.typography.titleSmall)
            val who = meter?.account?.takeIf { it.isNotBlank() }
            Text(listOfNotNull(if (signedInHere) "Phone" else connection.source, connection.signInLabel, who).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            meter?.hint?.takeIf { meter.state != "ok" }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        when {
            signedInHere -> Row {
                if (canSignIn && meter?.state != "ok") TextButton(onClick = onSignIn) { Text("Retry sign-in") }
                TextButton(onClick = onSignOut) { Text("Sign out") }
            }
            canSignIn -> OutlinedButton(onClick = onSignIn) { Text("Sign in") }
            else -> Note("Via computer")
        }
    }
}

@Composable
private fun SignInDialog(step: io.github.sbgitcs.usagemonitor.direct.SignInStep) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val name = PlanReadings.NAMES[step.provider] ?: step.provider
    var pasted by remember(step.url) { mutableStateOf("") }
    var opened by remember(step.url) { mutableStateOf(false) }
    // Pages without a code to read first open straight away.
    LaunchedEffect(step.url) {
        if (step.url != null && step.code == null && !step.busy && !opened) {
            opened = true
            openPage(context, step.url)
        }
    }
    CompactDialog(onDismissRequest = {},
        title = { Text(if (step.done && step.notice != null) "$name sign-in saved" else if (step.done) "$name connected" else "Sign in to $name") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                when {
                    step.done -> Text(step.notice ?: "This phone now reads $name usage directly.")
                    step.error != null -> Text(step.error, color = MaterialTheme.colorScheme.error)
                    step.busy -> Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text("  Connecting and checking usage…")
                    }
                    step.url == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text("  Starting…")
                    }
                    step.needsPaste -> {
                        Text("Approve in the browser, copy the code it shows, then paste it here.")
                        OutlinedTextField(value = pasted, onValueChange = { pasted = it }, singleLine = true,
                            label = { Text("Code") }, modifier = Modifier.fillMaxWidth())
                    }
                    step.code != null -> {
                        Text("Open the page and enter this code:")
                        SelectionContainer {
                            Text(step.code, style = MaterialTheme.typography.headlineSmall, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
                        }
                        if (step.provider == "codex") Note("If the page refuses it, turn on device code sign-in in ChatGPT's security settings.")
                        Waiting()
                    }
                    else -> {
                        Text("Approve the sign-in in the browser, then come back.")
                        Waiting()
                    }
                }
            }
        },
        confirmButton = {
            when {
                step.done -> TextButton(onClick = { PhoneSignIn.cancel() }) { Text("Done") }
                step.error != null -> TextButton(onClick = { PhoneSignIn.start(context, step.provider) }) { Text("Try again") }
                step.busy -> {}
                step.needsPaste -> TextButton(enabled = pasted.isNotBlank(), onClick = { PhoneSignIn.paste(pasted) }) { Text("Connect") }
                step.url != null -> TextButton(onClick = {
                    step.code?.let { clipboard.setText(AnnotatedString(it)) }
                    openPage(context, step.url)
                }) { Text(if (step.code != null) "Copy code & open" else "Open page") }
                else -> {}
            }
        },
        dismissButton = {
            if (!step.done) TextButton(onClick = { PhoneSignIn.cancel() }) { Text("Cancel") }
            if (step.needsPaste && step.url != null) TextButton(onClick = { openPage(context, step.url) }) { Text("Open page") }
        })
}

@Composable
private fun Waiting() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        Note("  Waiting for approval…")
    }
}

private fun openPage(context: Context, url: String) {
    openFirst(context, Intent(Intent.ACTION_VIEW, Uri.parse(url)))
}
