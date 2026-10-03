package dev.herdr.remote

import android.app.Application
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Exercises selection and asynchronous review responses without contacting a laptop. */
class ReviewStateRegressionTest {
    private val paneA = Pane("review-a", "workspace", kind = "codex")
    private val paneB = Pane("review-b", "workspace", kind = "codex")
    private val oldReview = Json.parseToJsonElement("""{"available":true,"status":"OLD_PROJECT"}""").jsonObject
    private val newReview = Json.parseToJsonElement("""{"available":true,"status":"CURRENT_PROJECT"}""").jsonObject

    private fun onMain(block: () -> Unit) = InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    @Suppress("UNCHECKED_CAST")
    private fun withModel(respond: () -> Pair<Int, String>, block: (RemoteModel) -> Unit) {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val store = ViewModelStore()
        lateinit var model: RemoteModel
        onMain {
            model = ViewModelProvider(store, ViewModelProvider.AndroidViewModelFactory.getInstance(app))[RemoteModel::class.java]
            val client = OkHttpClient.Builder().addInterceptor { chain ->
                val (code, body) = respond()
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                    .code(code).message("Fixture").body(body.toResponseBody()).build()
            }.build()
            // Every request terminates in the interceptor; credentials and the host are fixtures.
            RemoteModel::class.java.getDeclaredField("bridge").apply { isAccessible = true }
                .set(model, Bridge(Credentials("https://review.invalid", "", "fixture-phone"), injectedClient = client))
            val state = RemoteModel::class.java.getDeclaredField("_state").apply { isAccessible = true }
                .get(model) as MutableStateFlow<RemoteState>
            state.value = RemoteState(online = true, selectedId = paneA.id, review = oldReview,
                snapshot = Snapshot(herdrOnline = true, panes = listOf(paneA, paneB)))
        }
        try { block(model) }
        finally { onMain { store.clear() } }
    }

    private fun awaitSettled(model: RemoteModel) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (model.state.value.busy && System.nanoTime() < deadline) Thread.sleep(10)
        assertFalse("Review fixture request should finish", model.state.value.busy)
    }

    @Test fun switchingSessionClearsPreviousResultsAndLoadsTheCurrentProject() =
        withModel({ 200 to newReview.toString() }) { model ->
            onMain { model.select(paneB.id) }
            assertNull("Pane A's review must not appear in B", model.state.value.review)
            assertFalse(model.state.value.reviewLoading)
            onMain { model.loadReview(paneB.id) }
            awaitSettled(model)
            assertEquals(newReview, model.state.value.review)
            onMain { model.select(null) }
            assertNull(model.state.value.review)
        }

    @Test fun failedRefreshDoesNotKeepAnOldSuccessfulReview() =
        withModel({ 500 to """{"error":{"message":"Fixture review unavailable"}}""" }) { model ->
            onMain { model.loadReview(paneA.id) }
            awaitSettled(model)
            assertNull(model.state.value.review)
            assertFalse(model.state.value.reviewLoading)
            assertEquals("Fixture review unavailable", model.state.value.message)
        }

    @Test fun leavingAndReturningToTheSamePaneDiscardsItsEarlierInFlightReview() {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        withModel({
            started.countDown()
            check(release.await(5, TimeUnit.SECONDS)) { "Fixture was not released" }
            200 to oldReview.toString()
        }) { model ->
            try {
                onMain { model.loadReview(paneA.id) }
                assertTrue("Review request should reach the local interceptor", started.await(5, TimeUnit.SECONDS))
                onMain { model.select(paneB.id); model.select(paneA.id) }
                assertNull(model.state.value.review)
                assertFalse(model.state.value.reviewLoading)
                release.countDown()
                awaitSettled(model)
                assertNull("An old request must not repopulate a revisited pane", model.state.value.review)
                assertFalse(model.state.value.reviewLoading)
            } finally { release.countDown() }
        }
    }
}
