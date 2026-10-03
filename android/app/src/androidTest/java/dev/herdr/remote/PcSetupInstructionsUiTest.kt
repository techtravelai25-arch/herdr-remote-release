package dev.herdr.remote

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class PcSetupInstructionsUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun setupStepsShowExactPcLinkAndOpenOnlyOnTap() {
        val opened = mutableListOf<String>()
        val url = "https://selfhost.example:8443/setup"
        compose.setContent { HerdrTheme {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                PcSetupInstructions(setupUrl = url, onOpenSetup = { opened += it; true })
            }
        } }

        compose.onNodeWithText("1. Open this link on your Linux PC").assertExists()
        compose.onNodeWithText(url).assertExists()
        compose.onNodeWithText("2. Install the PC companion").assertExists()
        compose.onNodeWithText("3. Generate your pairing QR").assertExists()
        compose.onNodeWithText("herdr-remote pair").assertExists()
        compose.onNodeWithText("Then tap Scan laptop QR on this phone and scan the code on your PC.").assertExists()
        compose.runOnIdle { assertEquals(emptyList<String>(), opened) }

        compose.onNodeWithText("Open PC setup page").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(url), opened) }
    }

    @Test fun missingPortalLinkUsesCommunitySetupPage() {
        val opened = mutableListOf<String>()
        compose.setContent { HerdrTheme {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                PcSetupInstructions(setupUrl = null, onOpenSetup = { opened += it; true })
            }
        } }

        compose.onNodeWithText(COMMUNITY_SETUP_URL).assertExists()
        compose.onNodeWithText("Open PC setup page").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(COMMUNITY_SETUP_URL), opened) }
        compose.onNodeWithText("herdr-remote pair").assertExists()
    }

    @Test fun firstGuidePageIncludesPcSetupInstructions() {
        compose.setContent { HerdrTheme { FirstRunGuide(onDone = {}, initialPage = 0) } }

        compose.onNodeWithText("1. Open this link on your Linux PC").assertExists()
        compose.onNodeWithText(COMMUNITY_SETUP_URL).assertExists()
        compose.onNodeWithText("herdr-remote pair").assertExists()
    }

    @Test fun unavailableBrowserKeepsThePcAddressAndShowsRecovery() {
        val url = "https://selfhost.example/setup"
        compose.setContent { HerdrTheme {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                PcSetupInstructions(setupUrl = url, onOpenSetup = { false })
            }
        } }
        compose.onNodeWithText("Open PC setup page").performScrollTo().performClick()
        compose.onNodeWithText("No browser is available on this phone. Open the address above on your PC.").assertExists()
        compose.onNodeWithText(url).assertExists()
    }
}
