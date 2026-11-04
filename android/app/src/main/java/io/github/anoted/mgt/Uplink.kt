package io.github.anoted.mgt

import android.util.Log
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject

/**
 * WebSocket uplink to the recorder PC. Same wire protocol as the glasses Web App:
 *  text   {t:"hello"|"batch"|"test"|"log"|"ping"|...}
 *  binary [u8 kind][f64 ts_ms BE][u16 meta_len BE][meta JSON][payload]
 */
class Uplink(private val scope: CoroutineScope, private val onCommand: (String, JSONObject) -> Unit) {
  companion object {
    const val KIND_HEVC = 1
    const val KIND_PCM16 = 2
    const val KIND_JPEG = 3
    const val KIND_PHOTO = 4
    const val KIND_TPUT = 9
    private const val TAG = "MGT:Uplink"
    fun nowMs(): Double = System.currentTimeMillis().toDouble()
  }

  val state = MutableStateFlow("offline")
  val rttMs = MutableStateFlow<Double?>(null)
  var offsetMs: Double? = null
    private set
  private var bestRtt = Double.MAX_VALUE
  private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
  @Volatile private var ws: WebSocket? = null
  @Volatile private var open = false
  private val queue = ConcurrentLinkedQueue<JSONObject>()
  private val queued = AtomicInteger(0)
  val dropped = AtomicLong(0)
  val sentBytes = AtomicLong(0)
  private var url: String = ""
  private var key: String = ""
  private var loopJob: Job? = null
  private var retryMs = 500L
  var helloProvider: () -> JSONObject = { JSONObject() }
  private val pending = HashMap<String, (Double, Double) -> Unit>()
  var tputListener: ((JSONObject) -> Unit)? = null

  fun configure(url: String, key: String) {
    this.url = url.trim()
    this.key = key.trim()
    reconnect()
  }

  fun reconnect() {
    ws?.close(1000, "reconnect")
    ws = null
    open = false
    if (url.isEmpty()) {
      state.value = "no server"
      return
    }
    connect()
    if (loopJob == null) loopJob = scope.launch { pump() }
  }

  private fun fullUrl(): String {
    var u = url
    if (!u.startsWith("ws://") && !u.startsWith("wss://")) {
      u = u.removePrefix("https://").removePrefix("http://")
      u = "wss://$u"
    }
    u = u.trimEnd('/')
    if (!u.endsWith("/ws/ingest")) u += "/ws/ingest"
    return "$u?src=dat&key=${java.net.URLEncoder.encode(key, "UTF-8")}"
  }

  private fun connect() {
    state.value = "connecting"
    val req = try { Request.Builder().url(fullUrl()).build() } catch (e: Exception) { state.value = "bad url"; return }
    val socket = client.newWebSocket(req, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        if (ws !== webSocket) return
        open = true
        retryMs = 500
        state.value = "open"
        sendJson(helloProvider())
      }
      override fun onMessage(webSocket: WebSocket, text: String) {
        val m = try { JSONObject(text) } catch (e: Exception) { return }
        when (m.optString("t")) {
          "pong" -> {
            val t1 = nowMs(); val t0 = m.optDouble("t0"); val rtt = t1 - t0
            val off = m.optDouble("ts") - (t0 + t1) / 2
            rttMs.value = rtt
            if (rtt <= bestRtt * 1.5 || offsetMs == null) { offsetMs = off; bestRtt = minOf(bestRtt, rtt) }
            synchronized(pending) { pending.remove(m.optString("id")) }?.invoke(rtt, off)
          }
          "cmd" -> onCommand(m.optString("cmd"), m.optJSONObject("args") ?: JSONObject())
          "tput_result" -> tputListener?.invoke(m)
        }
      }
      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {}
      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(webSocket)
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        Log.w(TAG, "ws failure: ${t.message}")
        lost(webSocket)
      }
    })
    ws = socket
  }

  private fun lost(webSocket: WebSocket) {
    if (ws !== webSocket) return
    open = false
    state.value = "offline"
    scope.launch {
      delay(retryMs)
      retryMs = minOf(retryMs * 2, 5000)
      if (ws === webSocket) connect()
    }
  }

  fun isOpen() = open

  fun push(item: JSONObject) {
    queue.add(item)
    if (queued.incrementAndGet() > 50_000) {
      repeat(5_000) { queue.poll(); queued.decrementAndGet() }
      dropped.addAndGet(5_000)
    }
  }

  fun sendJson(o: JSONObject): Boolean {
    val s = ws ?: return false
    if (!open) return false
    val txt = o.toString()
    sentBytes.addAndGet(txt.length.toLong())
    return s.send(txt)
  }

  /** Binary frames are dropped (never queued) when the link is down or saturated. */
  fun sendBinary(kind: Int, meta: JSONObject, payload: ByteArray, ts: Double = nowMs()): Boolean {
    val s = ws ?: return false
    if (!open || s.queueSize() > 8L * 1024 * 1024) return false
    val m = meta.toString().toByteArray()
    val bb = ByteBuffer.allocate(11 + m.size + payload.size)
    bb.put(kind.toByte()); bb.putDouble(ts); bb.putShort(m.size.toShort()); bb.put(m); bb.put(payload)
    sentBytes.addAndGet(bb.capacity().toLong())
    return s.send(bb.array().toByteString())
  }

  fun ping(cb: (Double, Double) -> Unit) {
    val id = java.lang.Long.toString(System.nanoTime(), 36)
    synchronized(pending) { pending[id] = cb }
    sendJson(JSONObject().put("t", "ping").put("id", id).put("t0", nowMs()))
  }

  private suspend fun pump() {
    var lastPing = 0L
    while (scope.isActive) {
      delay(100)
      if (open && (ws?.queueSize() ?: 0L) < 4L * 1024 * 1024) {
        while (true) {
          val arr = JSONArray()
          var n = 0
          while (n < 500) { val it = queue.poll() ?: break; queued.decrementAndGet(); arr.put(it); n++ }
          if (n == 0) break
          sendJson(JSONObject().put("t", "batch").put("ts", nowMs()).put("items", arr))
        }
      }
      val now = System.currentTimeMillis()
      if (open && now - lastPing > 2000) {
        lastPing = now
        ping { rtt, off ->
          push(JSONObject().put("s", "sync").put("ts", nowMs()).put("rtt", rtt).put("offset", off).put("best_rtt", bestRtt))
        }
      }
    }
  }

  fun queueLength() = queued.get()
}
