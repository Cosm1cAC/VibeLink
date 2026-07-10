package com.vibelink.app.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceDiffUtilsTest {
    @Test
    fun splitsAFileDiffIntoIndependentlyApplicableHunks() {
        val diff = """
            diff --git a/notes.txt b/notes.txt
            index 1111111..2222222 100644
            --- a/notes.txt
            +++ b/notes.txt
            @@ -1 +1 @@
            -line 1
            +LINE ONE
            @@ -20 +20 @@
            -line 20
            +LINE TWENTY
        """.trimIndent()

        val hunks = parseWorkspaceDiffHunks(diff)

        assertEquals(2, hunks.size)
        assertEquals("notes.txt", hunks[0].path)
        assertEquals("@@ -1 +1 @@", hunks[0].header)
        assertTrue(hunks[0].patch.contains("+LINE ONE"))
        assertTrue(hunks[0].patch.contains("diff --git a/notes.txt b/notes.txt"))
        assertTrue(hunks[1].patch.contains("+LINE TWENTY"))
        assertTrue(hunks.none { it.patch.contains("+LINE ONE") && it.patch.contains("+LINE TWENTY") })
    }
}
