package dev.herdr.remote

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.os.Bundle
import android.os.Build
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.WrapText
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private fun notificationEnableAction(context: Context, deniedPreviously: Boolean): NotificationEnableAction =
    notificationEnableAction(
        sdkInt = Build.VERSION.SDK_INT,
        runtimePermissionGranted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED,
        notificationsEnabled = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled(),
        deniedPreviously = deniedPreviously,
    )

class MainActivity: ComponentActivity() {
    private var notificationPane by mutableStateOf<String?>(null)
    private var notificationDeviceId by mutableStateOf<String?>(null)
    private var notificationLocalDeviceId by mutableStateOf<String?>(null)
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        notificationPane = intent.getStringExtra(ReplyNotifications.EXTRA_PANE_ID)
        notificationDeviceId = intent.getStringExtra(CloudPush.EXTRA_DEVICE_ID)
        notificationLocalDeviceId = intent.getStringExtra(ReplyNotifications.EXTRA_LOCAL_DEVICE_ID)
        intent.removeExtra(ReplyNotifications.EXTRA_LOCAL_DEVICE_ID)
        intent.removeExtra(CloudPush.EXTRA_DEVICE_ID)
        intent.removeExtra(ReplyNotifications.EXTRA_PANE_ID)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (StartupCrashReport.pending(this)) {
            startActivity(Intent(this, RecoveryActivity::class.java))
            finish()
            return
        }
        enableEdgeToEdge()
        notificationPane = intent.getStringExtra(ReplyNotifications.EXTRA_PANE_ID)
        notificationDeviceId = intent.getStringExtra(CloudPush.EXTRA_DEVICE_ID)
        notificationLocalDeviceId = intent.getStringExtra(ReplyNotifications.EXTRA_LOCAL_DEVICE_ID)
        intent.removeExtra(ReplyNotifications.EXTRA_LOCAL_DEVICE_ID)
        intent.removeExtra(CloudPush.EXTRA_DEVICE_ID)
        intent.removeExtra(ReplyNotifications.EXTRA_PANE_ID)
        setContent {
            val appearance = rememberThemePreference()
            val dark = isDarkTheme(appearance.mode, isSystemInDarkTheme())
            SideEffect {
                enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT) { dark },
                    navigationBarStyle = SystemBarStyle.auto(0xE6FFFFFF.toInt(), 0x801B1B1B.toInt()) { dark }
                )
            }
            HerdrTheme(appearance.mode, preference = appearance) {
                RemoteApp(themeMode = appearance.mode, onThemeChange = appearance::updateMode,
                    notificationPane = notificationPane, notificationDeviceId = notificationDeviceId, notificationLocalDeviceId = notificationLocalDeviceId,
                    onNotificationOpened = { notificationPane = null; notificationDeviceId = null; notificationLocalDeviceId = null })
            }
        }
    }
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun RemoteApp(model: RemoteModel = viewModel(), notificationPane: String? = null, notificationDeviceId: String? = null, notificationLocalDeviceId: String? = null, onNotificationOpened: () -> Unit = {}, themeMode: ThemeMode = ThemeMode.SYSTEM, onThemeChange: (ThemeMode) -> Unit = {}) {
    val state by model.state.collectAsStateWithLifecycle()
    var settings by rememberSaveable { mutableStateOf(false) }
    var appSettings by rememberSaveable { mutableStateOf(false) }
    var activity by rememberSaveable { mutableStateOf(false) }
    var updates by rememberSaveable { mutableStateOf(false) }
    var creating by rememberSaveable { mutableStateOf(false) }
    var notificationSettings by rememberSaveable { mutableStateOf(false) }
    var diagnostics by rememberSaveable { mutableStateOf(false) }
    var notificationDenied by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    val packageInfo = remember(context) { context.packageManager.getPackageInfo(context.packageName, 0) }
    var onboarding by rememberSaveable {
        mutableStateOf(shouldShowFirstRunGuide(firstRunGuideSeen(context), packageInfo.firstInstallTime,
            packageInfo.lastUpdateTime, notificationPane != null))
    }
    var requestCloudPermission by rememberSaveable { mutableStateOf(false) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notificationDenied = !granted
        if (granted) {
            if (requestCloudPermission) model.setCloudPushEnabled(true) else model.setReplyNotifications(true)
            requestCloudPermission = false
        }
    }
    LaunchedEffect(notificationPane, notificationDeviceId, notificationLocalDeviceId) {
        notificationPane?.let { appSettings = false; settings = false; updates = false; creating = false; notificationSettings = false; diagnostics = false; model.openNotificationPane(it, notificationDeviceId, notificationLocalDeviceId); onNotificationOpened() }
    }
    val snack = remember { SnackbarHostState() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) model.foreground(true)
            if (event == Lifecycle.Event.ON_STOP) model.foreground(false)
        }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) model.foreground(true)
        onDispose { lifecycle.removeObserver(observer); model.foreground(false) }
    }
    LaunchedEffect(state.message) { state.message?.let { snack.showSnackbar(it); model.clearMessage() } }
    LaunchedEffect(state.paired) { if (state.paired) settings = false }
    val destinationState = rememberSaveableStateHolder()
    // The intent covers the first composition; model state covers asynchronous routing.
    // Keep all dashboard content and chrome out of the composition until resolved.
    if (notificationPane != null || state.openingNotification) {
        val cancel = { model.cancelNotificationOpening(); model.dismissInitialConnectionLoading(); onNotificationOpened() }
        BackHandler(onBack = cancel)
        NotificationOpeningScreen(onCancel = cancel)
        return
    }
    if (state.loadingInitialConnection) {
        BackHandler(onBack = model::dismissInitialConnectionLoading)
        NotificationOpeningScreen(onCancel = model::dismissInitialConnectionLoading, openingConversation = false)
        return
    }
    if (onboarding) {
        BackHandler { markFirstRunGuideSeen(context); onboarding = false }
        FirstRunGuide(onDone = { markFirstRunGuideSeen(context); onboarding = false }, finalAction = if (appSettings) "Done" else "Connect my laptop")
        return
    }
    val sessionsContent: @Composable () -> Unit = {
        destinationState.SaveableStateProvider("sessions:${state.url}:${state.portalDeviceId}") {
            SessionsScreen(state, model::select, model::refresh, model::reconnect, model::startHerdr,
                { model.checkDelivery("__create__") }, onAcknowledgeCreate = { model.acknowledgeDelivery("__create__") })
        }
    }
    val pane = state.snapshot.panes.find { it.id == state.selectedId }
    val setup = !state.paired || settings || state.chooseDevice || (state.signInRequired && state.portalDeviceId != null)
    BackHandler(activity || appSettings || settings || state.selectedId != null) { when { activity -> activity = false; settings -> settings = false; appSettings -> appSettings = false; else -> model.select(null) } }
    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        topBar = { AppTopBar(
            title = when { activity -> "Activity"; settings -> "Connection"; appSettings -> "Settings"; setup -> "Herdr Remote"; state.selectedId != null -> pane?.title ?: "Conversation"; else -> "Herdr" },
            subtitle = if (!setup && !appSettings && state.selectedId != null) pane?.cwd?.trimEnd('/')?.substringAfterLast('/') else null,
            canBack = activity || settings || appSettings || state.selectedId != null,
            onBack = { when { activity -> activity = false; settings -> settings = false; appSettings -> appSettings = false; else -> model.select(null) } },
            actions = {
                if (!appSettings && !settings) {
                    if (!setup && state.selectedId != null) {
                        key(state.selectedId) {
                            AgentActions(enabled = !state.busy && state.online && state.snapshot.herdrOnline && !state.snapshot.stale && state.snapshot.canControl && pane != null && state.deliveries[pane.id]?.isUnresolved() != true,
                                onControl = model::control, currentTitle = pane?.title.orEmpty(), terminal = pane?.kind == "terminal",
                                canRename = state.snapshot.sessionRenameEnabled, canFocus = state.snapshot.desktopHandoffEnabled,
                                canStop = pane?.kind != "terminal" || state.snapshot.allowTerminalInput,
                                onRename = { title -> pane?.id?.let { model.renamePane(it, title) } },
                                onFocus = { pane?.id?.let(model::focusPane) })
                        }
                    }
                    else {
                        if (!setup && !activity) IconButton(onClick = { activity = true; model.loadActivity() }) { Icon(Icons.Default.History, "Laptop activity") }
                        IconButton(onClick = { activity = false; appSettings = true }) { Icon(Icons.Default.Settings, "Settings") }
                    }
                }
            }
        ) },
        bottomBar = {
            if (!setup && !appSettings && !activity && state.selectedId == null) NewAgentBar(
                enabled = state.online && state.snapshot.herdrOnline && !state.snapshot.stale && state.snapshot.canControl && !state.busy,
                onCreate = { creating = true }
            )
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).background(MaterialTheme.colorScheme.background)) {
            when {
                settings -> Setup(state, model, onDone = { settings = false; appSettings = false })
                appSettings -> SettingsScreen(state, themeMode, onThemeChange,
                    onConnection = { settings = true }, onNotifications = { notificationSettings = true },
                    onDiagnostics = { diagnostics = true; if (state.paired) model.loadDiagnostics() }, onUpdates = { updates = true },
                    onGettingStarted = { onboarding = true })
                setup -> Setup(state, model, onDone = { settings = false; appSettings = false })
                activity -> ActivityScreen(state.activity, state.activityLoading, state.activityError, state.online,
                    state.snapshot.panes.map { it.id }.toSet(), model::loadActivity, { activity = false; model.select(it) })
                state.selectedId != null -> AdaptiveSessionLayout(
                    sessions = sessionsContent,
                    conversation = {
                        // Keep the conversation's saveable scroll/search state while the
                        // detail pane is removed from the composition on phone navigation.
                        destinationState.SaveableStateProvider(
                            "conversation:${state.url}:${state.portalDeviceId}:${state.accountEmail}:${state.selectedId}"
                        ) { AgentDetail(state, pane, model) }
                    }
                )
                else -> sessionsContent()
            }
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
        }
    }
    val enableNotifications: (Boolean) -> Unit = { cloud ->
        when (notificationEnableAction(context, notificationDenied)) {
            NotificationEnableAction.ENABLE -> {
                if (cloud) model.setCloudPushEnabled(true)
                else { model.setReplyNotifications(true); notificationSettings = false }
            }
            NotificationEnableAction.REQUEST_PERMISSION -> if (Build.VERSION.SDK_INT >= 33) {
                requestCloudPermission = cloud
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            NotificationEnableAction.OPEN_SETTINGS -> {
                context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
            }
        }
    }
    if (notificationSettings) NotificationSettingsDialog(
        state = state, denied = notificationDenied,
        onCloudChange = { enabled ->
            if (enabled) enableNotifications(true) else model.setCloudPushEnabled(false)
        },
        onMonitoring = {
            if (state.notificationsEnabled) { model.setReplyNotifications(false); notificationSettings = false }
            else enableNotifications(false)
        },
        onDismiss = { notificationSettings = false },
    )
    if (diagnostics) DiagnosticsDialog(state, model, onDismiss = { diagnostics = false })
    if (updates) AppUpdateDialog(dismiss = { updates = false })
    if (creating) NewAgent(state, model) { creating = false }
}
@Composable internal fun NotificationOpeningScreen(onCancel: () -> Unit, openingConversation: Boolean = true) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Box(Modifier.size(88.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.fillMaxSize(), strokeWidth = 3.dp,
                    trackColor = MaterialTheme.colorScheme.surfaceContainerHighest)
                Icon(Icons.Default.ChatBubbleOutline, contentDescription = null,
                    modifier = Modifier.size(32.dp), tint = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.height(28.dp))
            Text(if (openingConversation) "Opening conversation…" else "Connecting…",
                style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Spacer(Modifier.height(8.dp))
            Text(if (openingConversation) "Connecting to your laptop" else "Getting your conversations ready",
                style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(24.dp))
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

@Composable private fun Setup(state: RemoteState, model: RemoteModel, onDone: () -> Unit) {
    var url by rememberSaveable(state.url) { mutableStateOf(state.url) }
    var email by rememberSaveable { mutableStateOf("") }
    // Codes stay in memory, never saved state or preferences.
    var code by remember { mutableStateOf("") }
    var emailCode by remember(state.emailLogin?.challengeId) { mutableStateOf("") }
    var manual by rememberSaveable { mutableStateOf(false) }
    var deletingAccount by remember { mutableStateOf(false) }
    var scanMessage by remember { mutableStateOf<String?>(null) }
    var cameraDenied by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    val context = LocalContext.current
    LaunchedEffect(state.emailLogin) { while (state.emailLogin != null) { now = System.currentTimeMillis() / 1000; kotlinx.coroutines.delay(1000) } }
    LaunchedEffect(state.accountEmail, state.signInRequired, state.paired) { model.refreshSavedLaptops() }
    LaunchedEffect(state.accountEmail, state.signInRequired) { if (state.accountEmail != null && !state.signInRequired) model.refreshDevices() }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        if (result.contents == null) scanMessage = "Scan cancelled. You can try again."
        else try { scanMessage = null; model.pairQr(PairingQr.parse(result.contents), onDone) }
        catch (e: Exception) { scanMessage = e.message ?: "This QR code is invalid. Generate a new one on your laptop." }
    }
    val launchScanner = {
        scanner.launch(ScanOptions().apply { setDesiredBarcodeFormats(ScanOptions.QR_CODE); setPrompt("Scan the QR on your laptop"); setBeepEnabled(false); setBarcodeImageEnabled(false); setOrientationLocked(false) })
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraDenied = !granted
        if (granted) launchScanner() else scanMessage = "Allow camera access in app settings to scan your laptop QR."
    }
    val scan = {
        scanMessage = null
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchScanner()
        else permission.launch(Manifest.permission.CAMERA)
    }
    BackHandler(state.emailLogin != null) { model.cancelSignIn() }
    Column(Modifier.fillMaxSize().wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = 640.dp).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(if (state.paired) "Laptop & account" else "Connect your laptop", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
        if (!state.paired && state.savedLaptops.isEmpty()) PcSetupInstructions(onOpenSetup = { openWebLink(context, it) })
        else Text("Install Herdr Remote on your laptop once, then scan its QR. Your agents keep running on your laptop.", style = MaterialTheme.typography.bodyLarge)
        Button(onClick = scan, enabled = !state.busy && !state.signingIn, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
            Icon(Icons.Default.QrCodeScanner, null); Spacer(Modifier.width(8.dp)); Text("Scan laptop QR")
        }
        if (state.paired || state.savedLaptops.isNotEmpty()) (pcSetupUrl() ?: COMMUNITY_SETUP_URL).let { setupUrl ->
            TextButton(onClick = { openWebLink(context, setupUrl) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Set up another PC") }
        }
        scanMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (cameraDenied) TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:${context.packageName}".toUri())) }) { Text("Open camera settings") }
        if (state.savedLaptops.isNotEmpty()) {
            SavedLaptopsList(state.savedLaptops, !state.busy && !state.signingIn,
                { model.chooseSavedLaptop(it, onDone) }, model::renameSavedLaptop, model::forgetSavedLaptop, model::rotateSavedLaptopRouting)
        }
        if (Deployment.portalEnabled) {
        HorizontalDivider()
        if (state.accountEmail == null || state.signInRequired) {
            Text("Save your laptops with email", style = MaterialTheme.typography.titleLarge)
            Text("Email is optional for QR pairing. Sign in to find your laptops on this phone.", style = MaterialTheme.typography.bodyMedium)
            if (state.signInRequired) {
                Text("Sign in again to access your account. A fresh laptop QR can also create an independent pairing.", color = MaterialTheme.colorScheme.error)
                TextButton(onClick = model::signOut, enabled = !state.busy && !state.signingIn) { Text("Continue without email") }
            }
            val pending = state.emailLogin
            if (pending == null) {
                OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth(), enabled = !state.signingIn, label = { Text("Email address") }, singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Email))
                OutlinedButton(onClick = { model.startEmailSignIn(email) }, enabled = !state.signingIn && !state.busy && email.isNotBlank(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(if (state.signingIn) "Sending code…" else "Email me a code")
                }
            } else {
                Text("Enter the code sent to ${pending.email}")
                OutlinedTextField(emailCode, { emailCode = it.filter(Char::isDigit).take(6) }, Modifier.fillMaxWidth(), enabled = !state.signingIn,
                    label = { Text("Six-digit code") }, singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.NumberPassword),
                    supportingText = { Text(if (now >= pending.expiresAt) "Code expired. Request a new one." else "You can paste the code from your email.") })
                Button(onClick = { model.verifyEmailSignIn(emailCode) }, enabled = !state.signingIn && emailCode.length == 6 && now < pending.expiresAt, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (state.signingIn) "Verifying…" else "Sign in") }
                TextButton(onClick = { model.startEmailSignIn(pending.email) }, enabled = !state.signingIn && now >= pending.resendAt, modifier = Modifier.fillMaxWidth()) { Text(if (now < pending.resendAt) "Resend code in ${pending.resendAt - now}s" else "Resend code") }
                TextButton(onClick = { model.cancelSignIn() }, enabled = !state.signingIn, modifier = Modifier.fillMaxWidth()) { Text("Use another email") }
            }
            state.loginError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (state.signingIn) TextButton(onClick = model::cancelSignIn) { Text("Cancel") }
        } else {
            Text("${state.accountEmail}", style = MaterialTheme.typography.bodyMedium)
            Text("Your laptops", style = MaterialTheme.typography.titleLarge)
            if (state.devices.isEmpty()) {
                Text(if (state.busy) "Loading your laptops…" else "No laptops linked yet. Scan the QR on your laptop to add it to this account.")
            }
            state.devices.filterNot { device -> state.savedLaptops.any { it.laptopId == device.id } }.forEach { device ->
                val needsQr = device.transport == "relay" && device.id !in state.trustedLaptopIds
                OutlinedButton(onClick = { if (needsQr) scan() else model.chooseDevice(device.id, onDone) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                    Column(Modifier.fillMaxWidth()) { Text(device.label); Text(if (needsQr) "Scan QR to verify this laptop" else "Connect", style = MaterialTheme.typography.bodySmall) }
                }
            }
            TextButton(onClick = model::refreshDevices, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Refresh laptops") }
            TextButton(onClick = model::signOut, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Sign out") }
            TextButton(onClick = { deletingAccount = true }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Delete cloud account") }
        }
        if (state.accountDeletionUncertain) Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.errorContainer) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Cloud deletion status unknown", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onErrorContainer)
                Text("The request could not be confirmed or your sign-in expired. Saved phone data is still here. Check deletion through the public page; clearing this phone does not revoke laptop control.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer)
                TextButton(onClick = { openWebLink(context, "$PORTAL_ORIGIN/account/delete") }) { Text("Open account deletion page") }
                TextButton(onClick = model::signOut, enabled = !state.busy) { Text("Clear this phone's account data") }
            }
        }
        }
        if (state.paired) {
            HorizontalDivider()
            Text("Saved connection", style = MaterialTheme.typography.titleMedium)
            Text("Wake your laptop to reconnect. Your saved pairing survives sleep and network changes.")
            OutlinedButton(onClick = model::reconnect, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Reconnect now") }
            TextButton(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text("Back to sessions") }
            TextButton(onClick = model::forget, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Forget this laptop") }
        }
        TextButton(onClick = { manual = !manual }, modifier = Modifier.fillMaxWidth()) { Text(if (manual) "Hide advanced setup" else "Advanced: existing server") }
        if (manual) {
            Text("For an existing direct server connection. Public laptop setup uses QR pairing above.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("HTTPS server URL") }, singleLine = true)
            OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), label = { Text("Pairing code") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
            Button(onClick = { model.pair(url, code) { code = ""; onDone() } }, enabled = !state.busy && code.isNotBlank() && url.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Pair existing server") }
        }
        TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, "https://github.com/techtravelai25-arch/herdr-remote-release".toUri())) }) { Text("Source code · AGPL-3.0-or-later") }
        Text("Scan only a QR shown by your own laptop. New relay pairings encrypt your commands, conversations and files between this phone and that laptop.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (deletingAccount) AlertDialog(
        onDismissRequest = { deletingAccount = false },
        title = { Text("Delete your cloud account?") },
        text = { Text("This deletes your email account, cloud sessions, push subscriptions and laptop directory links. Your laptop's paired device credentials and remote control are separate: revoke them on the laptop. Saved phone data is cleared after cloud deletion succeeds.") },
        confirmButton = { TextButton(enabled = !state.busy, onClick = { deletingAccount = false; model.deleteAccount() }) { Text("Delete cloud account") } },
        dismissButton = { TextButton(onClick = { deletingAccount = false }) { Text("Cancel") } }
    )
}
internal fun kindLabel(kind: String) = when(kind) { "codex" -> "Codex"; "claude", "claude-code" -> "Claude Code"; "opencode" -> "OpenCode"; "terminal" -> "Terminal"; "" -> "Unknown"; else -> kind }
internal fun activityLabel(value: String?): String = value?.let { runCatching { DateTimeFormatter.ofPattern("MMM d, HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(it)) }.getOrDefault(it) } ?: "unknown"

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun AgentDetail(state: RemoteState, pane: Pane?, model: RemoteModel) {
    var pickerPane by rememberSaveable { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        pickerPane?.let { id -> if (uris.isNotEmpty()) model.addAttachments(id, uris) }
        pickerPane = null
    }
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { destination ->
        model.completeArtifactSave(destination)
    }
    val requestSave: (String, String) -> Unit = { id, name ->
        model.prepareArtifactSave(id, name)?.let(saveLauncher::launch)
    }
    var showingFiles by rememberSaveable(state.url, state.portalDeviceId, state.selectedId) { mutableStateOf(false) }
    var fileMessage by rememberSaveable(state.url, state.portalDeviceId, state.selectedId) { mutableStateOf<String?>(null) }
    var htmlPreview by remember(state.url, state.portalDeviceId, state.selectedId) { mutableStateOf<HtmlPreviewRequest?>(null) }
    var previewError by remember(state.url, state.portalDeviceId, state.selectedId) { mutableStateOf<String?>(null) }
    val openPreview: (String?, String?) -> Unit = { target, artifactId ->
        runCatching { model.htmlPreviewSource() }.onSuccess {
            showingFiles = false
            htmlPreview = HtmlPreviewRequest(it, target, artifactId)
        }.onFailure { previewError = it.message ?: "Could not open this page. Reconnect and try again." }
    }
    val openHtmlLink: (String) -> Unit = remember(model, state.url, state.portalDeviceId, state.selectedId) {
        { target -> openPreview(target, null) }
    }
    LaunchedEffect(state.message, showingFiles) {
        if (showingFiles && state.message != null) fileMessage = state.message
    }
    var detailTab by rememberSaveable(state.selectedId) { mutableIntStateOf(0) }
    DisposableEffect(model, state.selectedId, detailTab, htmlPreview) {
        model.outputVisible(detailTab == 0 && htmlPreview == null)
        onDispose { model.outputVisible(false) }
    }
    var storage by rememberSaveable { mutableStateOf(false) }
    htmlPreview?.let { request ->
        androidx.compose.ui.window.Dialog(
            onDismissRequest = { htmlPreview = null },
            properties = androidx.compose.ui.window.DialogProperties(
                usePlatformDefaultWidth = false, decorFitsSystemWindows = false,
            ),
        ) {
            val previewView = androidx.compose.ui.platform.LocalView.current
            val lightBars = MaterialTheme.colorScheme.surface.luminance() > 0.5f
            SideEffect {
                val window = (previewView.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window
                if (window != null) androidx.core.view.WindowCompat.getInsetsController(window, previewView).apply {
                    isAppearanceLightStatusBars = lightBars
                    isAppearanceLightNavigationBars = lightBars
                }
            }
            Surface(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().systemBarsPadding()) {
                    HtmlPreviewScreen(request.source, request.target, request.artifactId, onClose = { htmlPreview = null })
                }
            }
        }
    }
    CompositionLocalProvider(LocalHtmlPreviewOpener provides openHtmlLink) {
    Column(Modifier.fillMaxSize()) {
        if (detailTab == 1) Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { detailTab = 0 }) { Text("Back to conversation") }
            Text("Saved history", style = MaterialTheme.typography.titleSmall)
        } else TabRow(selectedTabIndex = if (detailTab == 2) 1 else 0, containerColor = MaterialTheme.colorScheme.background) {
            Tab(selected = detailTab == 0, onClick = { detailTab = 0 }, text = { Text("Conversation") })
            Tab(selected = detailTab == 2, enabled = pane != null && state.online, onClick = { detailTab = 2; pane?.id?.let(model::loadReview) }, text = { Text("Review results") })
        }
        Box(Modifier.weight(1f)) {
            if (detailTab == 1) ConversationHistory(state.structuredHistory, state.historyLoading, state.historyError, state.online, { model.loadHistory() }, { model.loadHistory(true) })
            else if (detailTab == 2) ReviewResults(state.review, state.reviewLoading,
                onRefresh = { pane?.id?.let(model::loadReview) }, onArtifact = { id ->
                    val name = state.review?.get("artifacts")?.jsonArray?.mapNotNull { it as? JsonObject }
                        ?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == id }
                        ?.get("name")?.jsonPrimitive?.contentOrNull.orEmpty()
                    if (isHtmlFile(name)) openPreview(null, id) else model.openArtifact(id)
                },
                onSave = requestSave)
            else {
                TerminalLiveView(state, pane,
                    onDraft = { text -> state.selectedId?.let { model.updateDraft(it, text) } },
                    onInsert = model::insertTerminalText,
                    onPrompt = { text -> model.prompt(text) {} }, onKey = model::key,
                    onRefresh = model::refresh,
                    onManageAttachments = { storage = true; model.loadAttachmentStorage() },
                    onAttach = { pickerPane = pane?.id; picker.launch(arrayOf("*/*")) },
                    onRemoveAttachment = { uri -> pane?.id?.let { model.removeAttachment(it, uri) } },
                    onBrowseFiles = { fileMessage = null; model.clearMessage(); showingFiles = true; model.loadProjectFiles() },
                    onCheckDelivery = model::checkDelivery,
                    onAcknowledgeDelivery = model::acknowledgeDelivery,
                    onChangeModel = model::openAgentModelMenu,
                    onReviewQuestion = model::reviewQuestion,
                    onAnswerQuestion = { option, text -> state.question?.id?.let { model.answerQuestion(it, option, text) } },
                    onOpenHistory = { detailTab = 1; if (state.online) model.loadHistory() },
                    onEarlierHistory = { model.loadHistory(true) })
            }
        }
    }
    }
    if (showingFiles) FilesBrowserDialog(files = state.projectFiles, loading = state.projectFilesLoading,
        error = state.projectFilesError, operationMessage = fileMessage,
        url = state.url, portalDeviceId = state.portalDeviceId,
        onDismiss = { showingFiles = false },
        onNavigate = { directory, cursor -> fileMessage = null; model.clearMessage(); model.loadProjectFiles(directory, cursor) },
        onOpen = { file -> fileMessage = null; model.clearMessage()
            if (file.isDirectory) model.loadProjectFiles(file.path)
            else if (isHtmlFile(file.path)) openPreview(file.path, null)
            else file.id?.let(model::openArtifact)
        },
        // Only offer the pick when the reference exists; never launch with no source file.
        onSave = { file -> fileMessage = null; model.clearMessage(); file.id?.let { requestSave(it, file.path) } })
    if (storage) AttachmentStorageDialog(state, model, onDismiss = { storage = false })
    previewError?.let { message -> AlertDialog(onDismissRequest = { previewError = null },
        title = { Text("Page unavailable") }, text = { Text(message) },
        confirmButton = { TextButton(onClick = { previewError = null }) { Text("Close") } }) }
    state.agentModelMenu?.takeIf { detailTab == 0 && pane != null }?.let { menu ->
        val enabled = canChangeAgentModel(state, pane) && pane?.let { state.deliveries[it.id]?.isUnresolved() } != true
        CodexModelDialog(menu, enabled, state.busy,
            onSelect = { model.selectAgentModel(menu.id, it) },
            onCancel = { if (enabled) model.cancelAgentModelMenu(menu.id) else model.dismissAgentModelMenuLocally() },
            onDismiss = { if (enabled) model.cancelAgentModelMenu(menu.id) else model.dismissAgentModelMenuLocally() },
            onKey = { model.agentModelKey(menu.id, it) })
    }
}

private data class HtmlPreviewRequest(val source: HtmlPreviewSource, val target: String?, val artifactId: String?)

@Composable internal fun AgentActions(enabled: Boolean, onControl: (String) -> Unit,
    currentTitle: String = "", canRename: Boolean = false, canFocus: Boolean = false,
    onRename: (String) -> Unit = {}, onFocus: () -> Unit = {}, terminal: Boolean = false, canStop: Boolean = true) {
    var expanded by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { expanded = true }) { Icon(Icons.Default.MoreVert, if (terminal) "Terminal actions" else "Agent actions") }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(text = { Text("Rename session") }, leadingIcon = { Icon(Icons.Default.Edit, null) },
                enabled = enabled && canRename, onClick = { expanded = false; renaming = true })
            DropdownMenuItem(text = { Text("Show on laptop") }, leadingIcon = { Icon(Icons.Default.Computer, null) },
                enabled = enabled && canFocus, onClick = { expanded = false; onFocus() })
            HorizontalDivider()
            val menuActions = if (terminal) listOf("stop", "close") else listOf("stop", "restart", "close")
            menuActions.forEach { action ->
                DropdownMenuItem(
                    text = { Text(if (action == "restart") "Start fresh" else "${action.replaceFirstChar { it.uppercase() }} pane") },
                    enabled = enabled && (action != "stop" || canStop),
                    onClick = { expanded = false; confirm = action }
                )
            }
            if (!terminal) {
                DropdownMenuItem(text = { Text("Resume unavailable for this connection") }, enabled = false, onClick = {})
            }
        }
    }
    if (renaming) RenameSessionDialog(currentTitle, enabled && canRename,
        onDismiss = { renaming = false }, onRename = { renaming = false; onRename(it) })
    confirm?.let { action ->
        AlertDialog(onDismissRequest = { confirm = null }, title = { Text(if (action == "restart") "Start a fresh conversation?" else "${action.replaceFirstChar { it.uppercase() }} this pane?") }, text = {
            Text(when (action) {
                "stop" -> "Interrupt the running process with Ctrl+C."
                "restart" -> "Close this pane and start a fresh agent session in a replacement tab. This requires an approved project matching its working directory. Unsent input and active work may be lost."
                else -> "Close the pane and its running process. This cannot be undone."
            })
        }, confirmButton = {
            TextButton(enabled = enabled && (action != "stop" || canStop), onClick = { confirm = null; onControl(action) }) { Text(if (action == "restart") "Start fresh" else action.replaceFirstChar { it.uppercase() }) }
        }, dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } })
    }
}

@Composable internal fun RenameSessionDialog(currentTitle: String, enabled: Boolean, onDismiss: () -> Unit, onRename: (String) -> Unit) {
    var title by rememberSaveable(currentTitle) { mutableStateOf(currentTitle) }
    val trimmed = title.trim()
    val valid = trimmed.isNotEmpty() && trimmed.length <= 120 && trimmed.none { it.isISOControl() }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Rename session") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Choose a name you'll recognize on your phone and in Herdr.")
            OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Session name") },
                modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = enabled,
                isError = title.isNotEmpty() && !valid,
                supportingText = { Text(if (trimmed.length > 120) "Use 120 characters or fewer." else "For example, Fix login or Review checkout") })
        }
    }, confirmButton = { TextButton(enabled = enabled && valid && trimmed != currentTitle, onClick = { onRename(trimmed) }) { Text("Save name") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

/** Compatibility entry point for existing preview fixtures. The live screen uses TerminalLiveView. */
@Suppress("UNUSED_PARAMETER")
@Composable internal fun AgentDetailContent(
    state: RemoteState,
    pane: Pane?,
    onKey: (String) -> Unit,
    onPrompt: (String, () -> Unit) -> Unit,
    onAnswerQuestion: (String, Int?, String?) -> Unit = { _, _, _ -> },
    onRefresh: () -> Unit = {},
    onRefreshHistory: () -> Unit = {},
    onAttach: () -> Unit = {},
    onRemoveAttachment: (Uri) -> Unit = {},
    onDraft: (String) -> Unit = {},
    onCheckDelivery: (String) -> Unit = {},
    onManageAttachments: () -> Unit = {},
    onChangeModel: () -> Unit = {},
    onBrowseFiles: () -> Unit = {},
    filesEntryAvailable: Boolean = false,
    outerScroll: ScrollState = rememberScrollState()
) {
    TerminalLiveView(state, pane, onDraft = onDraft, onInsert = {},
        onPrompt = { onPrompt(it) {} }, onKey = onKey, onRefresh = onRefresh,
        onAttach = onAttach, onRemoveAttachment = onRemoveAttachment,
        onManageAttachments = onManageAttachments, onBrowseFiles = onBrowseFiles,
        onCheckDelivery = onCheckDelivery,
        onAnswerQuestion = { option, text -> state.question?.id?.let { onAnswerQuestion(it, option, text) } })
}

@Composable internal fun OperationReceipt(delivery: DeliveryState, enabled: Boolean, onCheck: () -> Unit) {
    val uncertain = delivery.status in setOf("unknown", "uncertain")
    val operation = when (delivery.operation.substringAfterLast('.')) {
        "create" -> "New session"
        "prompt" -> "Message"
        "answer" -> "Decision"
        "question-review" -> "Open question"
        "keys" -> "Key press"
        "stop" -> "Stop agent"
        "restart" -> "Start fresh"
        "close" -> "Close pane"
        "delete" -> "Delete file"
        "rename" -> "Rename session"
        "focus" -> "Show on laptop"
        else -> "Request"
    }
    val status = when (delivery.status) {
        "sending", "running" -> "Sending"
        "delivered", "succeeded" -> "Delivered"
        "acknowledged" -> "Reviewed"
        "failed" -> "Failed"
        else -> "Delivery unknown"
    }
    Surface(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("$operation · $status", style = MaterialTheme.typography.labelLarge,
                color = if (uncertain || delivery.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
            if (delivery.message != status) Text(delivery.message, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (uncertain || delivery.status == "running") TextButton(onClick = onCheck, enabled = enabled) { Text("Check delivery") }
        }
    }
}

/** A readable message or an expandable tool event, retaining transcript search anchors. */
@Composable internal fun TranscriptBlock(block: TerminalBlock, calm: Boolean, wrap: Boolean, agentLabel: String, fontSize: Float = 15f, query: String = "", selectedMatch: TranscriptSearchMatch? = null, revealRequest: Int? = null, onRevealed: (Int) -> Unit = {}) {
    var expanded by remember { mutableStateOf(false) }
    val mono = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontSize = fontSize.sp, lineHeight = (fontSize * 1.35f).sp)
    val context = androidx.compose.ui.platform.LocalContext.current
    val openLink = rememberTranscriptLinkOpener()
    val linked = remember(block.text, openLink) { linkedAnnotated(block.text.trim(), context, openLink) }
    if (block.isUser) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(modifier = Modifier.padding(start = 12.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 4.dp)) {
                Row(Modifier.padding(start = 12.dp, top = 12.dp, end = 4.dp, bottom = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("You", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        SearchableTranscriptText(linked, query, selectedMatch = selectedMatch, revealRequest = revealRequest, onRevealed = onRevealed,
                            style = MaterialTheme.typography.bodyMedium.copy(lineHeight = (fontSize * 1.4f).sp, fontSize = fontSize.sp, color = MaterialTheme.colorScheme.onSurface), softWrap = wrap)
                    }
                    CopyTextIconButton(block.text, "Copy message")
                }
            }
        }
    } else if (block.isActivity && calm) {
        Surface(shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.padding(horizontal = 12.dp)) {
                TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(horizontal = 0.dp), modifier = Modifier.heightIn(min = 48.dp).semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }) {
                    Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(if (expanded) "Hide tool activity" else "Show tool activity", style = MaterialTheme.typography.labelMedium)
                }
                if (expanded) { SearchableTranscriptText(linked, query, selectedMatch = selectedMatch, revealRequest = revealRequest, onRevealed = onRevealed,
                    style = mono.copy(color = MaterialTheme.colorScheme.onSurfaceVariant), softWrap = wrap); CopyTextButton(block.text, "Copy activity") }
            }
        }
    } else if (block.text.isNotBlank()) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (block.isActivity) "Tool activity" else agentLabel,
                    modifier = Modifier.weight(1f).padding(bottom = 8.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold)
                CopyTextIconButton(block.text, if (block.isActivity) "Copy activity" else "Copy response")
            }
            if (!block.isActivity) RichTranscript(block.text.trim(), fontSize, wrap, query, selectedMatch, revealRequest, onRevealed)
            else SearchableTranscriptText(linked, query, selectedMatch = selectedMatch, revealRequest = revealRequest, onRevealed = onRevealed, style = mono.copy(color = MaterialTheme.colorScheme.onSurface), softWrap = wrap)
        }
    }
}

@Composable private fun NewAgent(state: RemoteState, model: RemoteModel, dismiss: () -> Unit) {
    val previousCreationId by rememberSaveable(state.url, state.portalDeviceId) { mutableStateOf(state.deliveries["__create__"]?.id) }
    val creation = state.deliveries["__create__"]?.takeIf { it.id != previousCreationId }
    var directory by rememberSaveable(state.url, state.portalDeviceId) { mutableStateOf<String?>(null) }
    var browsing by rememberSaveable(state.url, state.portalDeviceId) { mutableStateOf(false) }
    val foldersSupported = state.snapshot.directoryBrowsingEnabled
    var kind by rememberSaveable { mutableStateOf("codex") }
    var name by rememberSaveable { mutableStateOf("") }
    val validName = name.isBlank() || Regex("^[a-z][a-z0-9_-]{0,31}$").matches(name.trim())
    if (browsing) {
        DirectoryPickerDialog(state, { path, cursor -> model.browseDirectories(path, cursor) }, choose = { directory = it; browsing = false }, dismiss = { browsing = false })
        return
    }
    NewSessionDialog(
        kind = kind, onKind = { kind = it },
        terminalSupported = state.snapshot.terminalCreationEnabled,
        terminalInputAllowed = state.snapshot.allowTerminalInput,
        directory = directory, foldersSupported = foldersSupported,
        browseEnabled = !state.busy,
        onBrowse = { model.browseDirectories(directory); browsing = true },
        name = name, onName = { name = it }, validName = validName,
        canCreate = validName && foldersSupported && !directory.isNullOrBlank() &&
            (kind != "terminal" || state.snapshot.terminalCreationEnabled) && state.online &&
            state.snapshot.herdrOnline && !state.snapshot.stale && state.snapshot.canControl && !state.busy && state.deliveries["__create__"]?.isUnresolved() != true,
        onCreate = { model.create(null, kind, name, directory = directory, onCreated = dismiss) },
        dismiss = dismiss,
        creation = creation,
    )
}
