package dev.herdr.remote

import java.time.Instant

internal enum class SessionGrouping { PROJECT, WORKSPACE }

internal fun decodeSessionGrouping(value: String?): SessionGrouping =
    SessionGrouping.entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: SessionGrouping.PROJECT

internal data class SessionGroup(val key: String, val title: String, val detail: String?, val panes: List<Pane>, val priority: Int)

/** Active conversations lead the dashboard; idle sessions always follow the other states. */
internal fun dashboardSessionPriority(pane: Pane): Int = when (dashboardStatus(pane.status)) {
    DashboardStatus.WAITING, DashboardStatus.WORKING -> 0
    DashboardStatus.IDLE -> 2
    else -> 1
}

/** Keep unknown activity behind dated sessions, without reshuffling equal or unknown entries. */
internal fun newestSessionsFirst(panes: List<Pane>): List<Pane> = panes.mapIndexed { index, pane ->
    Triple(pane, runCatching { pane.lastActivity?.let(Instant::parse) }.getOrNull(), index)
}.sortedWith { left, right ->
    val byActivity = compareValues(right.second, left.second)
    if (byActivity != 0) byActivity else left.third.compareTo(right.third)
}.map { it.first }

// Preserve case and path components: basenames and lexical '..' resolution can merge unrelated checkouts.
internal fun sessionDirectory(cwd: String): String = if (cwd.startsWith('/')) cwd.trimEnd('/').ifEmpty { "/" } else cwd

internal fun groupSessions(panes: List<Pane>, workspaces: List<Workspace>, grouping: SessionGrouping): List<SessionGroup> {
    val workspaceLabels = workspaces.associate { it.id to it.label }
    // Split each project/workspace across status bands so an idle member cannot
    // appear before active work in another group. Preserve recency inside a band.
    return newestSessionsFirst(panes).sortedBy(::dashboardSessionPriority).groupBy { pane ->
        dashboardSessionPriority(pane) to when {
            grouping == SessionGrouping.WORKSPACE -> "workspace:${pane.workspaceId}"
            !pane.projectId.isNullOrBlank() -> "project:${pane.projectId}"
            pane.cwd.isNotBlank() -> "directory:${sessionDirectory(pane.cwd)}"
            else -> "workspace:${pane.workspaceId}"
        }
    }.map { (bandAndKey, members) ->
        val (priority, key) = bandAndKey
        val first = members.first()
        val directories = members.map { sessionDirectory(it.cwd) }.filter { it.isNotBlank() }.distinct()
        when {
            key.startsWith("workspace:") -> SessionGroup(key, workspaceLabels[first.workspaceId]?.takeIf { it.isNotBlank() }
                ?: first.workspaceId.ifBlank { "Sessions" }, null, members, priority)
            key.startsWith("project:") -> {
                val title = members.firstNotNullOfOrNull { it.projectLabel?.takeIf(String::isNotBlank) }
                    ?: directories.firstOrNull() ?: first.projectId.orEmpty()
                val detail = when {
                    directories.size > 1 -> "${directories.first()} · ${directories.size} folders"
                    directories.firstOrNull() != title -> directories.firstOrNull()
                    else -> null
                }
                SessionGroup(key, title, detail, members, priority)
            }
            else -> SessionGroup(key, directories.first(), null, members, priority)
        }
    }
}
