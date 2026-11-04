package io.github.anoted.mgt

import android.Manifest
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager

class App : Application() {
  override fun onCreate() {
    super.onCreate()
    getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(LinkService.CHANNEL, "Glasses link", NotificationManager.IMPORTANCE_LOW))
    // DAT needs BLUETOOTH_CONNECT; if it was granted on an earlier run, bring the link up immediately
    // so a process restart (or the foreground service) keeps streaming without opening the UI.
    if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) GlassLink.init(this)
  }
}
