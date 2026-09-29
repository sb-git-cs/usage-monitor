package io.github.sbgitcs.usagemonitor.net

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

/** Billing cycle arithmetic for the mobile data plan. */
object DataPlan {
    /** Start of the billing cycle containing [now]; a billing day past the end of a month means its last day. */
    fun cycleStart(billingDay: Int, now: ZonedDateTime): ZonedDateTime {
        val day = billingDay.coerceIn(1, 31)
        fun startIn(month: LocalDate): ZonedDateTime =
            month.withDayOfMonth(minOf(day, month.lengthOfMonth())).atStartOfDay(now.zone)
        val thisMonth = startIn(now.toLocalDate().withDayOfMonth(1))
        return if (!now.isBefore(thisMonth)) thisMonth else startIn(now.toLocalDate().withDayOfMonth(1).minusMonths(1))
    }

    fun cycleEnd(billingDay: Int, now: ZonedDateTime): ZonedDateTime {
        val start = cycleStart(billingDay, now)
        val next = start.toLocalDate().withDayOfMonth(1).plusMonths(1)
        return next.withDayOfMonth(minOf(billingDay.coerceIn(1, 31), next.lengthOfMonth())).atStartOfDay(now.zone)
    }

    fun dayStart(now: ZonedDateTime): ZonedDateTime = now.toLocalDate().atStartOfDay(now.zone)

    /** Straight-line projection of the cycle's use to its end, in bytes. */
    fun projected(used: Long, billingDay: Int, now: ZonedDateTime): Long {
        val start = cycleStart(billingDay, now).toInstant().toEpochMilli()
        val end = cycleEnd(billingDay, now).toInstant().toEpochMilli()
        val elapsed = (now.toInstant().toEpochMilli() - start).coerceAtLeast(60 * 60_000L)
        return (used.toDouble() * (end - start) / elapsed).toLong()
    }

    fun zone(): ZoneId = ZoneId.systemDefault()
}
