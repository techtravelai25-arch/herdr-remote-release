package dev.herdr.remote

import kotlinx.serialization.json.*

/** An entry of a project directory listing on the laptop. */
data class ArtifactFile(val path: String, val name: String, val size: Long?, val downloadable: Boolean, val isDirectory: Boolean, val id: String?) {
    val extension: String get() = name.substringAfterLast('.', "").lowercase().take(12)
}

data class ProjectDirectory(val directory: String, val parent: String?, val entries: List<ArtifactFile>, val truncated: Boolean, val nextCursor: String? = null) {
    val displayName: String get() = directory.ifBlank { "Project root" }
}

private val credentialSuffix = Regex("""\.(?:pem|key|keystore|jks|p8|p12|pfx|env|token|kdbx|tfvars|gpg|asc|ovpn)$""", RegexOption.IGNORE_CASE)
private val credentialFilename = Regex("""^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys|credentials(?:\..*)?|secrets(?:\..*)?)$""", RegexOption.IGNORE_CASE)
private val opaqueFileId = Regex("project-[a-f0-9]{64}")

/** Belt-and-braces client-side guard matching the bridge's exclusion rules; the laptop never sends such entries. */
fun validateBrowsedEntryName(name: String): Boolean = name.isNotEmpty() && !name.startsWith(".") &&
    '/' !in name && '\\' !in name && name.none { it.code < 0x20 || it.code == 0x7f } &&
    !credentialSuffix.containsMatchIn(name) && !credentialFilename.matches(name)

/** Relative, single-level-safe path inside the project; matching the bridge's own validation. */
private fun validRelativePath(path: String): Boolean = path.isNotEmpty() && !path.startsWith('/') && !path.contains('\\') &&
    path.none { it.code < 0x20 || it.code == 0x7f } &&
    path.split('/').all { it.isNotEmpty() && !it.startsWith(".") && validateBrowsedEntryName(it) }

/** Parse the bridge's bounded /v1/panes/{id}/files response into a ProjectDirectory. */
fun parseProjectFiles(data: JsonObject): ProjectDirectory {
    val directory = (data["directory"] as? JsonPrimitive)?.contentOrNull.orEmpty()
    if (directory.isNotEmpty() && !validRelativePath(directory)) error("The laptop sent an unsafe folder path.")
    val parent = (data["parent"] as? JsonPrimitive)?.contentOrNull
    require(parent == if (directory.isEmpty()) null else directory.substringBeforeLast('/', "")) { "The laptop sent an unsafe parent folder." }
    val truncated = (data["truncated"] as? JsonPrimitive)?.booleanOrNull == true
    val nextCursor = (data["nextCursor"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() && it.length <= 128 }
    val rawEntries = data["entries"] as? JsonArray ?: error("The laptop sent an invalid file list.")
    require(rawEntries.size <= 100) { "The laptop sent too many files at once." }
    val entries = rawEntries.mapNotNull { value ->
        val entry = value as? JsonObject ?: return@mapNotNull null
        val name = (entry["name"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        val path = (entry["path"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        val type = (entry["type"] as? JsonPrimitive)?.contentOrNull
        val isDirectory = type == "directory"
        val id = (entry["id"] as? JsonPrimitive)?.contentOrNull?.takeIf { opaqueFileId.matches(it) }
        val downloadable = (entry["downloadable"] as? JsonPrimitive)?.booleanOrNull == true
        if (!validateBrowsedEntryName(name)) return@mapNotNull null
        if (!validRelativePath(path) || path != if (directory.isEmpty()) name else "$directory/$name") return@mapNotNull null
        if (!isDirectory && type != "file") return@mapNotNull null
        if (isDirectory) ArtifactFile(path, name, size = null, downloadable = false, isDirectory = true, id = null)
        else {
            // A file is openable only when the bridge supplied an opaque download id.
            require(downloadable == (id != null)) { "The laptop sent inconsistent file data." }
            val size = (entry["size"] as? JsonPrimitive)?.longOrNull?.takeIf { it >= 0 }
            ArtifactFile(path, name, size, id != null, isDirectory = false, id = id)
        }
    }
    return ProjectDirectory(directory, parent, entries, truncated, nextCursor)
}

/** Append a bounded "Load more" page to the same folder; any other result replaces the listing. */
internal fun mergeProjectFilesPage(previous: ProjectDirectory?, next: ProjectDirectory, cursor: String?): ProjectDirectory =
    if (cursor != null && previous?.directory == next.directory) {
        val entries = (previous.entries + next.entries).distinctBy { it.path }.take(2000)
        next.copy(entries = entries, truncated = next.truncated || entries.size >= 2000,
            nextCursor = next.nextCursor.takeUnless { entries.size >= 2000 })
    }
    else next
