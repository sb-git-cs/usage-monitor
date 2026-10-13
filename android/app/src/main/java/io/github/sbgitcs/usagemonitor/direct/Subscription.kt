package io.github.sbgitcs.usagemonitor.direct

import io.github.sbgitcs.usagemonitor.data.InsightHistory
import io.github.sbgitcs.usagemonitor.model.PlanWindow
import io.github.sbgitcs.usagemonitor.model.Provider

internal fun credentialScope(c: Credential): String = InsightHistory.accountRef(
    "${c.provider}|${c.origin}|${c.subscriptionRegime}|${c.accountId ?: c.userId ?: c.account ?: c.accessToken}")

/** One authoritative shared total; never add percentages or borrow Cursor's monthly allowance. */
internal fun consolidateSubscription(providers: List<Provider>, regime: String, now: Long): List<Provider> {
    if (regime != "combined" || providers.any { it.id == "x_subscription" }) return providers
    val readers = providers.filter { it.id in setOf("grok", "cursor") }.sortedBy { if (it.id == "grok") 0 else 1 }
    fun verified(p: Provider): Boolean = p.sharedWeekly?.let { it.usedPct != null && it.usedPct.isFinite() && it.usedPct >= 0 && (it.resetsAt ?: 0) > now && p.state in setOf("ok", "stale") } == true
    val reader = readers.firstOrNull { verified(it) && it.state == "ok" } ?: readers.firstOrNull { verified(it) } ?: readers.firstOrNull()
    val weekly = reader?.sharedWeekly?.takeIf { reader != null && verified(reader) }
    val meter = Provider("x_subscription", "X Subscription", "Shared weekly pool", if (weekly != null || reader?.state == "stale") reader!!.state else "unknown",
        if (weekly == null) {
            if (reader?.state == "stale") "Stale reading · shared weekly usage unavailable. Open the usage dashboard."
            else "Shared weekly usage unavailable. Open the usage dashboard."
        } else reader?.hint,
        listOf(weekly ?: PlanWindow("weekly", "Weekly", null, null, null, null)) + reader?.windows.orEmpty()
            .filter { it.kind == "credits" }.map { it.copy(label = it.label.replaceFirst("Credits", "Additional Usage")) },
        account = reader?.account, source = reader?.source ?: providers.firstOrNull()?.source ?: "phone", fetchedAt = reader?.fetchedAt,
        subscriptionRegime = "combined", accountId = reader?.accountId, cacheScope = reader?.cacheScope, poolReader = reader?.id ?: "grok")
    val out = providers.filter { it.id !in setOf("grok", "cursor") }.toMutableList()
    out.add(minOf(3, out.size), meter)
    return out
}
