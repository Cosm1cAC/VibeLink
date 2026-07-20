package com.vibelink.app.ui.screens

import kotlin.test.Test
import kotlin.test.assertEquals

class ArtifactDisplayPolicyTest {
    @Test
    fun boundsLargeTablesByDeviceWidthAndProvidesRecoveryCopy() {
        assertEquals(40, ArtifactDisplayPolicy.visibleRows(390, 500))
        assertEquals(120, ArtifactDisplayPolicy.visibleRows(900, 500))
        assertEquals(20, ArtifactDisplayPolicy.visibleRows(900, 20))
        assertEquals("Preview unavailable. Retry after checking the file.", ArtifactDisplayPolicy.fallbackMessage(""))
        assertEquals("Artifact is corrupt", ArtifactDisplayPolicy.fallbackMessage("Artifact is corrupt"))
    }
}
