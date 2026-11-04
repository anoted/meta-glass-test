import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

val localProperties = Properties().apply {
  val f = rootDir.resolve("local.properties")
  if (f.exists()) f.inputStream().use { load(it) }
}

android {
  namespace = "io.github.anoted.mgt"
  compileSdk = 36

  defaultConfig {
    applicationId = "io.github.anoted.mgt"
    minSdk = 31
    targetSdk = 36
    versionCode = 1
    versionName = "1.0.0"
    // Developer Mode in the Meta AI app: both may stay "0". For release channels, set them in
    // local.properties from your Wearables Developer Center app.
    manifestPlaceholders["mwdat_application_id"] = localProperties.getProperty("mwdat_application_id", "0")
    manifestPlaceholders["mwdat_client_token"] = localProperties.getProperty("mwdat_client_token", "0")
  }

  buildTypes {
    release { isMinifyEnabled = false }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }

val mwdat = "1.0.1"
dependencies {
  implementation("com.meta.wearable:mwdat-core:$mwdat")
  implementation("com.meta.wearable:mwdat-camera:$mwdat")
  implementation("com.meta.wearable:mwdat-inputs:$mwdat")
  implementation("com.meta.wearable:mwdat-motion:$mwdat")
  implementation("com.meta.wearable:mwdat-speech:$mwdat")
  implementation("androidx.activity:activity-ktx:1.13.0")
  implementation("androidx.core:core-ktx:1.16.0")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
