package dev.herdr.remote

import android.animation.ValueAnimator
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.ModeComment
import androidx.compose.material.icons.outlined.PauseCircleOutline
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState

internal enum class DashboardStatus(val label: String, val icon: ImageVector) {
    WORKING("Working", Icons.Outlined.HourglassEmpty),
    WAITING("Waiting for reply", Icons.Outlined.ModeComment),
    BLOCKED("Blocked", Icons.Outlined.PauseCircleOutline),
    DONE("Done", Icons.Outlined.CheckCircle),
    ERROR("Error", Icons.Outlined.ErrorOutline),
    IDLE("Idle", Icons.Outlined.RadioButtonUnchecked),
    UNKNOWN("Status unavailable", Icons.Outlined.Info),
}

/** Idle is not completion; only an explicit done state earns a checkmark. */
internal fun dashboardStatus(raw: String): DashboardStatus = when (raw.lowercase()) {
    "working" -> DashboardStatus.WORKING
    "needs_input", "needs-input" -> DashboardStatus.WAITING
    "blocked" -> DashboardStatus.BLOCKED
    "done" -> DashboardStatus.DONE
    "error" -> DashboardStatus.ERROR
    "idle" -> DashboardStatus.IDLE
    else -> DashboardStatus.UNKNOWN
}

internal fun dashboardStatusLabel(raw: String): String {
    val status = dashboardStatus(raw)
    return if (status == DashboardStatus.UNKNOWN && raw.isNotBlank())
        raw.replace('_', ' ').replace('-', ' ').replaceFirstChar { it.titlecase() }
    else status.label
}

internal data class DashboardStatusColors(val container: Color, val foreground: Color)
internal fun dashboardStatusColors(status: DashboardStatus, scheme: ColorScheme, stale: Boolean = false): DashboardStatusColors =
    if (stale) DashboardStatusColors(scheme.surfaceContainerHigh, scheme.onSurfaceVariant)
    else when (status) {
        DashboardStatus.WORKING, DashboardStatus.DONE -> DashboardStatusColors(scheme.tertiaryContainer, scheme.onTertiaryContainer)
        DashboardStatus.WAITING, DashboardStatus.BLOCKED -> DashboardStatusColors(scheme.primaryContainer, scheme.onPrimaryContainer)
        DashboardStatus.ERROR -> DashboardStatusColors(scheme.errorContainer, scheme.onErrorContainer)
        else -> DashboardStatusColors(scheme.surfaceContainerHigh, scheme.onSurfaceVariant)
    }

/** Native indeterminate motion only for currently observed work on the foreground screen. */
@Composable internal fun DashboardStatusBadge(raw: String, stale: Boolean = false) {
    val status = dashboardStatus(raw)
    val colors = dashboardStatusColors(status, MaterialTheme.colorScheme, stale)
    val preview = LocalInspectionMode.current
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val animate = status == DashboardStatus.WORKING && !stale && !preview &&
        lifecycleState == Lifecycle.State.RESUMED && ValueAnimator.areAnimatorsEnabled()
    Surface(color = colors.container, contentColor = colors.foreground, shape = RoundedCornerShape(6.dp)) {
        Row(Modifier.padding(horizontal = 7.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            if (animate) CircularProgressIndicator(Modifier.size(14.dp).clearAndSetSemantics {},
                color = colors.foreground, strokeWidth = 1.5.dp, trackColor = Color.Transparent)
            else Icon(status.icon, null, Modifier.size(14.dp))
            Text(if (stale) "Last known · ${dashboardStatusLabel(raw)}" else dashboardStatusLabel(raw), style = MaterialTheme.typography.labelMedium)
        }
    }
}
