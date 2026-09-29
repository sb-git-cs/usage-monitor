package io.github.sbgitcs.usagemonitor.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings as AndroidSettings
import io.github.sbgitcs.usagemonitor.AppState
import io.github.sbgitcs.usagemonitor.BuildConfig
import io.github.sbgitcs.usagemonitor.alerts.Notifications
import io.github.sbgitcs.usagemonitor.data.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Installs new releases from GitHub, the way the desktop app does: each release carries
 * UsageMonitor-<version>.apk and latest-android.json. The APK must match the manifest's SHA-256
 * and be signed with the same key as this app before it is handed to the system installer.
 * The first update needs one tap; from Android 12 on, later ones install without asking.
 */
object Updater {
    private const val REPO = "sb-git-cs/usage-monitor"
    private const val API = "https://api.github.com/repos/$REPO"
    private const val MAX_APK = 300L * 1024 * 1024

    sealed class Result {
        object UpToDate : Result()
        data class Installing(val version: String) : Result()
        object NeedsPermission : Result()
        data class Failed(val message: String) : Result()
    }

    /** Blocking; call it from a worker or an IO coroutine. */
    fun check(context: Context, settings: Settings, interactive: Boolean): Result {
        settings.lastUpdateCheck = System.currentTimeMillis()
        val result = runCatching { run(context, settings, interactive) }.getOrElse { Result.Failed(it.message ?: it.toString()) }
        settings.updateStatus = when (result) {
            Result.UpToDate -> "Up to date"
            is Result.Installing -> "Installing ${result.version}"
            Result.NeedsPermission -> "Allow Usage Monitor to install updates"
            is Result.Failed -> "Update failed: ${result.message}"
        }
        return result
    }

    private fun run(context: Context, settings: Settings, interactive: Boolean): Result {
        val release = latestRelease(settings.updateChannel == "beta") ?: return Result.UpToDate
        val assets = release.optJSONArray("assets") ?: JSONArray()
        val manifestUrl = assetUrl(assets, "latest-android.json") ?: return Result.UpToDate
        val manifest = UpdateManifest.parse(String(download(manifestUrl, 64 * 1024), Charsets.UTF_8))
            ?: return Result.Failed("The release's latest-android.json could not be read.")
        if (manifest.versionCode <= BuildConfig.VERSION_CODE) return Result.UpToDate
        val apkUrl = assetUrl(assets, manifest.file) ?: return Result.Failed("The release has no ${manifest.file}.")

        if (!context.packageManager.canRequestPackageInstalls()) {
            askForInstallPermission(context, interactive)
            return Result.NeedsPermission
        }

        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val apk = File(dir, manifest.file)
        downloadTo(apkUrl, apk, manifest.size)
        val sha = MessageDigest.getInstance("SHA-256").digest(apk.readBytes()).joinToString("") { "%02x".format(it) }
        if (sha != manifest.sha256) {
            apk.delete()
            return Result.Failed("The download did not match its checksum.")
        }
        verifySignature(context, apk)?.let {
            apk.delete()
            return Result.Failed(it)
        }
        install(context, apk)
        return Result.Installing(manifest.version)
    }

    private fun latestRelease(beta: Boolean): JSONObject? {
        if (!beta) return JSONObject(String(download("$API/releases/latest", 2 * 1024 * 1024), Charsets.UTF_8))
        val list = JSONArray(String(download("$API/releases?per_page=15", 4 * 1024 * 1024), Charsets.UTF_8))
        return (0 until list.length()).map { list.getJSONObject(it) }
            .filter { !it.optBoolean("draft") && it.optString("tag_name").isNotEmpty() }
            .maxWithOrNull { a, b -> Versions.compare(a.getString("tag_name"), b.getString("tag_name")) }
    }

    private fun assetUrl(assets: JSONArray, name: String): String? =
        (0 until assets.length()).map { assets.getJSONObject(it) }
            .firstOrNull { it.optString("name") == name }
            ?.optString("browser_download_url")
            ?.takeIf { it.startsWith("https://github.com/") }

    private fun open(url: String): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "usage-monitor-android/${BuildConfig.VERSION_NAME}")
        conn.setRequestProperty("Accept", if (url.startsWith(API)) "application/vnd.github+json" else "application/octet-stream")
        if (conn.responseCode != 200) {
            val status = conn.responseCode
            conn.disconnect()
            throw IOException("GitHub answered HTTP $status.")
        }
        return conn
    }

    private fun download(url: String, limit: Long): ByteArray {
        val conn = open(url)
        try {
            val bytes = conn.inputStream.use { it.readBytes() }
            if (bytes.size > limit) throw IOException("Unexpectedly large answer from GitHub.")
            return bytes
        } finally {
            conn.disconnect()
        }
    }

    private fun downloadTo(url: String, target: File, expected: Long) {
        val conn = open(url)
        try {
            var total = 0L
            conn.inputStream.use { input ->
                target.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_APK || total > expected) throw IOException("The download is larger than announced.")
                        out.write(buf, 0, n)
                    }
                }
            }
            if (total != expected) throw IOException("The download stopped early.")
        } finally {
            conn.disconnect()
        }
    }

    /** Null when the APK is this app, newer, and signed with the same key; otherwise why not. */
    @Suppress("DEPRECATION")
    private fun verifySignature(context: Context, apk: File): String? {
        val pm = context.packageManager
        val archive = pm.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)
            ?: return "The downloaded file is not a valid app."
        val installed = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        if (archive.packageName != context.packageName) return "The downloaded app is a different app."
        if (archive.longVersionCode <= installed.longVersionCode) return "The downloaded app is not newer."
        val a = signers(archive)
        if (a.isEmpty() || a != signers(installed)) return "The download is signed with a different key, so it was not installed."
        return null
    }

    private fun signers(info: PackageInfo): Set<String> =
        info.signingInfo?.apkContentsSigners?.map { sig ->
            MessageDigest.getInstance("SHA-256").digest(sig.toByteArray()).joinToString("") { "%02x".format(it) }
        }?.toSet() ?: emptySet()

    private fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) params.setRequestUpdateOwnership(true)
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(context, InstallReceiver::class.java).setAction(InstallReceiver.ACTION)
            val pending = PendingIntent.getBroadcast(context, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(pending.intentSender)
        }
    }

    private fun askForInstallPermission(context: Context, interactive: Boolean) {
        val intent = Intent(AndroidSettings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (interactive && AppState.foreground) {
            context.startActivity(intent)
            return
        }
        val tap = PendingIntent.getActivity(context, 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        Notifications.show(context, Notifications.UPDATES, 2001, "A Usage Monitor update is ready", "Allow Usage Monitor to install updates, then it installs new versions on its own.", tap)
    }
}
