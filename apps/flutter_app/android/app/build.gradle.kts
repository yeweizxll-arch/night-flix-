import java.util.Properties
import java.util.Base64
import java.net.URI

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val signingProperties = Properties()
val signingPath = System.getenv("NIGHTFLIX_SIGNING_PROPERTIES")
if (!signingPath.isNullOrBlank()) {
    file(signingPath).inputStream().use { signingProperties.load(it) }
}
val isReleaseBuild = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }
val dartDefines = (project.findProperty("dart-defines") as? String ?: "")
    .split(",").filter { it.isNotBlank() }.associate {
        val pair = String(Base64.getDecoder().decode(it)).split("=", limit = 2)
        pair[0] to pair.getOrElse(1) { "" }
    }

android {
    namespace = "com.nightflix.template"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.nightflix.template"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.create("tenantRelease") {
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
                storeFile = signingProperties.getProperty("storeFile")?.let { file(it) }
                storePassword = signingProperties.getProperty("storePassword")
            }
            // Internal APKs must stay installable until plugin keep rules are audited.
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
    if (isReleaseBuild) {
        require(!signingPath.isNullOrBlank()) { "NIGHTFLIX_SIGNING_PROPERTIES is required for release" }
        require(signingProperties.getProperty("applicationId") == defaultConfig.applicationId) {
            "The signing profile belongs to another tenant application"
        }
        require(defaultConfig.applicationId != "com.nightflix.template") { "A tenant applicationId is required" }
        for (key in listOf("keyAlias", "keyPassword", "storeFile", "storePassword")) {
            require(!signingProperties.getProperty(key).isNullOrBlank()) { "Incomplete signing profile" }
        }
        require(signingProperties.getProperty("keyAlias") != "androiddebugkey") { "Debug signing is forbidden for release" }
        val api = URI(dartDefines["API_BASE_URL"] ?: "")
        require(api.scheme == "https" && !api.host.isNullOrBlank() && api.userInfo == null) {
            "Release requires a real HTTPS API_BASE_URL"
        }
        require(dartDefines["DEMO_MODE"] != "true") { "Demo mode is forbidden for release" }
        val manifest = file("src/main/AndroidManifest.xml").readText()
        require(!manifest.contains("ca-app-pub-3940256099942544")) { "Release requires the tenant AdMob App ID" }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
    implementation("com.google.mlkit:text-recognition-japanese:16.0.1")
    implementation("com.google.mlkit:text-recognition-korean:16.0.1")
    implementation("com.google.mlkit:text-recognition-devanagari:16.0.1")
}
