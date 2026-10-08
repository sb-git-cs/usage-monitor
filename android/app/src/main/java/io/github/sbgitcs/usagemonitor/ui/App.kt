package io.github.sbgitcs.usagemonitor.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import io.github.sbgitcs.usagemonitor.R
import io.github.sbgitcs.usagemonitor.data.Settings
import io.github.sbgitcs.usagemonitor.direct.PlanReadings
import io.github.sbgitcs.usagemonitor.pairing.PairingInfo
import kotlinx.coroutines.launch

enum class Tab(val label: String, val title: String) {
    Plans("Home", "Usage Monitor"),
    Data("Data", "Data usage"),
    Phone("Phone", "This phone"),
    Accounts("Accounts", "Accounts"),
    Settings("Settings", "Settings"),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun App(settings: Settings, incoming: PairingInfo?, onIncomingHandled: () -> Unit,
        requestedTab: Tab? = null, onNavigationHandled: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by rememberSaveable { mutableStateOf(Tab.Plans) }
    var pairing by rememberSaveable { mutableStateOf(false) }
    var computer by remember { mutableStateOf(settings.computer) }
    val navigationHeight = if (LocalDensity.current.fontScale > 1.15f) 72.dp else 64.dp
    // Bumped on every return to the app, so permission states are read again.
    var resumes by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { resumes++ }
    LaunchedEffect(requestedTab) {
        requestedTab?.let {
            tab = it
            pairing = false
            onNavigationHandled()
        }
    }

    if (pairing || incoming != null) {
        PairScreen(
            settings = settings,
            incoming = incoming,
            onPaired = {
                computer = it
                pairing = false
                tab = Tab.Plans
                onIncomingHandled()
            },
            onCancel = {
                pairing = false
                onIncomingHandled()
            },
        )
        return
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text(tab.title, style = MaterialTheme.typography.titleLarge) }, expandedHeight = 52.dp) },
        bottomBar = {
            NavigationBar(
                modifier = Modifier.windowInsetsPadding(NavigationBarDefaults.windowInsets).height(navigationHeight),
                windowInsets = WindowInsets(0, 0, 0, 0),
                containerColor = MaterialTheme.colorScheme.surface,
            ) {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = {
                            when (t) {
                                Tab.Plans -> Icon(Icons.Filled.Home, contentDescription = null)
                                Tab.Data -> Icon(painterResource(R.drawable.ic_speed), contentDescription = null)
                                Tab.Phone -> Icon(Icons.Filled.Phone, contentDescription = null)
                                Tab.Settings -> Icon(Icons.Filled.Settings, contentDescription = null)
                                Tab.Accounts -> Icon(Icons.Filled.AccountCircle, contentDescription = null)
                            }
                        },
                        label = { Text(t.label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                Tab.Plans -> PlansScreen(settings, computer, onPair = { pairing = true }, onAccounts = { tab = Tab.Accounts })
                Tab.Data -> DataScreen(settings, resumes)
                Tab.Phone -> DeviceScreen()
                Tab.Accounts -> AccountsScreen(settings, computer, onPair = { pairing = true })
                Tab.Settings -> SettingsScreen(
                    settings = settings,
                    computer = computer,
                    resumes = resumes,
                    onPair = { pairing = true },
                    onForget = {
                        scope.launch {
                            PlanReadings.dropLinked(context, settings)
                            settings.forgetComputer()
                            computer = null
                            io.github.sbgitcs.usagemonitor.widget.Widgets.refresh(context)
                        }
                    },
                )
            }
        }
    }
}
