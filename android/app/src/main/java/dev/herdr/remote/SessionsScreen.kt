package dev.herdr.remote

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.edit

/** Feature attention when it does not put inactive work ahead of active sessions. */
internal fun featuredDashboardPane(
    panes: List<Pane>,
    attentionIds: Set<String>,
    unreadIds: Set<String>,
    freshSnapshot: Boolean,
): Pane? {
    val recentPanes = newestSessionsFirst(panes)
    val activePanes = recentPanes.filter { dashboardSessionPriority(it) == 0 }
    if (activePanes.isNotEmpty()) return activePanes.firstOrNull { it.id in attentionIds }
    return recentPanes.firstOrNull { it.id in attentionIds && dashboardSessionPriority(it) < 2 } ?: if (freshSnapshot) {
        recentPanes.firstOrNull { pane ->
            val eventId = pane.completionEventId
            pane.id in unreadIds && pane.kind != "terminal" && dashboardStatus(pane.status) == DashboardStatus.DONE &&
                eventId != null && eventId.isNotBlank() && !pane.completionAcknowledged &&
                eventId !in pane.acknowledgedCompletionEventIds
        }
    } else null
}

/** Session browsing persists its grouping preference; all session actions go through callbacks. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable internal fun SessionsScreen(
    state: RemoteState,
    onSelect: (String) -> Unit,
    onRefresh: () -> Unit,
    onReconnect: () -> Unit,
    onStartHerdr: () -> Unit,
    onCheckCreate: () -> Unit,
    listState: LazyListState = rememberLazyListState(),
    onAcknowledgeCreate: () -> Unit = {},
) {
    val creation = state.deliveries["__create__"]
    var acknowledgeCreate by remember(state.url, state.portalDeviceId, creation?.id) { mutableStateOf(false) }
    var filter by rememberSaveable { mutableStateOf("all") }
    var query by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    val preferences = remember(context) { context.getSharedPreferences("session_browsing", android.content.Context.MODE_PRIVATE) }
    var groupingName by rememberSaveable { mutableStateOf(decodeSessionGrouping(preferences.getString("grouping", null)).name) }
    val grouping = decodeSessionGrouping(groupingName)
    var groupingMenu by remember { mutableStateOf(false) }
    val search = query.trim()
    val allPanes = state.snapshot.panes
    val visible = allPanes.filter { pane ->
        val matchesFilter = when (filter) {
            "attention" -> pane.id in state.attentionIds
            "unread" -> pane.id in state.unreadIds
            else -> true
        }
        matchesFilter && (search.isBlank() || listOf(pane.title, pane.cwd, pane.kind, kindLabel(pane.kind), pane.projectLabel.orEmpty(),
            state.snapshot.workspaces.find { it.id == pane.workspaceId }?.label.orEmpty())
            .any { it.contains(search, ignoreCase = true) })
    }
    val attentionCount = allPanes.count { it.id in state.attentionIds }
    val unreadCount = allPanes.count { it.id in state.unreadIds }
    val stale = !state.online || !state.snapshot.herdrOnline || state.snapshot.stale
    val featured = if (search.isBlank() && filter == "all") {
        featuredDashboardPane(allPanes, state.attentionIds, state.unreadIds, freshSnapshot = !stale)
    } else null
    val listed = visible.filterNot { it.id == featured?.id }
    PullToRefreshBox(isRefreshing = state.busy, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.align(Alignment.TopCenter).widthIn(max = 840.dp).fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp),
        ) {
            item(key = "connection") {
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                        Icon(Icons.Default.Computer, null, Modifier.padding(8.dp).size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(state.snapshot.hostname.ifBlank { "Your laptop" }, style = MaterialTheme.typography.titleSmall)
                        Text(when {
                            !state.online -> if (state.signInRequired) "Sign-in needed" else "Reconnecting"
                            !state.snapshot.herdrOnline -> "Herdr is not running"
                            state.snapshot.stale -> "Updating sessions"
                            !state.snapshot.canControl -> "Observer access · remote actions disabled"
                            state.live -> "Connected · Live"
                            else -> "Connected · Syncing"
                        }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        state.snapshot.lastUpdatedAt?.takeIf { stale }?.let { updated ->
                            Text(
                                "Last updated ${activityLabel(updated)} · last known sessions",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }

            }
            if (!state.online || !state.snapshot.herdrOnline) item(key = "connection-action") {
                Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(12.dp)) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
                        Text(if (state.signInRequired) "Open Settings → Laptop & account and sign in again. Your drafts are saved."
                            else if (!state.online) state.connectionError ?: "Reconnecting automatically. Check your phone's network and wake your laptop. Your connection and drafts are saved."
                            else "Start Herdr to see and control your agents.", style = MaterialTheme.typography.bodyMedium)
                        if (!state.online && state.connectionError != null && !state.signInRequired) {
                            Text("Retrying automatically. Your connection and drafts are saved.", Modifier.padding(top = 6.dp),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (!state.online) TextButton(onClick = onReconnect, enabled = !state.busy) { Text("Reconnect") }
                        else if (state.snapshot.canStartHerdr) TextButton(onClick = onStartHerdr, enabled = !state.busy) { Text("Start Herdr") }
                        else Text("Open Herdr on your laptop to continue.", Modifier.padding(top = 6.dp),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
            state.deliveries["__create__"]?.takeUnless { it.status in setOf("delivered", "succeeded") }?.let { delivery ->
                item(key = "create-receipt") {
                    OperationReceipt(delivery, enabled = !state.busy && state.online, onCheck = onCheckCreate)
                    if (delivery.status in setOf("unknown", "uncertain")) {
                        TextButton(onClick = { acknowledgeCreate = true }, enabled = !state.busy) {
                            Text("I've checked the sessions")
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }
            }
            state.snapshot.error?.takeIf { it.isNotBlank() }?.let { error ->
                item(key = "connection-error") {
                    Text(error, Modifier.padding(bottom = 8.dp), color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall)
                }
            }
            item(key = "sessions-heading") {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Sessions", Modifier.semantics { heading() },
                            style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                        Text("${visible.size}", style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Box {
                        IconButton(onClick = { groupingMenu = true }) {
                            Icon(Icons.Default.Tune, "Group sessions · currently by ${if (grouping == SessionGrouping.PROJECT) "project" else "workspace"}")
                        }
                        DropdownMenu(expanded = groupingMenu, onDismissRequest = { groupingMenu = false }) {
                            SessionGrouping.entries.forEach { option ->
                                DropdownMenuItem(text = { Text(if (option == SessionGrouping.PROJECT) "Group by project" else "Group by workspace") },
                                    modifier = Modifier.semantics { selected = grouping == option },
                                    onClick = {
                                        groupingName = option.name
                                        preferences.edit { putString("grouping", option.name) }
                                        groupingMenu = false
                                    })
                            }
                        }
                    }
                }
            }
            featured?.let { pane ->
                item(key = "attention") {
                    MissionAttentionCard(pane, attentionCount, completion = pane.id !in state.attentionIds,
                        stale = stale, onOpen = { onSelect(pane.id) })
                    Spacer(Modifier.height(12.dp))
                }
            }
            item(key = "search") {
                TextField(value = query, onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Search sessions" },
                    placeholder = { Text("Search sessions") }, singleLine = true,
                    leadingIcon = { Icon(Icons.Default.Search, null) },
                    trailingIcon = if (query.isNotEmpty()) {{ IconButton(onClick = { query = "" }) { Icon(Icons.Default.Close, "Clear search") } }} else null,
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                    ),
                    shape = RoundedCornerShape(12.dp))
                FlowRow(Modifier.fillMaxWidth().padding(top = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(0.dp)) {
                    listOf("all" to "All", "attention" to if (attentionCount > 0) "Attention $attentionCount" else "Attention", "unread" to if (unreadCount > 0) "Unread $unreadCount" else "Unread").forEach { (value, label) ->
                        FilterChip(selected = filter == value, onClick = { filter = value }, label = { Text(label) }, modifier = Modifier.minimumInteractiveComponentSize(), border = null)
                    }
                }
            }
            if (visible.isEmpty()) item(key = "empty") {
                val title = when {
                    search.isNotBlank() -> "No matching sessions"
                    filter == "attention" -> "No agents need attention"
                    filter == "unread" -> "You're up to date"
                    !state.online -> "Waiting for your laptop"
                    !state.snapshot.herdrOnline -> "Waiting for Herdr"
                    else -> "No sessions yet"
                }
                Column(Modifier.fillMaxWidth().padding(vertical = 28.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(title, style = MaterialTheme.typography.titleMedium)
                    Text(when {
                        search.isNotBlank() -> "Try a session name, project path, or agent."
                        filter != "all" -> "Choose All to see your other sessions."
                        !state.online -> "Sessions will appear when the laptop reconnects."
                        !state.snapshot.herdrOnline -> "Your sessions will appear when Herdr is running."
                        else -> "Start an agent in an approved project, or open a session in Herdr on your laptop."
                    }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (search.isNotBlank() || filter != "all") TextButton(onClick = { query = ""; filter = "all" }) { Text("Show all sessions") }
                }
            }
            groupSessions(listed, state.snapshot.workspaces, grouping).forEach { group ->
                item(key = "group:${group.priority}:${group.key}") {
                    val pathTitle = group.title.startsWith('/')
                    SessionGroupHeading(
                        if (pathTitle) group.title.trimEnd('/').substringAfterLast('/').ifBlank { group.title } else group.title,
                        if (pathTitle) group.title else group.detail,
                    )
                }
                items(group.panes, key = { "pane:${it.id}" }) { pane ->
                    SessionListRow(pane, selected = pane.id == state.selectedId, unread = pane.id in state.unreadIds,
                        showProject = group.key.startsWith("workspace:") || group.panes.map { sessionDirectory(it.cwd) }.distinct().size > 1,
                        workspaceLabel = if (grouping == SessionGrouping.PROJECT && !group.key.startsWith("workspace:")) (state.snapshot.workspaces.find { it.id == pane.workspaceId }?.label ?: pane.workspaceId)
                            .takeUnless { it == group.title || it == group.title.trimEnd('/').substringAfterLast('/') } else null,
                        stale = !state.online || !state.snapshot.herdrOnline || state.snapshot.stale, onClick = { onSelect(pane.id) })
                }
            }
            item(key = "usage-remaining") {
                UsageRemainingSection(state.snapshot.usage, offline = !state.online, stale = false)
            }

        }
    }
    if (acknowledgeCreate && creation?.status in setOf("unknown", "uncertain")) {
        AlertDialog(onDismissRequest = { acknowledgeCreate = false },
            title = { Text("Allow another session request?") },
            text = { Text("The previous request may have started a session. Check your laptop or refresh the sessions first. Continuing clears the block; it does not retry or cancel that request.") },
            confirmButton = {
                TextButton(enabled = !state.busy, onClick = { acknowledgeCreate = false; onAcknowledgeCreate() }) {
                    Text("I've checked · Continue")
                }
            },
            dismissButton = { TextButton(onClick = { acknowledgeCreate = false }) { Text("Cancel") } })
    }
}

@Composable private fun SessionGroupHeading(title: String, detail: String? = null) {
  Column(Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
    Text(title, Modifier.fillMaxWidth().semantics { heading() },
        style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable private fun SessionListRow(pane: Pane, selected: Boolean, unread: Boolean, stale: Boolean, showProject: Boolean = true, workspaceLabel: String? = null, onClick: () -> Unit) {
    val icon = when (pane.kind) {
        "codex" -> Icons.Default.Code
        "claude", "claude-code" -> Icons.Default.AutoAwesome
        "opencode" -> Icons.Default.DataObject
        "terminal" -> Icons.Default.Terminal
        else -> Icons.Default.SmartToy
    }
    val project = pane.cwd.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').ifBlank { "Project unavailable" }
    Row(Modifier.fillMaxWidth().background(if (selected) MaterialTheme.colorScheme.surfaceContainerHighest else MaterialTheme.colorScheme.surface, RoundedCornerShape(14.dp)).semantics { this.selected = selected }.clickable(role = Role.Button, onClickLabel = "Open ${pane.title}", onClick = onClick)
        .heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
        ProviderTile(icon)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(pane.title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall,
                    fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Medium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                if (unread) Box(Modifier.size(7.dp).background(MaterialTheme.colorScheme.primary, CircleShape)
                    .semantics { contentDescription = "Unread activity" })
            }
            Text(listOfNotNull(kindLabel(pane.kind), project.takeIf { showProject }, workspaceLabel?.takeIf { it.isNotBlank() }).joinToString(" · "), modifier = Modifier.semantics { contentDescription = listOfNotNull(kindLabel(pane.kind), pane.cwd.ifBlank { "Project unavailable" }, workspaceLabel).joinToString(" · ") },
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                DashboardStatusBadge(pane.status, stale)
                pane.lastActivity?.let {
                    Text(activityLabel(it), modifier = Modifier.align(Alignment.CenterVertically), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
    Spacer(Modifier.height(2.dp))
}

@Composable private fun ProviderTile(icon: ImageVector) {
    Surface(shape = RoundedCornerShape(9.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurface)
        }
    }
}

/** Promoted attention and unread completions both open the existing conversation. */
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun MissionAttentionCard(pane: Pane, attentionCount: Int, completion: Boolean, stale: Boolean, onOpen: () -> Unit) {
    val colors = dashboardStatusColors(dashboardStatus(pane.status), MaterialTheme.colorScheme, stale)
    Surface(color = colors.container, contentColor = colors.foreground,
        shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(when {
                stale -> "Previously needed attention"
                completion -> "Agent finished · review output"
                attentionCount == 1 -> "Needs attention"
                else -> "$attentionCount sessions need attention"
            },
                style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            DashboardStatusBadge(pane.status, stale)
            Text(pane.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            val project = pane.projectLabel?.takeIf { it.isNotBlank() }
                ?: pane.cwd.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').ifBlank { "Project unavailable" }
            Text("$project · ${kindLabel(pane.kind)}", style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (stale) "Check availability" else when (dashboardStatus(pane.status)) {
                    DashboardStatus.ERROR -> "Session reported an error"
                    DashboardStatus.BLOCKED -> "Open the conversation to review the blocker"
                    else -> if (completion) "Open the completed conversation to review its output" else "Waiting for your input"
                },
                    modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = onOpen, modifier = Modifier.heightIn(min = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.foreground)) {
                    Text(when {
                        stale -> "Open"
                        completion -> "Review output"
                        else -> "Review"
                    })
                }
            }
        }
    }
}
