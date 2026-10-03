package dev.herdr.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DeliveryAdmissionTest {
    @Test fun restoredUncertainReceiptKeepsItsIdentityAndBlocksAnotherDispatch() {
        val first = DeliveryState("first-operation", "uncertain", "Delivery status unavailable", "original prompt")
        val state = RemoteState(deliveries = mapOf("pane" to first))

        assertThrows(IllegalStateException::class.java) {
            state.reserveDelivery("pane", DeliveryState("second-id", "sending", "Sending again", "original prompt"))
        }
        assertEquals(first, state.deliveries["pane"])

        val acknowledged = state.acknowledgeUncertainDelivery("pane")
        assertEquals(first.id, acknowledged.deliveries["pane"]?.id)
        assertEquals(first.draft, acknowledged.deliveries["pane"]?.draft)
        assertEquals("acknowledged", acknowledged.deliveries["pane"]?.status)
        assertEquals("second-id", acknowledged.reserveDelivery("pane",
            DeliveryState("second-id", "sending", "Sending again", "original prompt")).deliveries["pane"]?.id)
    }

    @Test fun pendingReceiptNeedsResolutionAndKnownFailureAllowsAnotherDispatch() {
        val replacement = DeliveryState("next-id", "sending", "Sending")
        for (status in listOf("sending", "running", "unknown")) {
            val state = RemoteState(deliveries = mapOf("pane" to DeliveryState("first-id", status, "Pending")))
            assertThrows(IllegalStateException::class.java) { state.reserveDelivery("pane", replacement) }
        }
        for (status in listOf("failed", "delivered", "acknowledged")) {
            val state = RemoteState(deliveries = mapOf("pane" to DeliveryState("first-id", status, "Resolved")))
            assertEquals(replacement, state.reserveDelivery("pane", replacement).deliveries["pane"])
        }
    }
}
