package dev.herdr.remote

import java.io.ByteArrayOutputStream
import kotlinx.serialization.json.*

internal data class ReviewFile(val path: String, val status: String, val previousPath: String? = null) {
    val name: String get() = path.substringAfterLast('/')
    val directory: String get() = path.substringBeforeLast('/', "")
}
internal data class ReviewFiles(val files: List<ReviewFile>, val complete: Boolean)
private fun JsonObject.reviewString(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull

internal fun reviewFiles(data: JsonObject): ReviewFiles {
    val complete = ((data["changedFilesComplete"] as? JsonPrimitive)?.booleanOrNull
        ?: ((data["truncated"] as? JsonPrimitive)?.booleanOrNull != true)) && data.reviewString("statusError").isNullOrBlank()
    val structured = data["changedFiles"] as? JsonArray
    if (structured != null) {
        val files = structured.mapNotNull { value ->
            val file = value as? JsonObject ?: return@mapNotNull null
            val path = file.reviewString("path")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            ReviewFile(path, reviewStatus(file.reviewString("status").orEmpty()), file.reviewString("previousPath"))
        }
        return ReviewFiles(files, complete && files.size == structured.size)
    }
    var parsed = data.reviewString("status") != null
    val files = data.reviewString("status").orEmpty().lineSequence().mapNotNull { line ->
        if (line.isBlank() || line.startsWith("## ")) return@mapNotNull null
        if (line.length < 4 || line[2] != ' ' || line.take(2).any { it !in " MADRCU?!T" }) {
            parsed = false
            return@mapNotNull null
        }
        val code = line.take(2)
        val raw = line.drop(3)
        val isRename = code.any { it == 'R' || it == 'C' }
        val rename = if (isRename) splitRename(raw) else null
        if (isRename && rename == null) { parsed = false; return@mapNotNull null }
        val path = decodeGitPath(rename?.second ?: raw)
        if (path == null || path.isEmpty()) { parsed = false; return@mapNotNull null }
        val previous = rename?.first?.let(::decodeGitPath)
        if (rename != null && previous == null) parsed = false
        ReviewFile(path, reviewStatus(code), previous)
    }.toList()
    return ReviewFiles(files, complete && parsed)
}

private fun splitRename(value: String): Pair<String, String>? {
    var quoted = false
    var escaped = false
    for (i in value.indices) {
        val c = value[i]
        if (escaped) { escaped = false; continue }
        if (c == '\\' && quoted) { escaped = true; continue }
        if (c == '"') quoted = !quoted
        if (!quoted && value.startsWith(" -> ", i)) return value.take(i) to value.drop(i + 4)
    }
    return null
}

/** Decode Git's C-quoted UTF-8 byte paths without interpreting literal unquoted backslashes. */
internal fun decodeGitPath(value: String): String? {
    if (!value.startsWith('"')) return value
    if (!value.endsWith('"') || value.length < 2) return null
    val bytes = ByteArrayOutputStream()
    var i = 1
    while (i < value.lastIndex) {
        val c = value[i++]
        if (c != '\\') {
            val codePoint = value.codePointAt(i - 1)
            bytes.write(String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8))
            i += Character.charCount(codePoint) - 1
            continue
        }
        if (i >= value.lastIndex) return null
        val escaped = value[i++]
        if (escaped in '0'..'7') {
            var octal = escaped.toString()
            repeat(2) { if (i < value.lastIndex && value[i] in '0'..'7') octal += value[i++] }
            bytes.write(octal.toInt(8))
        } else {
            val decoded = when (escaped) {
                'a' -> 7; 'b' -> 8; 't' -> 9; 'n' -> 10; 'v' -> 11; 'f' -> 12; 'r' -> 13
                '\\' -> 92; '"' -> 34; else -> return null
            }
            bytes.write(decoded)
        }
    }
    return bytes.toByteArray().toString(Charsets.UTF_8)
}

internal fun reviewStatus(value: String): String = when {
    value == "conflicted" || value == "unmerged" || value in listOf("DD", "AU", "UD", "UA", "DU", "AA", "UU") -> "Conflicted"
    value == "untracked" || value == "??" -> "Untracked"
    value == "renamed" || 'R' in value.take(2) -> "Renamed"
    value == "copied" || 'C' in value.take(2) -> "Copied"
    value == "deleted" || 'D' in value.take(2) -> "Deleted"
    value == "added" || 'A' in value.take(2) -> "Added"
    value == "typeChanged" || 'T' in value.take(2) -> "Type changed"
    value == "modified" || 'M' in value.take(2) -> "Modified"
    value == "ignored" || value == "!!" -> "Ignored"
    else -> "Changed"
}

/** Keep unusual filename control characters legible on one visual row. */
internal fun reviewDisplayPath(value: String) = value.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
