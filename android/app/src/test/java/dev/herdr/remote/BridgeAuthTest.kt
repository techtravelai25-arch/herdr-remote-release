package dev.herdr.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeAuthTest {
    @Test fun onlyReadObservationRefreshesAStalePortalGrant() {
        assertTrue(shouldRefreshGrant("GET", 401, true))
        assertFalse(shouldRefreshGrant("POST", 401, true))
        assertFalse(shouldRefreshGrant("DELETE", 401, true))
        assertFalse(shouldRefreshGrant("GET", 403, true))
        assertFalse(shouldRefreshGrant("GET", 401, false))
    }
}
