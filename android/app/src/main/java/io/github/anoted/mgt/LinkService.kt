package io.github.anoted.mgt

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager

/** Keeps the process (DAT session + uplink) alive while the phone screen is off. */
class LinkService : Service() {
  companion object {
    const val CHANNEL = "link"
    fun start(ctx: Context) = runCatching { ctx.startForegroundService(Intent(ctx, LinkService::class.java)) }
        .onFailure { GlassLink.log("foreground service failed: ${it.message}") }
    fun stop(ctx: Context) = ctx.stopService(Intent(ctx, LinkService::class.java))
  }

  private var wake: PowerManager.WakeLock? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
    val n = Notification.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_fg)
        .setContentTitle("Streaming glasses sensors")
        .setContentText("DAT session active · uplink to recorder PC")
        .setContentIntent(open)
        .setOngoing(true)
        .build()
    startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    if (wake == null) {
      wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mgt:link").apply {
        setReferenceCounted(false); acquire(6 * 60 * 60 * 1000L)
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    wake?.release(); wake = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
