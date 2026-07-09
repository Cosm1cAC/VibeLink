package com.vibelink.app.ui.screens

import com.vibelink.app.network.LiveCallEvent
import kotlin.test.Test
import kotlin.test.assertEquals

class LiveCallQaReducerTest {
    @Test
    fun routesAgentEventsToTheMatchingQuestionWhenQuestionsOverlap() {
        var pairs = emptyList<QaPair>()

        pairs = LiveCallQaReducer.reduce(
            pairs,
            LiveCallEvent(
                id = "question-1",
                cursor = 10,
                type = "live_call.question.detected",
                text = "First question?",
                questionId = "question-1",
            ),
        )
        pairs = LiveCallQaReducer.reduce(
            pairs,
            LiveCallEvent(
                id = "question-2",
                cursor = 11,
                type = "live_call.question.detected",
                text = "Second question?",
                questionId = "question-2",
            ),
        )
        pairs = LiveCallQaReducer.reduce(
            pairs,
            LiveCallEvent(
                id = "thinking-1",
                cursor = 12,
                type = "live_call.agent.thinking",
                question = "First question?",
                questionId = "question-1",
                taskId = "task-1",
            ),
        )
        pairs = LiveCallQaReducer.reduce(
            pairs,
            LiveCallEvent(
                id = "delta-1",
                cursor = 13,
                type = "live_call.agent.delta",
                text = "Answer ",
                questionId = "question-1",
                taskId = "task-1",
            ),
        )
        pairs = LiveCallQaReducer.reduce(
            pairs,
            LiveCallEvent(
                id = "done-1",
                cursor = 14,
                type = "live_call.agent.done",
                text = "Answer one.",
                questionId = "question-1",
                taskId = "task-1",
            ),
        )

        assertEquals("First question?", pairs[0].question)
        assertEquals("Answer one.", pairs[0].answer)
        assertEquals("done", pairs[0].agentState)
        assertEquals("Second question?", pairs[1].question)
        assertEquals("", pairs[1].answer)
        assertEquals("idle", pairs[1].agentState)
    }
}
