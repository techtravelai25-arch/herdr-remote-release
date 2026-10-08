# Release-only R8 rules for Herdr Remote.
#
# No app-specific keep rules are needed: manifest components are kept by AGP;
# kotlinx-serialization, OkHttp, Firebase, WorkManager and zxing ship their own
# consumer rules; the app uses no reflection, JNI or @JavascriptInterface.

# Keep file and line numbers so StartupCrashReport traces stay mappable with
# build/outputs/mapping/release/mapping.txt.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Keep app classes in their package (names are still obfuscated) so
# ops/check-apk-linkage.py, which scans Ldev/herdr/remote/ constructors,
# keeps checking the whole app instead of the few manifest-kept classes.
-keeppackagenames dev.herdr.remote
