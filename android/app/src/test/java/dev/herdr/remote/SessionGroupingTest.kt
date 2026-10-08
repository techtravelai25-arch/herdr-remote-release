package dev.herdr.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionGroupingTest {
    private fun pane(id: String, workspace: String, cwd: String, project: String? = null, label: String? = null,
                     activity: String? = null, status: String = "unknown") =
        Pane(id, workspace, cwd = cwd, projectId = project, projectLabel = label, lastActivity = activity, status = status)

    @Test fun sameProjectAcrossWorkspacesStaysTogetherInOriginalOrder() {
        val panes = listOf(pane("a", "one", "/repo/src", "repo", "App"), pane("b", "two", "/other", "other"),
            pane("c", "three", "/repo/test", "repo", "App"))
        val groups = groupSessions(panes, emptyList(), SessionGrouping.PROJECT)
        assertEquals(listOf("project:repo", "project:other"), groups.map { it.key })
        assertEquals(listOf("a", "c"), groups.first().panes.map { it.id })
        assertEquals("App", groups.first().title)
    }

    @Test fun oldBridgeGroupsExactDirectoriesWithoutMergingSameBasenames() {
        val groups = groupSessions(listOf(pane("a", "one", "/work/app/"), pane("b", "two", "/work/app"),
            pane("c", "one", "/personal/app")), emptyList(), SessionGrouping.PROJECT)
        assertEquals(listOf("directory:/work/app", "directory:/personal/app"), groups.map { it.key })
        assertEquals(listOf("a", "b"), groups.first().panes.map { it.id })
        assertEquals("/work/app", groups.first().title)
    }

    @Test fun missingDirectoryFallsBackToWorkspaceAndKeepsUnknownWorkspacesSeparate() {
        val groups = groupSessions(listOf(pane("a", "one", ""), pane("b", "two", "")),
            listOf(Workspace("one", "First")), SessionGrouping.PROJECT)
        assertEquals(listOf("First", "two"), groups.map { it.title })
        assertNull(groups.first().detail)
    }

    @Test fun workspaceChoiceKeepsSameProjectSeparateAndOrdersWorkspacesByActivity() {
        val groups = groupSessions(listOf(
            pane("a", "one", "/repo", "repo", activity = "2026-01-01T00:00:00Z"),
            pane("b", "two", "/repo", "repo", activity = "2026-01-02T00:00:00Z")),
            listOf(Workspace("one", "Review"), Workspace("two", "Build")), SessionGrouping.WORKSPACE)
        assertEquals(listOf("Build", "Review"), groups.map { it.title })
    }

    @Test fun projectGroupsAndRowsFollowTheirNewestActivity() {
        val groups = groupSessions(listOf(
            pane("a-old", "one", "/a", "a", activity = "2026-01-01T00:00:00Z"),
            pane("b-old", "two", "/b", "b", activity = "2026-01-02T00:00:00Z"),
            pane("b-new", "two", "/b", "b", activity = "2026-01-05T00:00:00Z"),
            pane("a-new", "one", "/a", "a", activity = "2026-01-03T00:00:00Z"),
        ), emptyList(), SessionGrouping.PROJECT)

        assertEquals(listOf("project:b", "project:a"), groups.map { it.key })
        assertEquals(listOf("b-new", "b-old"), groups[0].panes.map { it.id })
        assertEquals(listOf("a-new", "a-old"), groups[1].panes.map { it.id })
    }

    @Test fun workspaceRowsCompareInstantsAndKeepUnknownActivityStableAtTheBottom() {
        val groups = groupSessions(listOf(
            pane("missing", "one", "/repo"),
            pane("malformed", "one", "/repo", activity = "not-a-timestamp"),
            pane("first-tie", "one", "/repo", activity = "2026-01-03T00:00:00Z"),
            pane("second-tie", "one", "/repo", activity = "2026-01-03T05:30:00+05:30"),
            pane("newest", "one", "/repo", activity = "2026-01-04T00:00:00Z"),
        ), emptyList(), SessionGrouping.WORKSPACE)

        assertEquals(listOf("newest", "first-tie", "second-tie", "missing", "malformed"),
            groups.single().panes.map { it.id })
    }

    @Test fun pathsPreserveCaseAndAmbiguousComponents() {
        val groups = groupSessions(listOf(pane("a", "one", "/App"), pane("b", "one", "/app"),
            pane("c", "one", "/app/link/../src"), pane("d", "one", "/app/src")), emptyList(), SessionGrouping.PROJECT)
        assertEquals(4, groups.size)
        assertEquals("/", sessionDirectory("/"))
    }

    @Test fun activeSessionsAcrossProjectsPrecedeIdleEvenWhenIdleIsNewer() {
        val groups = groupSessions(listOf(
            pane("idle-a", "one", "/a", "a", activity = "2026-01-05T00:00:00Z", status = "idle"),
            pane("working-b", "two", "/b", "b", activity = "2026-01-02T00:00:00Z", status = "working"),
            pane("waiting-a", "one", "/a", "a", activity = "2026-01-01T00:00:00Z", status = "needs_input"),
            pane("done-c", "three", "/c", "c", activity = "2026-01-04T00:00:00Z", status = "done"),
        ), emptyList(), SessionGrouping.PROJECT)

        assertEquals(listOf("working-b", "waiting-a", "done-c", "idle-a"),
            groups.flatMap { it.panes }.map { it.id })
        assertEquals(listOf(0, 0, 1, 2), groups.map { it.priority })
    }

    @Test fun workspaceGroupingSplitsActiveAndIdleMembersWithoutPuttingIdleAboveAnotherWorkspace() {
        val groups = groupSessions(listOf(
            pane("idle-a", "one", "/a", status = "idle"),
            pane("working-b", "two", "/b", status = "working"),
            pane("waiting-a", "one", "/a", status = "needs-input"),
        ), emptyList(), SessionGrouping.WORKSPACE)

        assertEquals(listOf("working-b", "waiting-a", "idle-a"), groups.flatMap { it.panes }.map { it.id })
        assertEquals(listOf("workspace:two", "workspace:one", "workspace:one"), groups.map { it.key })
        assertEquals(groups.size, groups.map { "${it.priority}:${it.key}" }.distinct().size)
    }

    @Test fun groupingPreferenceDefaultsToProjectAndDecodesWorkspace() {
        assertEquals(SessionGrouping.PROJECT, decodeSessionGrouping(null))
        assertEquals(SessionGrouping.PROJECT, decodeSessionGrouping("invalid"))
        assertEquals(SessionGrouping.WORKSPACE, decodeSessionGrouping("workspace"))
    }
}
