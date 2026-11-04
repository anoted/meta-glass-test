package io.github.anoted.mgt

import android.content.Context
import android.graphics.Bitmap
import android.os.BatteryManager
import android.os.Build
import android.util.Log
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.removeCamera
import com.meta.wearable.dat.camera.types.AudioCodec
import com.meta.wearable.dat.camera.types.AudioSampleRate
import com.meta.wearable.dat.camera.types.PhotoData
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.DeviceCompatibility
import com.meta.wearable.dat.core.types.DeviceIdentifier
import com.meta.wearable.dat.core.types.DeviceSessionError
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.display.Display
import com.meta.wearable.dat.display.addDisplay
import com.meta.wearable.dat.display.removeDisplay
import com.meta.wearable.dat.display.types.DisplayConfiguration
import com.meta.wearable.dat.display.types.DisplayState
import com.meta.wearable.dat.display.views.Direction
import com.meta.wearable.dat.display.views.TextColor
import com.meta.wearable.dat.display.views.TextStyle
import com.meta.wearable.dat.inputs.Inputs
import com.meta.wearable.dat.inputs.addInputs
import com.meta.wearable.dat.inputs.removeInputs
import com.meta.wearable.dat.inputs.types.InputEvent
import com.meta.wearable.dat.inputs.types.InputsConfiguration
import com.meta.wearable.dat.inputs.types.InputsError
import com.meta.wearable.dat.motion.Motion
import com.meta.wearable.dat.motion.addMotion
import com.meta.wearable.dat.motion.removeMotion
import com.meta.wearable.dat.motion.types.MotionConfiguration
import com.meta.wearable.dat.motion.types.MotionError
import com.meta.wearable.dat.motion.types.MotionSample
import com.meta.wearable.dat.motion.types.MotionSamplingRate
import com.meta.wearable.dat.speech.Speech
import com.meta.wearable.dat.speech.SpeechConfiguration
import com.meta.wearable.dat.speech.addSpeech
import com.meta.wearable.dat.speech.removeSpeech
import java.io.ByteArrayOutputStream
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.sqrt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Process-wide owner of the DAT session and every capability. Streams everything to [uplink].
 */
object GlassLink {
  private const val TAG = "MGT:Link"
  const val VERSION = "1.0.0"

  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  lateinit var app: Context
  private var initialized = false
  val uplink = Uplink(scope) { cmd, args -> onCommand(cmd, args) }

  // ------------------------------------------------------------------ settings
  data class Wanted(
      var camera: Boolean = true,
      var audio: Boolean = true,
      var motion: Boolean = true,
      var motionRate: Int = 60,
      var inputs: Boolean = true,
      var speech: Boolean = false,
      var display: Boolean = true, // status view on the glasses (takes the display from the Web App while the session runs)
      var quality: String = "MEDIUM",
      var fps: Int = 24,
  )
  val wanted = Wanted()

  // ------------------------------------------------------------- observable UI
  val states = MutableStateFlow<Map<String, String>>(emptyMap())
  val device = MutableStateFlow<Map<String, String>>(emptyMap())
  val prompt = MutableStateFlow("")
  val logLines = MutableStateFlow<List<String>>(emptyList())
  val counters = MutableStateFlow<Map<String, Int>>(emptyMap())
  val permissionRequests = MutableSharedFlow<Permission>(extraBufferCapacity = 4)
  /** Something only the user can fix in the Meta AI app; the UI shows it as a banner with a button. */
  enum class Fix { DAT_APP_UPDATE, FIRMWARE_UPDATE }
  data class Action(val fix: Fix?, val text: String)
  val action = MutableStateFlow<Action?>(null)

  // ------------------------------------------------------------- live objects
  private var session: DeviceSession? = null
  private var camera: Camera? = null
  private var motion: Motion? = null
  private var inputs: Inputs? = null
  private var speech: Speech? = null
  private var display: Display? = null
  private var lastDon: DonState? = null
  @Volatile private var lastInputText = "–"
  private val jobs = HashMap<String, Job>()
  private val deviceJobs = HashMap<DeviceIdentifier, Job>()
  private val counts = HashMap<String, Int>()
  private val rateCounts = HashMap<String, Int>()
  val listeners = java.util.concurrent.CopyOnWriteArrayList<(String, JSONObject) -> Unit>() // test runner taps every item

  // video stats
  private var vFrames = 0; private var vBytes = 0L; private var vW = 0; private var vH = 0; private var vTotal = 0

  fun init(ctx: Context) {
    if (initialized) return
    initialized = true
    app = ctx.applicationContext
    val prefs = app.getSharedPreferences("mgt", Context.MODE_PRIVATE)
    uplink.helloProvider = { hello() }
    uplink.configure(prefs.getString("server", "") ?: "", prefs.getString("key", "") ?: "")
    Wearables.initialize(app).onFailure { e, _ -> log("DAT initialize failed: ${e.description}") }
    scope.launch { Wearables.registrationState.collect { setState("registration", it.name) } }
    scope.launch { Wearables.registrationErrorStream.collect { err("registration", it.toString()) } }
    scope.launch { Wearables.devices.collect { ids -> watchDevices(ids) } }
    scope.launch { tickers() }
    log("DAT initialized (devMode=${runCatching { Wearables.isDevMode }.getOrNull()})")
  }

  fun saveConfig(server: String, key: String) {
    app.getSharedPreferences("mgt", Context.MODE_PRIVATE).edit().putString("server", server).putString("key", key).apply()
    uplink.configure(server, key)
  }

  fun config(): Pair<String, String> {
    val p = app.getSharedPreferences("mgt", Context.MODE_PRIVATE)
    return (p.getString("server", "") ?: "") to (p.getString("key", "") ?: "")
  }

  private fun hello() = JSONObject()
      .put("t", "hello").put("src", "dat").put("app", "mgt-android-dat").put("ver", VERSION).put("ts", Uplink.nowMs())
      .put("info", JSONObject().put("model", "${Build.MANUFACTURER} ${Build.MODEL}").put("android", Build.VERSION.RELEASE)
          .put("sdk", Build.VERSION.SDK_INT).put("mwdat", "1.0.1").put("wanted", JSONObject(wanted.toString().substringAfter("(").removeSuffix(")").split(", ").associate { it.substringBefore("=") to it.substringAfter("=") })))

  // ------------------------------------------------------------------ emitters
  fun item(s: String, o: JSONObject = JSONObject()): JSONObject {
    o.put("s", s)
    if (!o.has("ts")) o.put("ts", Uplink.nowMs())
    uplink.push(o)
    counts[s] = (counts[s] ?: 0) + 1
    rateCounts[s] = (rateCounts[s] ?: 0) + 1
    for (l in listeners) l(s, o)
    return o
  }

  fun log(msg: String) {
    Log.i(TAG, msg)
    logLines.value = (listOf("${java.time.LocalTime.now().toString().take(8)} $msg") + logLines.value).take(80)
    uplink.sendJson(JSONObject().put("t", "log").put("level", "info").put("msg", msg).put("ts", Uplink.nowMs()))
  }

  private fun setState(cap: String, st: String) {
    if (states.value[cap] == st) return
    states.value = states.value + (cap to st)
    item("dat_state", JSONObject().put("cap", cap).put("state", st))
  }

  private fun err(cap: String, e: String) {
    states.value = states.value + ("$cap error" to e)
    item("dat_error", JSONObject().put("cap", cap).put("error", e))
    log("$cap error: $e")
  }

  private suspend fun tickers() {
    var n = 0
    while (true) {
      delay(1000)
      n++
      counters.value = HashMap(rateCounts); rateCounts.clear()
      if (vFrames > 0 || camera != null) {
        vLastFps = vFrames
        item("dat_video_stat", JSONObject().put("fps", vFrames).put("kbps", vBytes * 8 / 1000.0).put("w", vW).put("h", vH).put("frames", vTotal))
        vFrames = 0; vBytes = 0
      }
      uplink.sendJson(JSONObject().put("t", "dat_state").put("ts", Uplink.nowMs()).put("states", JSONObject(states.value as Map<*, *>))
          .put("device", JSONObject(device.value as Map<*, *>)).put("queue", uplink.queueLength()).put("dropped", uplink.dropped.get()))
      if (n % 30 == 1) phoneInfo()
    }
  }

  private fun phoneInfo() {
    val bm = app.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    item("phone", JSONObject().put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)).put("charging", bm.isCharging)
        .put("model", "${Build.MANUFACTURER} ${Build.MODEL}"))
  }

  // ------------------------------------------------------------------- devices
  private fun watchDevices(ids: Set<DeviceIdentifier>) {
    (deviceJobs.keys - ids).forEach { deviceJobs.remove(it)?.cancel() }
    item("dat_devices", JSONObject().put("n", ids.size).put("ids", ids.joinToString { it.toString() }))
    ids.forEach { id ->
      deviceJobs.getOrPut(id) {
        scope.launch {
          Wearables.devicesMetadata[id]?.collect { d ->
            val m: Map<String, String> = linkedMapOf<String, String?>(
                "id" to id.toString(), "name" to d.name, "type" to d.deviceType.name, "link" to d.linkState.name, "fw" to d.firmwareInfo,
                "compat" to d.compatibility.name, "thermal" to d.thermalLevel.name, "battery" to d.batteryLevel.toString(),
                "charging" to d.chargingState.name, "don" to d.donState.name, "hinge" to d.hingeState.name, "display" to d.isDisplayCapable().toString()).mapValues { it.value ?: "" }
            device.value = m
            val o = JSONObject(m as Map<*, *>); o.put("battery", d.batteryLevel)
            item("dat_device", o)
            onCompatibility(d.compatibility)
            // Known SDK issue: after doffing and donning with Wear Detection on, Inputs stop until re-added.
            if (lastDon != null && lastDon != DonState.DONNED && d.donState == DonState.DONNED && wanted.inputs && session != null) {
              log("glasses donned again: re-adding Inputs"); setInputs(true)
            }
            lastDon = d.donState
          }
        }
      }
    }
  }

  private fun onCompatibility(c: DeviceCompatibility) {
    when (c) {
      // AutoDeviceSelector only picks COMPATIBLE devices, so these block every session.
      DeviceCompatibility.DEVICE_UPDATE_REQUIRED -> action.value = Action(Fix.FIRMWARE_UPDATE, "The SDK reports the glasses firmware as too old for DAT 1.0.1 (needs v128+). Update the glasses in Meta AI.")
      DeviceCompatibility.SDK_UPDATE_REQUIRED -> action.value = Action(null, "The glasses need a newer DAT SDK than 1.0.1. Rebuild the app with the newest mwdat version.")
      else -> if (action.value?.fix == Fix.FIRMWARE_UPDATE) action.value = null
    }
  }

  /** Each version error means something different; see the DAT "Version Dependencies" guide. */
  private fun onSessionError(e: DeviceSessionError) {
    item("dat_error", JSONObject().put("cap", "session").put("code", e.name).put("error", e.description))
    states.value = states.value + ("session error" to e.name)
    log("session error ${e.name}: ${e.description}")
    when (e) {
      DeviceSessionError.DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED -> action.value = Action(Fix.DAT_APP_UPDATE,
          "The DAT app ON THE GLASSES is out of date (this is separate from the glasses firmware). " +
              "Tap \"Update DAT app on glasses\", or in Meta AI open App Connections and update it. Keep the glasses on, charged above 10%, and Meta AI open.")
      DeviceSessionError.DWA_UNAVAILABLE -> action.value = Action(Fix.DAT_APP_UPDATE,
          "The DAT app on the glasses did not start (not installed or failed to launch). In Meta AI → Settings → App info → Developer Mode, press Install, then retry.")
      DeviceSessionError.INSUFFICIENT_SDK_VERSION -> action.value = Action(null, "The glasses no longer accept DAT SDK 1.0.1. Rebuild with the newest mwdat version.")
      DeviceSessionError.DWA_OUT_OF_STU_RANGE -> log("warning: app and glasses versions are outside the recommended range; the session continues")
      DeviceSessionError.NO_ELIGIBLE_DEVICE -> action.value = Action(null, "No eligible glasses: they must be connected, worn, unfolded, and reported COMPATIBLE (see Device below).")
      else -> {}
    }
  }

  // ------------------------------------------------------------------- session
  fun startSession() {
    if (session != null) { log("session already exists"); return }
    LinkService.start(app)
    Wearables.createSession(AutoDeviceSelector()).fold(
        onSuccess = { s ->
          session = s
          jobs["session.state"] = scope.launch {
            s.state.collect { st ->
              setState("session", st.name)
              if (st == DeviceSessionState.STARTED) { if (action.value?.fix == Fix.DAT_APP_UPDATE) action.value = null; onSessionStarted(s) }
              if (st == DeviceSessionState.STOPPED) cleanupSession()
            }
          }
          jobs["session.err"] = scope.launch { s.errors.collect { onSessionError(it) } }
          s.start()
        },
        onFailure = { e, _ -> onSessionError(e) },
    )
  }

  fun stopSession() {
    session?.stop() ?: cleanupSession()
  }

  private fun cleanupSession() {
    jobs.values.forEach { it.cancel() }; jobs.clear()
    camera = null; motion = null; inputs = null; speech = null; display = null; session = null
    states.value = states.value.filterKeys { it == "registration" || it == "session" || it == "session error" }
    LinkService.stop(app)
  }

  private fun onSessionStarted(s: DeviceSession) {
    if (wanted.display) attachDisplay(s)
    scope.launch {
      if (wanted.camera) attachCamera(s)
      // Motion/Inputs fail with DEVICE_DISCONNECTED if attached before the device is really there;
      // with a camera we wait for STREAMING (see attachCamera); without one, give it a moment.
      if (!wanted.camera) { delay(1500); attachSensors(s) }
    }
  }

  private fun attachSensors(s: DeviceSession) {
    if (wanted.inputs && inputs == null) attachInputs(s)
    if (wanted.motion && motion == null) attachMotion(s, wanted.motionRate)
    if (wanted.speech && speech == null) scope.launch { attachSpeech(s) }
  }

  suspend fun hasPermission(p: Permission): Boolean {
    var ok = false
    Wearables.checkPermissionStatus(p).onSuccess { ok = it == PermissionStatus.Granted }.onFailure { e, _ -> err("permission", "${p.name}: ${e.description}") }
    setState("perm.${p.name}", if (ok) "Granted" else "Denied")
    return ok
  }

  // ------------------------------------------------------------------- display
  /** A read-only status card on the glasses, so you can see the DAT session is alive. */
  private fun attachDisplay(s: DeviceSession) {
    if (display != null) return
    s.addDisplay(DisplayConfiguration()).fold(
        onSuccess = { d ->
          display = d
          jobs["display.state"] = scope.launch { d.state.collect { setState("display", it.name) } }
          jobs["display.loop"] = scope.launch {
            var last = ""
            var lastSent = 0L
            while (true) {
              if (d.state.value == DisplayState.STARTED) {
                val lines = statusLines()
                val key = lines.joinToString("|")
                val now = System.currentTimeMillis()
                // Full-screen replace over Bluetooth: only when something changed, and at most every 1.5 s.
                if (key != last && now - lastSent >= 1500) {
                  d.sendContent {
                    flexBox(direction = Direction.COLUMN, gap = 8) {
                      text("Glass Sensor Link", style = TextStyle.HEADING)
                      lines.forEach { text(it, style = TextStyle.BODY) }
                      text("phone app is in control · Back ends the session", style = TextStyle.META, color = TextColor.SECONDARY)
                    }
                  }.onSuccess { last = key; lastSent = now }.onFailure { e, _ -> err("display", e.description) }
                }
              }
              delay(500)
            }
          }
        },
        onFailure = { e, _ -> err("display", e.description) },
    )
  }

  private fun statusLines(): List<String> {
    val st = states.value; val c = counters.value; val u = uplink
    return listOf(
        "Recorder  ${u.state.value}${u.rttMs.value?.let { " · %.0f ms".format(it) } ?: ""}",
        "Motion  ${st["motion"] ?: "off"} · ${c["dat_motion"] ?: 0}/s",
        "Inputs  ${st["inputs"] ?: "off"} · last $lastInputText",
        "Camera  ${st["stream"] ?: "off"} · ${vLastFps} fps",
    )
  }
  @Volatile private var vLastFps = 0

  fun setDisplay(on: Boolean) {
    wanted.display = on
    val s = session ?: return
    listOf("display.state", "display.loop").forEach { jobs.remove(it)?.cancel() }
    display?.stop(); display = null
    s.removeDisplay()
    if (on) attachDisplay(s) else setState("display", "STOPPED (user)")
  }

  // -------------------------------------------------------------------- camera
  private suspend fun attachCamera(s: DeviceSession) {
    if (camera != null) return
    if (!hasPermission(Permission.CAMERA)) { permissionRequests.tryEmit(Permission.CAMERA); log("camera permission needed (tap Request camera)"); attachSensors(s); return }
    val audioOk = wanted.audio && hasPermission(Permission.MICROPHONE)
    if (wanted.audio && !audioOk) permissionRequests.tryEmit(Permission.MICROPHONE)
    val cfg = StreamConfiguration(
        audioCodec = if (audioOk) AudioCodec.PCM(AudioSampleRate.RATE_16000, 1) else null,
        videoQuality = when (wanted.quality) { "HIGH" -> VideoQuality.HIGH; "LOW" -> VideoQuality.LOW; else -> VideoQuality.MEDIUM },
        frameRate = wanted.fps,
        compressVideo = true, // HEVC keeps flowing when the phone screen is off; PC decodes it
    )
    s.addCamera(cfg).fold(
        onSuccess = { cam ->
          camera = cam
          val st = cam.stream
          jobs["cam.state"] = scope.launch { cam.state.collect { setState("camera", it.name) } }
          jobs["stream.state"] = scope.launch {
            st.state.collect {
              setState("stream", it.name)
              if (it == StreamState.STREAMING) attachSensors(s)
            }
          }
          jobs["stream.err"] = scope.launch { st.errorStream.collect { e -> err("stream", e.description) } }
          jobs["video"] = scope.launch(Dispatchers.IO) {
            st.videoStream.collect { f ->
              val bb = f.buffer.duplicate()
              val bytes = ByteArray(bb.remaining()); bb.get(bytes)
              vFrames++; vTotal++; vBytes += bytes.size; vW = f.width; vH = f.height
              if (f.isCompressed) {
                uplink.sendBinary(Uplink.KIND_HEVC, JSONObject().put("pts", f.presentationTimeUs).put("cfg", f.isCodecConfig).put("w", f.width).put("h", f.height), bytes)
              } else {
                uplink.sendBinary(Uplink.KIND_JPEG, JSONObject().put("ext", "jpg"), yuvToJpeg(bytes, f.width, f.height) ?: return@collect)
              }
              counts["video"] = (counts["video"] ?: 0) + 1
              for (l in listeners) l("video", JSONObject().put("bytes", bytes.size).put("cfg", f.isCodecConfig))
            }
          }
          if (audioOk) jobs["audio"] = scope.launch(Dispatchers.IO) {
            var lastLevel = 0L
            st.audioStream.collect { a ->
              val bb = a.buffer.duplicate().order(ByteOrder.nativeOrder())
              val bytes = ByteArray(bb.remaining()); bb.get(bytes)
              // normalise to little-endian PCM16 for the WAV writer
              if (ByteOrder.nativeOrder() == ByteOrder.BIG_ENDIAN) for (i in 0 until bytes.size - 1 step 2) { val t = bytes[i]; bytes[i] = bytes[i + 1]; bytes[i + 1] = t }
              uplink.sendBinary(Uplink.KIND_PCM16, JSONObject().put("pts", a.presentationTimeUs).put("sr", 16000).put("ch", 1), bytes)
              val now = System.currentTimeMillis()
              if (now - lastLevel >= 100) {
                lastLevel = now
                var sum = 0.0; var peak = 0.0; var n = 0
                var i = 0
                while (i + 1 < bytes.size) { val v = ((bytes[i].toInt() and 0xff) or (bytes[i + 1].toInt() shl 8)).toShort() / 32768.0; sum += v * v; peak = maxOf(peak, abs(v)); n++; i += 2 }
                item("dat_audio_level", JSONObject().put("rms", if (n > 0) sqrt(sum / n) else 0.0).put("peak", peak).put("pts", a.presentationTimeUs))
              }
            }
          }
          st.start().onFailure { e, _ -> err("stream", e.description) }
        },
        onFailure = { e, _ -> err("camera", e.description); attachSensors(s) },
    )
  }

  fun setCamera(on: Boolean) {
    wanted.camera = on
    val s = session ?: return
    if (on) scope.launch { attachCamera(s) } else {
      listOf("video", "audio", "stream.state", "stream.err", "cam.state").forEach { jobs.remove(it)?.cancel() }
      camera?.stop(); camera = null
      s.removeCamera()
      setState("stream", "STOPPED (user)")
    }
  }

  suspend fun capturePhoto(): Pair<Boolean, String> {
    val cam = camera ?: return false to "no camera (start session with camera on)"
    val t0 = System.currentTimeMillis()
    var result = false to "?"
    cam.stream.capturePhoto().onSuccess { pd ->
      when (pd) {
        is PhotoData.Bitmap -> {
          val bos = ByteArrayOutputStream(); pd.bitmap.compress(Bitmap.CompressFormat.JPEG, 92, bos)
          uplink.sendBinary(Uplink.KIND_PHOTO, JSONObject().put("ext", "jpg").put("w", pd.bitmap.width).put("h", pd.bitmap.height), bos.toByteArray())
          result = true to "${pd.bitmap.width}x${pd.bitmap.height} jpeg ${bos.size()} B"
        }
        is PhotoData.HEIC -> {
          val bb = pd.data.duplicate(); val b = ByteArray(bb.remaining()); bb.get(b)
          uplink.sendBinary(Uplink.KIND_PHOTO, JSONObject().put("ext", "heic"), b)
          result = true to "heic ${b.size} B"
        }
      }
    }.onFailure { e, _ -> result = false to e.toString() }
    item("dat_photo", JSONObject().put("ok", result.first).put("info", result.second).put("ms", System.currentTimeMillis() - t0))
    log("photo: ${result.second}")
    return result
  }

  private fun yuvToJpeg(i420: ByteArray, w: Int, h: Int): ByteArray? = try {
    // I420 -> NV21 for YuvImage
    val ySize = w * h; val q = ySize / 4
    if (i420.size < ySize + 2 * q) null else {
      val nv21 = ByteArray(ySize + 2 * q)
      System.arraycopy(i420, 0, nv21, 0, ySize)
      for (k in 0 until q) { nv21[ySize + 2 * k] = i420[ySize + q + k]; nv21[ySize + 2 * k + 1] = i420[ySize + k] }
      val img = android.graphics.YuvImage(nv21, android.graphics.ImageFormat.NV21, w, h, null)
      val bos = ByteArrayOutputStream(); img.compressToJpeg(android.graphics.Rect(0, 0, w, h), 70, bos); bos.toByteArray()
    }
  } catch (e: Exception) { null }

  // -------------------------------------------------------------------- motion
  private fun rateEnum(hz: Int) = when (hz) { 5 -> MotionSamplingRate.HZ_5; 10 -> MotionSamplingRate.HZ_10; 15 -> MotionSamplingRate.HZ_15; 24 -> MotionSamplingRate.HZ_24; 30 -> MotionSamplingRate.HZ_30; else -> MotionSamplingRate.HZ_60 }

  private fun attachMotion(s: DeviceSession, hz: Int, attempt: Int = 0) {
    s.addMotion(MotionConfiguration(rateEnum(hz))).fold(
        onSuccess = { m ->
          motion = m
          jobs["motion.samples"] = scope.launch { m.samples.collect { onMotion(it, hz) } }
          jobs["motion.state"] = scope.launch { m.state.collect { setState("motion", "${it.name} @${hz}Hz") } }
          jobs["motion.err"] = scope.launch {
            m.errors.collect { e: MotionError? ->
              if (e == null) return@collect
              err("motion", e.description)
              if (e == MotionError.DEVICE_DISCONNECTED || e == MotionError.SENSOR_UNAVAILABLE) retryMotion(s, hz, attempt)
            }
          }
          m.start()
        },
        onFailure = { e, _ -> err("motion", e.description); retryMotion(s, hz, attempt) },
    )
  }

  private fun retryMotion(s: DeviceSession, hz: Int, attempt: Int) {
    if (attempt >= 5 || session !== s) return
    scope.launch {
      delay(3000L)
      removeMotionNow()
      if (session === s && wanted.motion) { log("retrying motion (${attempt + 1})"); attachMotion(s, hz, attempt + 1) }
    }
  }

  private fun removeMotionNow() {
    listOf("motion.samples", "motion.state", "motion.err").forEach { jobs.remove(it)?.cancel() }
    motion?.stop(); motion = null
    session?.removeMotion()
  }

  fun setMotion(on: Boolean, hz: Int = wanted.motionRate) {
    wanted.motion = on; wanted.motionRate = hz
    val s = session ?: return
    removeMotionNow()
    if (on) attachMotion(s, hz) else setState("motion", "STOPPED (user)")
  }

  private fun onMotion(m: MotionSample, hz: Int) {
    val o = JSONObject().put("tns", m.timestampNs).put("src", m.source.name).put("hz", hz)
    m.accelerometer?.let { o.put("ax", it.x.toDouble()).put("ay", it.y.toDouble()).put("az", it.z.toDouble()) }
    m.gyroscope?.let { o.put("gx", it.x.toDouble()).put("gy", it.y.toDouble()).put("gz", it.z.toDouble()) }
    m.magnetometer?.let { o.put("mx", it.x.toDouble()).put("my", it.y.toDouble()).put("mz", it.z.toDouble()) }
    m.orientation?.let { o.put("qw", it.w.toDouble()).put("qx", it.x.toDouble()).put("qy", it.y.toDouble()).put("qz", it.z.toDouble()) }
    item("dat_motion", o)
  }

  // -------------------------------------------------------------------- inputs
  private fun attachInputs(s: DeviceSession, attempt: Int = 0) {
    // empty source set = every available source, including UNKNOWN
    s.addInputs(InputsConfiguration(emptySet(), true)).fold(
        onSuccess = { inp ->
          inputs = inp
          jobs["inputs.events"] = scope.launch { inp.events.collect { onInput(it) } }
          jobs["inputs.state"] = scope.launch { inp.state.collect { setState("inputs", it.name) } }
          jobs["inputs.err"] = scope.launch {
            inp.errors.collect { e: InputsError? ->
              if (e == null) return@collect
              err("inputs", e.description)
              if (e != InputsError.PERMISSION_DENIED && attempt < 5 && session === s) {
                delay(3000L); removeInputsNow(); if (session === s && wanted.inputs) attachInputs(s, attempt + 1)
              }
            }
          }
        },
        onFailure = { e, _ -> err("inputs", e.description) },
    )
  }

  private fun removeInputsNow() {
    listOf("inputs.events", "inputs.state", "inputs.err").forEach { jobs.remove(it)?.cancel() }
    inputs = null
    session?.removeInputs()
  }

  fun setInputs(on: Boolean) {
    wanted.inputs = on
    val s = session ?: return
    removeInputsNow()
    if (on) attachInputs(s) else setState("inputs", "INACTIVE (user)")
  }

  private fun onInput(e: InputEvent) {
    val o = JSONObject().put("src", e.source.name).put("tms", e.timestampMs)
    when (e) {
      is InputEvent.Nav -> o.put("type", "nav").put("dir", e.direction.name)
      is InputEvent.Select -> o.put("type", "select")
      is InputEvent.Back -> o.put("type", "back")
      is InputEvent.Button -> o.put("type", "button").put("button", e.button.name)
      is InputEvent.Capture -> o.put("type", "capture").put("press", e.pressType.name)
      is InputEvent.Drag -> o.put("type", "drag").put("action", e.action.name).put("x", e.x.toDouble()).put("y", e.y.toDouble()).put("dx", e.dx.toDouble()).put("dy", e.dy.toDouble())
      else -> o.put("type", e.javaClass.simpleName.lowercase())
    }
    lastInputText = o.optString("dir").ifEmpty { o.optString("type") } + " (" + e.source.name.lowercase() + ")"
    item("dat_input", o)
  }

  // -------------------------------------------------------------------- speech
  private suspend fun attachSpeech(s: DeviceSession) {
    if (!hasPermission(Permission.MICROPHONE)) { permissionRequests.tryEmit(Permission.MICROPHONE); log("speech needs microphone permission"); return }
    s.addSpeech(SpeechConfiguration()).fold(
        onSuccess = { sp ->
          speech = sp
          jobs["speech.tx"] = scope.launch {
            sp.transcriptions.collect { r -> r ?: return@collect; item("dat_speech", JSONObject().put("text", r.text).put("final", r.isFinal).put("conf", r.confidence.toDouble())) }
          }
          jobs["speech.state"] = scope.launch { sp.state.collect { setState("speech", it.name) } }
          jobs["speech.locale"] = scope.launch { sp.locale.collect { l -> if (l != null) setState("speech.locale", l) } }
          jobs["speech.err"] = scope.launch { sp.errors.collect { e -> if (e != null) err("speech", e.description) } }
          jobs["speech.details"] = scope.launch { sp.errorDetails.collect { d -> if (!d.isNullOrEmpty()) item("dat_error", JSONObject().put("cap", "speech.details").put("error", d)) } }
          sp.start().onFailure { e, _ -> err("speech", e.description) }
        },
        onFailure = { e, _ -> err("speech", e.description) },
    )
  }

  fun setSpeech(on: Boolean) {
    wanted.speech = on
    val s = session ?: return
    listOf("speech.tx", "speech.state", "speech.locale", "speech.err", "speech.details").forEach { jobs.remove(it)?.cancel() }
    speech?.stop(); speech = null
    s.removeSpeech()
    if (on) scope.launch { attachSpeech(s) } else setState("speech", "STOPPED (user)")
  }

  // ------------------------------------------------------------ remote control
  private fun onCommand(cmd: String, a: JSONObject) {
    item("cmd", JSONObject().put("cmd", cmd).put("args", a))
    when (cmd) {
      "run_tests" -> DatTests.run(a.optString("only").ifEmpty { null })
      "stop_tests" -> DatTests.stop()
      "photo" -> scope.launch { capturePhoto() }
      "camera" -> setCamera(a.optBoolean("on", true))
      "motion" -> setMotion(a.optBoolean("on", true), a.optInt("rate", wanted.motionRate))
      "inputs" -> setInputs(a.optBoolean("on", true))
      "speech" -> setSpeech(a.optBoolean("on", true))
      "display" -> setDisplay(a.optBoolean("on", true))
      "start_session" -> startSession()
      "stop_session" -> stopSession()
      "marker" -> log("marker: ${a.optString("label")}")
    }
  }

  fun sessionActive() = session != null && states.value["session"] == "STARTED"
  fun motionNow() = motion
}
