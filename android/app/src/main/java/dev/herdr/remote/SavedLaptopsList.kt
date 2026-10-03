package dev.herdr.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable internal fun SavedLaptopsList(
    laptops: List<SavedLaptopChoice>, enabled: Boolean,
    connect: (String) -> Unit, rename: (String, String) -> Unit, forget: (String) -> Unit, rotate: (String) -> Unit = {},
) {
    var editing by remember(laptops) { mutableStateOf<SavedLaptopChoice?>(null) }
    var forgetting by remember(laptops) { mutableStateOf<SavedLaptopChoice?>(null) }
    var label by remember(editing?.deviceId) { mutableStateOf(editing?.label.orEmpty()) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Saved on this phone", style = MaterialTheme.typography.titleLarge)
        laptops.forEach { laptop ->
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(laptop.label, style = MaterialTheme.typography.titleMedium)
                    Text("Encrypted relay · ${if (laptop.current) "Selected" else if (laptop.accountLinked) "Linked to your account" else "QR pairing"}", style = MaterialTheme.typography.bodySmall)
                    OutlinedButton(onClick = { connect(laptop.deviceId) }, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(if (laptop.current) "Reconnect" else "Connect")
                    }
                    TextButton(onClick = { rotate(laptop.deviceId) }, enabled = enabled) { Text("Renew connection security") }
                    Row {
                        TextButton(onClick = { editing = laptop }, enabled = enabled) { Text("Rename") }
                        TextButton(onClick = { forgetting = laptop }, enabled = enabled) { Text("Forget") }
                    }
                }
            }
        }
    }
    editing?.let { laptop ->
        AlertDialog(onDismissRequest = { editing = null }, title = { Text("Name this laptop") },
            text = { OutlinedTextField(label, { if (it.length <= 80) label = it }, label = { Text("Name on this phone") }, singleLine = true) },
            confirmButton = { TextButton(onClick = { rename(laptop.deviceId, label); editing = null }, enabled = runCatching { normalizeLaptopLabel(label) }.isSuccess) { Text("Save") } },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } })
    }
    forgetting?.let { laptop ->
        AlertDialog(onDismissRequest = { forgetting = null }, title = { Text("Forget ${laptop.label}?") },
            text = { Text("Removes this pairing from this phone. Scan a fresh QR to reconnect. This does not revoke the phone on your laptop or delete its cloud registration.") },
            confirmButton = { TextButton(onClick = { forget(laptop.deviceId); forgetting = null }) { Text("Forget pairing") } },
            dismissButton = { TextButton(onClick = { forgetting = null }) { Text("Cancel") } })
    }
}
