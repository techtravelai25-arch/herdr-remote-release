package dev.herdr.remote

import okhttp3.HttpUrl.Companion.toHttpUrl

/** Public build configuration. No account tokens or laptop addresses belong here. */
internal object Deployment {
    val portalEnabled get() = BuildConfig.PORTAL_ORIGIN.isNotEmpty()
    val updatesEnabled get() = BuildConfig.UPDATE_ORIGIN.isNotEmpty()
    fun isPortalOrigin(origin: String): Boolean = portalEnabled && origin == BuildConfig.PORTAL_ORIGIN
    fun requireOrigin(value: String): String {
        require(value.isNotEmpty()) { "This feature is not configured in this build." }
        val url = value.toHttpUrl()
        require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.encodedPath == "/" && url.query == null && url.fragment == null) { "Invalid HTTPS service origin." }
        return url.toString().trimEnd('/')
    }
}
