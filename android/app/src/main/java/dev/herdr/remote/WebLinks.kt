package dev.herdr.remote

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.net.toUri

/** Opens a pre-validated safe http(s) link in the system browser without attaching any credentials. */
fun openWebLink(context: Context, url: String): Boolean {
    val safe = safeWebLink(url) ?: return false
    return try {
        context.startActivity(Intent(Intent.ACTION_VIEW, safe.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: ActivityNotFoundException) { false }
    catch (_: SecurityException) { false }
}
