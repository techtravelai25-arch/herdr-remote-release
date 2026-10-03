package dev.herdr.remote

import android.content.Context
import androidx.core.content.edit
import kotlin.random.Random

internal data class AlertCopy(val title: String, val body: String)
internal data class CopyDraw(val index: Int, val remaining: List<Int>)

/** Original, status-specific copy. A reply is not a claim that the task succeeded. */
internal object NotificationCopy {
    private val replies = listOf(
        "Your agent has entered the chat. Again.",
        "The typing bubble has left the building.",
        "Fresh reply. Zero need to refresh obsessively.",
        "Your agent cooked up a reply. Time for a taste test.",
        "Plot twist: there's a new reply.",
        "The side quest has a new message.",
        "Main character, your reply is waiting.",
        "A tiny ping for your very large context window.",
        "Less doomscrolling, more reply scrolling.",
        "Your agent brought words to the function.",
        "The lore just got an update.",
        "Tokenmaxxing intermission. New reply inside.",
        "Your agent's latest take just dropped.",
        "The group project has a new reply.",
        "One notification closer to closing those tabs.",
        "Your agent sent a reply. The ball is in your tab.",
        "A fresh serving of context awaits.",
        "New reply unlocked. Reading is the next level.",
        "The agent has spoken. Your review era begins.",
        "Your agent has a reply. Check in before the next side quest.",
    )
    private val inputs = listOf(
        "Your agent needs input. You're up, main character.",
        "The plot needs a decision from you.",
        "Your agent hit the ask-a-human checkpoint.",
        "A quick answer could move this side quest along.",
        "Your agent needs your take. No mind-reading installed.",
        "The next move needs a human-shaped decision.",
        "Your agent has a question. Cue your entrance.",
        "A small question has entered the chat.",
        "Your agent is waiting. Time for the director's cut.",
        "The ball is in your tab. Your input is needed.",
        "Your agent needs a steer before the next turn.",
        "Human judgment requested. Vibes alone won't do.",
        "Your agent has reached the choose-your-adventure bit.",
        "A question from your agent just dropped.",
        "Your agent needs context only you can supply.",
        "Quick huddle? Your agent is waiting for input.",
        "Your agent called a timeout for your answer.",
        "Your next reply is the missing puzzle piece.",
        "The lore needs clarification. Your agent has a question.",
        "Your agent needs input. This one's a two-player level.",
    )
    const val VARIANT_COUNT = 20
    private val factual = AlertCopy("An agent needs attention", "Open the conversation to review what happened.")

    fun copy(kind: String, index: Int, provider: String? = null): AlertCopy = when (kind) {
        "done" -> AlertCopy("Reply ready", if (index == 19 && provider == "codex")
            "Your agent has a reply. Time to check if Tibo has another reset up his sleeve?"
            else replies[index.mod(VARIANT_COUNT)])
        "needs_input" -> AlertCopy("Your input is needed", inputs[index.mod(VARIANT_COUNT)])
        else -> factual
    }

    /** Refill a shuffled bag only after all 20 choices, excluding a boundary repeat. */
    fun draw(remaining: List<Int>, last: Int?, random: Random = Random.Default): CopyDraw {
        val valid = remaining.distinct().filter { it in 0 until VARIANT_COUNT && it != last }
        val bag = if (valid.isNotEmpty()) valid else {
            val shuffled = (0 until VARIANT_COUNT).shuffled(random).toMutableList()
            if (shuffled.first() == last) {
                val other = random.nextInt(1, shuffled.size)
                val first = shuffled[0]
                shuffled[0] = shuffled[other]
                shuffled[other] = first
            }
            shuffled
        }
        return CopyDraw(bag.first(), bag.drop(1))
    }

    /** Shared by local and cloud delivery; persist the bag before returning the selection. */
    @Synchronized
    fun next(context: Context, kind: String, provider: String? = null): AlertCopy {
        if (kind != "done" && kind != "needs_input") return factual
        val prefs = context.getSharedPreferences("notification_copy_v1", Context.MODE_PRIVATE)
        val remaining = prefs.getString("$kind.remaining", "").orEmpty().split(',').mapNotNull(String::toIntOrNull)
        val last = prefs.getInt("$kind.last", -1).takeIf { it >= 0 }
        val draw = draw(remaining, last)
        prefs.edit(commit = true) {
            putString("$kind.remaining", draw.remaining.joinToString(","))
            putInt("$kind.last", draw.index)
        }
        return copy(kind, draw.index, provider)
    }
}
