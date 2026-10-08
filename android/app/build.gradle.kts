import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}
if (providers.gradleProperty("renderPreviews").isPresent) {
    layout.buildDirectory.set(layout.projectDirectory.dir("build-previews"))
    apply(plugin = "app.cash.paparazzi")
}
// Empty endpoints produce a self-hosted QR-only build with no cloud requests.
fun endpointProperty(name: String, originOnly: Boolean): String {
    val raw = providers.gradleProperty(name).orElse("").get().trim()
    if (raw.isEmpty()) return ""
    val uri = URI(raw)
    require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawFragment == null && uri.rawQuery == null) { "$name must be an HTTPS URL without credentials, query, or fragment" }
    require(!originOnly || uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") { "$name must be an origin without a path" }
    require(raw.none { it == '"' || it == '\\' || it.isISOControl() }) { "$name contains invalid characters" }
    return if (originOnly) raw.trimEnd('/') else raw
}
val portalOrigin = endpointProperty("herdrPortalOrigin", true)
val updateOrigin = endpointProperty("herdrUpdateOrigin", true)
val downloadUrl = endpointProperty("herdrDownloadUrl", false).ifEmpty {
    "https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest"
}
val releaseKey = providers.gradleProperty("herdrReleaseKeystore").orElse(providers.environmentVariable("HERDR_RELEASE_KEYSTORE")).orNull
val distributionNotices = tasks.register<Sync>("distributionNotices") {
    from(rootProject.projectDir.parentFile) { include("LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"); include("third-party-licenses/**") }
    into(layout.buildDirectory.dir("generated/distribution-notices"))
}
android {
    namespace = "dev.herdr.remote"
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/distribution-notices"))
    compileSdk = 36
    defaultConfig { applicationId = "dev.herdr.remote.community"; minSdk = 26; targetSdk = 36; versionCode = 69; versionName = "0.8.34"; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner" }
    defaultConfig {
        buildConfigField("String", "PORTAL_ORIGIN", "\"$portalOrigin\"")
        buildConfigField("String", "UPDATE_ORIGIN", "\"$updateOrigin\"")
        buildConfigField("String", "DOWNLOAD_URL", "\"$downloadUrl\"")
    }
    if (releaseKey != null) signingConfigs.create("release") {
        storeFile = file(releaseKey)
        storePassword = providers.environmentVariable("HERDR_RELEASE_STORE_PASSWORD").get()
        keyAlias = providers.environmentVariable("HERDR_RELEASE_KEY_ALIAS").get()
        keyPassword = providers.environmentVariable("HERDR_RELEASE_KEY_PASSWORD").get()
    }
    providers.gradleProperty("herdrDebugKeystore").orNull?.let { keyPath ->
        signingConfigs.getByName("debug") {
            storeFile = file(keyPath)
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    if (providers.gradleProperty("renderPreviews").isPresent) sourceSets.getByName("test").java.srcDir("src/previewTest/java")
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildTypes {
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-dev" }
        release {
            isDebuggable = false
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseKey != null) signingConfig = signingConfigs.getByName("release")
        }
    }
}
dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation(platform("androidx.compose:compose-bom:2025.04.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-dnsoverhttps:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.04.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}

tasks.named("preBuild").configure { dependsOn(distributionNotices) }
