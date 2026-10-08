package dev.herdr.remote

import java.net.URI

/** Recognises preview links; the laptop independently authorizes and resolves every target. */
internal fun localHtmlTarget(value: String): String? {
    if (value.any { it.isISOControl() }) return null
    val target = value.removePrefix("<").removeSuffix(">").trim()
    if (target.isEmpty() || target.length > 4096 || target.any { it.isISOControl() } || '\\' in target) return null
    val uri = runCatching { URI(target.replace(" ", "%20")) }.getOrNull() ?: return null
    if (uri.userInfo != null) return null
    if (uri.scheme?.lowercase() in setOf("http", "https")) {
        return target.takeIf { uri.scheme.equals("http", true) &&
            uri.host?.lowercase() in setOf("localhost", "127.0.0.1", "[::1]", "::1") && uri.port in 1024..65535 }
    }
    if (uri.scheme != null && !uri.scheme.equals("file", true)) return null
    if (uri.rawAuthority != null && uri.rawAuthority != "" && uri.rawAuthority != "localhost") return null
    val path = uri.path ?: return null
    if (path.split('/').any { it == ".." } || !Regex("(?i)\\.html?(?::\\d+)?$").containsMatchIn(path)) return null
    return target
}

internal fun isHtmlFile(name: String): Boolean = name.substringBefore('?').substringBefore('#')
    .lowercase().let { it.endsWith(".html") || it.endsWith(".htm") }

internal fun safeTranscriptLink(value: String): String? = localHtmlTarget(value) ?: safeWebLink(value)

private val localHtmlPattern = Regex("""(?<![\w:/])(?:file://(?:localhost)?/|/|\./)?[\w.%~@+/-]+\.html?(?::\d+)?(?:\#[\w.-]+)?(?![\w.])""", RegexOption.IGNORE_CASE)

/** Includes local HTML without changing the displayed text or matching inside an ordinary web URL. */
internal fun transcriptLinkRanges(text: String): List<UrlSpan> {
    val web = rawUrlRanges(text)
    val local = localHtmlPattern.findAll(text).mapNotNull { match ->
        val start = match.range.first
        val end = match.range.last + 1
        if (web.any { start < it.endExclusive && end > it.start } || localHtmlTarget(match.value) == null) null
        else UrlSpan(start, end)
    }
    return (web + local).sortedBy { it.start }
}
