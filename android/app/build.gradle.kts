import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The phone app ships with the desktop releases, so it takes its version from package.json.
@Suppress("UNCHECKED_CAST")
val packageJson = groovy.json.JsonSlurper().parse(rootProject.file("../package.json")) as Map<String, Any>
val appVersion = packageJson["version"] as String

// 1.3.0 -> 1030099, 1.3.0-beta.2 -> 1030002: betas sort before their release.
fun versionCodeOf(version: String): Int {
    val (core, pre) = version.split("-", limit = 2).let { it[0] to it.getOrNull(1) }
    val (major, minor, patch) = core.split(".").map { it.toInt() }
    val preNumber = pre?.substringAfterLast(".")?.toIntOrNull()?.coerceIn(0, 98) ?: if (pre == null) 99 else 0
    return ((major * 100 + minor) * 100 + patch) * 100 + preNumber
}

android {
    namespace = "io.github.sbgitcs.usagemonitor"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.sbgitcs.usagemonitor"
        minSdk = 29
        targetSdk = 35
        versionCode = versionCodeOf(appVersion)
        versionName = appVersion
    }

    // Release builds are signed in CI with the key from the repository secrets; every release
    // must use the same key, or installed copies refuse to update.
    val keystore = System.getenv("ANDROID_KEYSTORE_PATH")
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    lint {
        abortOnError = true
        checkReleaseBuilds = false
        disable += setOf("GradleDependency", "NewerVersionAvailable", "OldTargetApi", "AndroidGradlePluginVersion")
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

tasks.withType<Test>().configureEach {
    // Shared with the desktop tests: both sides must derive the same keys.
    systemProperty("phoneVectors", rootProject.file("../test/fixtures/phone-vectors.json").absolutePath)
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.glance:glance-appwidget:1.1.1")
    implementation("androidx.glance:glance-material3:1.1.1")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("com.google.zxing:core:3.5.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// Writes the release APK and latest-android.json (what installed copies read to update) to
// build/dist, for the Release workflow to attach.
tasks.register("releaseBundle") {
    dependsOn("assembleRelease")
    val outDir = layout.buildDirectory.dir("dist")
    val apkFile = layout.buildDirectory.file("outputs/apk/release/app-release.apk")
    val version = appVersion
    val code = versionCodeOf(appVersion)
    doLast {
        val apk = apkFile.get().asFile
        check(apk.exists()) { "No signed release APK; set the ANDROID_KEYSTORE_* variables." }
        val name = "UsageMonitor-$version.apk"
        val dir = outDir.get().asFile.apply { mkdirs() }
        val target = File(dir, name)
        apk.copyTo(target, overwrite = true)
        val sha = MessageDigest.getInstance("SHA-256").digest(target.readBytes()).joinToString("") { "%02x".format(it) }
        File(dir, "latest-android.json").writeText(
            """{"version":"$version","version_code":$code,"file":"$name","sha256":"$sha","size":${target.length()}}""" + "\n"
        )
    }
}
