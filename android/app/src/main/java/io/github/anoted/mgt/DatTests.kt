package io.github.anoted.mgt

import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.RegistrationState
import kotlin.math.abs
import kotlin.math.sqrt
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * Phone-side (DAT SDK) test suite. Same result format as the glasses Web App suite:
 *   {t:"test_suite", phase:"start"|"end"} and {t:"test", name, title, status, metrics, notes, t_start, t_end}
 * status ∈ pass | warn | fail | unsupported | skip. Prompts are shown on the phone, spoken and shown on the
 * glasses display (relayed through the PC to the Web App, if it is open).
 */
object DatTests {
  class Abort : Exception("aborted")

  val running = MutableStateFlow(false)
  val current = MutableStateFlow("")
  val results = MutableStateFlow<List<JSONObject>>(emptyList())
  @Volatile private var abort = false
  private var job: Job? = null

  private val L get() = GlassLink

  private class T(val name: String, val title: String, val fn: suspend () -> JSONObject)

  private val TESTS = listOf(
      T("dat_registration", "App registered with Meta AI") { registration() },
      T("dat_device", "Device discovery & metadata") { deviceInfo() },
      T("dat_permissions", "Camera / microphone permissions") { permissions() },
      T("dat_session", "Device session start") { session() },
      T("dat_camera", "Camera video stream") { cameraStream() },
      T("dat_audio", "Microphone audio stream") { audioStream() },
      T("dat_photo", "Photo capture") { photo() },
      T("dat_imu_still", "IMU noise floor (keep still)") { imuStill() },
      T("dat_motion_rates", "Motion sampling-rate sweep") { motionRates() },
      T("dat_axes", "IMU axis discovery (prompted)") { axes() },
      T("dat_inputs", "Input sources (prompted)") { inputsPrompted() },
      T("dat_speech", "Speech recognition") { speechTest() },
      T("dat_latency", "Uplink round-trip latency") { latency() },
      T("dat_throughput", "Uplink throughput") { throughput() },
  )
  val names get() = TESTS.map { it.name }

  fun run(only: String? = null) {
    if (running.value) return
    abort = false
    job = L.scope.launch { suite(only) }
  }

  fun stop() { abort = true; job?.cancel(); running.value = false; prompt("") }

  private suspend fun suite(only: String?) {
    running.value = true
    val list = if (only != null) TESTS.filter { it.name == only } else TESTS
    val t0 = Uplink.nowMs()
    results.value = emptyList()
    L.uplink.sendJson(JSONObject().put("t", "test_suite").put("phase", "start").put("ts", t0).put("tests", JSONArray(list.map { it.name })))
    val counts = HashMap<String, Int>()
    try {
      for (t in list) {
        if (abort) break
        current.value = t.title
        val ts = Uplink.nowMs()
        L.item("test_mark", JSONObject().put("name", t.name).put("phase", "start"))
        var r = try {
          withTimeoutOrNull(120_000) { t.fn() } ?: res("fail", notes = "test timeout")
        } catch (e: Abort) { res("skip", notes = "aborted") } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) {
          res("fail", notes = "${e.javaClass.simpleName}: ${e.message}")
        }
        r = r.put("t", "test").put("name", t.name).put("title", t.title).put("t_start", ts).put("t_end", Uplink.nowMs()).put("ts", Uplink.nowMs())
        L.item("test_mark", JSONObject().put("name", t.name).put("phase", "end").put("status", r.optString("status")))
        L.uplink.sendJson(r)
        L.log("test ${t.name}: ${r.optString("status")} ${r.optString("notes")}")
        counts[r.optString("status")] = (counts[r.optString("status")] ?: 0) + 1
        results.value = results.value + r
      }
    } finally {
      prompt("")
      current.value = if (abort) "aborted" else "done · " + counts.entries.joinToString(" · ") { "${it.value} ${it.key}" }
      L.uplink.sendJson(JSONObject().put("t", "test_suite").put("phase", "end").put("ts", Uplink.nowMs()).put("dur_ms", Uplink.nowMs() - t0)
          .put("counts", JSONObject(counts as Map<*, *>)).put("aborted", abort))
      running.value = false
    }
  }

  // ------------------------------------------------------------------ helpers
  private fun res(status: String, metrics: JSONObject = JSONObject(), notes: String = "") =
      JSONObject().put("status", status).put("metrics", metrics).put("notes", notes)

  private fun check() { if (abort) throw Abort() }

  /** Show a prompt on the phone and on the glasses (toast + TTS via the Web App). */
  fun prompt(text: String, speak: Boolean = true, ms: Int = 6000) {
    L.prompt.value = text
    if (text.isEmpty()) return
    L.item("dat_prompt", JSONObject().put("text", text))
    L.uplink.sendJson(JSONObject().put("t", "relay").put("target", "web").put("cmd", "show").put("args", JSONObject().put("text", text).put("ms", ms)))
    if (speak) L.uplink.sendJson(JSONObject().put("t", "relay").put("target", "web").put("cmd", "speak").put("args", JSONObject().put("text", text)))
  }

  /** Collect every item emitted by GlassLink matching [filter] for [ms] milliseconds. */
  private suspend fun collect(ms: Long, filter: (String, JSONObject) -> Boolean): List<Pair<Long, JSONObject>> {
    val out = java.util.Collections.synchronizedList(ArrayList<Pair<Long, JSONObject>>())
    val l: (String, JSONObject) -> Unit = { s, o -> if (filter(s, o)) out.add(System.nanoTime() to o) }
    L.listeners.add(l)
    try {
      var left = ms
      while (left > 0) { check(); val d = minOf(left, 200L); delay(d); left -= d }
    } finally { L.listeners.remove(l) }
    return synchronized(out) { ArrayList(out) }
  }

  private suspend fun waitFor(ms: Long, cond: () -> Boolean): Boolean {
    val end = System.currentTimeMillis() + ms
    while (System.currentTimeMillis() < end) { check(); if (cond()) return true; delay(100) }
    return cond()
  }

  private suspend fun countdown(sec: Int, text: String) {
    prompt(text)
    for (i in sec downTo 1) { check(); L.prompt.value = "$text  ($i)"; delay(1000) }
  }

  private fun stat(xs: List<Double>): JSONObject {
    if (xs.isEmpty()) return JSONObject().put("n", 0)
    val m = xs.average()
    val sd = sqrt(xs.sumOf { (it - m) * (it - m) } / xs.size)
    val s = xs.sorted()
    return JSONObject().put("n", xs.size).put("mean", r3(m)).put("std", r3(sd)).put("min", r3(s.first())).put("max", r3(s.last()))
        .put("p50", r3(s[s.size / 2])).put("p95", r3(s[minOf(s.size - 1, (s.size * 0.95).toInt())]))
  }

  private fun r3(v: Double) = Math.round(v * 1000) / 1000.0

  private fun needSession(): JSONObject? = if (!L.sessionActive()) res("skip", notes = "no active session") else null

  // -------------------------------------------------------------------- tests
  private fun registration(): JSONObject {
    val st = Wearables.registrationState.value
    val dev = runCatching { Wearables.isDevMode }.getOrNull()
    val m = JSONObject().put("state", st.name).put("dev_mode", dev)
    return when (st) {
      RegistrationState.REGISTERED -> res("pass", m)
      RegistrationState.REGISTERING -> res("warn", m, "registration still in progress")
      else -> res("fail", m, "tap Register in the app (Meta AI app + Developer Mode needed)")
    }
  }

  private suspend fun deviceInfo(): JSONObject {
    waitFor(5000) { Wearables.devices.value.isNotEmpty() }
    val ids = Wearables.devices.value
    if (ids.isEmpty()) return res("fail", notes = "no devices visible to DAT (glasses paired in Meta AI? Bluetooth on?)")
    waitFor(3000) { L.device.value.isNotEmpty() }
    val d = L.device.value
    val m = JSONObject(d as Map<*, *>).put("n_devices", ids.size)
    val warn = d["link"]?.contains("CONNECTED") != true || d["compat"]?.let { it != "COMPATIBLE" } == true
    return res(if (warn) "warn" else "pass", m, "${d["name"]} · ${d["type"]} · fw ${d["fw"]} · bat ${d["battery"]}% · ${d["don"]} · ${d["hinge"]}")
  }

  private suspend fun permissions(): JSONObject {
    val cam = L.hasPermission(Permission.CAMERA)
    val mic = L.hasPermission(Permission.MICROPHONE)
    val m = JSONObject().put("camera", cam).put("microphone", mic)
    return res(if (cam && mic) "pass" else "warn", m, if (cam && mic) "" else "grant missing permission with the buttons in the app")
  }

  private suspend fun session(): JSONObject {
    val t0 = System.currentTimeMillis()
    val was = L.sessionActive()
    if (!was) L.startSession()
    val ok = waitFor(30_000) { L.sessionActive() }
    val m = JSONObject().put("already_running", was).put("start_ms", if (was) 0 else System.currentTimeMillis() - t0).put("state", L.states.value["session"])
    return res(if (ok) "pass" else "fail", m, if (ok) "" else "session did not reach STARTED: ${L.states.value["session error"] ?: L.states.value["session"]}")
  }

  private suspend fun cameraStream(): JSONObject {
    needSession()?.let { return it }
    if (!L.wanted.camera || L.states.value["stream"] != "STREAMING") L.setCamera(true)
    val t0 = System.currentTimeMillis()
    val streaming = waitFor(20_000) { L.states.value["stream"] == "STREAMING" }
    if (!streaming) return res("fail", JSONObject().put("stream", L.states.value["stream"]), "stream not STREAMING: ${L.states.value["stream error"] ?: L.states.value["camera error"] ?: ""}")
    val startMs = System.currentTimeMillis() - t0
    val frames = collect(6000) { s, _ -> s == "video" }
    val stats = collect(2100) { s, _ -> s == "dat_video_stat" }.lastOrNull()?.second
    val fps = frames.size / 6.0
    val bytes = frames.map { it.second.optInt("bytes").toDouble() }
    val gaps = frames.zipWithNext { a, b -> (b.first - a.first) / 1e6 }
    val m = JSONObject().put("fps", r3(fps)).put("frames", frames.size).put("frame_bytes", stat(bytes)).put("gap_ms", stat(gaps))
        .put("kbps", r3(bytes.sum() * 8 / 6000.0)).put("codec_config_frames", frames.count { it.second.optBoolean("cfg") })
        .put("w", stats?.optInt("w")).put("h", stats?.optInt("h")).put("quality", L.wanted.quality).put("fps_requested", L.wanted.fps).put("time_to_stream_ms", startMs)
    return res(when { fps >= L.wanted.fps * 0.6 -> "pass"; fps > 0 -> "warn"; else -> "fail" }, m, "${r3(fps)} fps · ${stats?.optInt("w")}×${stats?.optInt("h")}")
  }

  private suspend fun audioStream(): JSONObject {
    needSession()?.let { return it }
    if (L.states.value["stream"] != "STREAMING") return res("skip", notes = "camera stream not running (audio rides on it)")
    prompt("Stay quiet for 3 seconds")
    val quiet = collect(3000) { s, _ -> s == "dat_audio_level" }
    prompt("Now speak or clap for 4 seconds")
    val loud = collect(4000) { s, _ -> s == "dat_audio_level" }
    if (quiet.isEmpty() && loud.isEmpty()) return res("fail", notes = "no audio chunks (microphone permission? audio enabled?)")
    val qr = quiet.map { it.second.optDouble("rms") }; val lr = loud.map { it.second.optDouble("rms") }
    val snr = if (qr.isNotEmpty() && lr.isNotEmpty() && qr.average() > 0) 20 * kotlin.math.log10(lr.maxOrNull()!! / qr.average()) else Double.NaN
    val m = JSONObject().put("quiet_rms", stat(qr)).put("active_rms", stat(lr)).put("peak", r3(loud.maxOfOrNull { it.second.optDouble("peak") } ?: 0.0))
        .put("dynamic_range_db", if (snr.isNaN()) null else r3(snr)).put("level_rate_hz", r3((quiet.size + loud.size) / 7.0)).put("sample_rate", 16000)
    return res(if (!snr.isNaN() && snr > 6) "pass" else "warn", m, "range ${if (snr.isNaN()) "?" else r3(snr)} dB")
  }

  private suspend fun photo(): JSONObject {
    needSession()?.let { return it }
    if (L.states.value["stream"] != "STREAMING") return res("skip", notes = "photo capture needs the camera stream")
    countdown(2, "Look at something — photo")
    val t0 = System.currentTimeMillis()
    val (ok, info) = L.capturePhoto()
    return res(if (ok) "pass" else "fail", JSONObject().put("ms", System.currentTimeMillis() - t0).put("info", info), info)
  }

  private fun motionBySource(samples: List<Pair<Long, JSONObject>>, sec: Double): JSONObject {
    val out = JSONObject()
    samples.groupBy { it.second.optString("src") }.forEach { (src, ss) ->
      val o = ss.map { it.second }
      val tns = o.map { it.optLong("tns") }.filter { it > 0 }
      val dt = tns.zipWithNext { a, b -> (b - a) / 1e6 }.filter { it > 0 }
      val fields = listOf("ax", "gx", "mx", "qw").filter { f -> o.any { it.has(f) } }.map { mapOf("ax" to "accel", "gx" to "gyro", "mx" to "mag", "qw" to "quat")[it] }
      out.put(src, JSONObject().put("n", o.size).put("rate_hz", r3(o.size / sec)).put("fields", JSONArray(fields)).put("dt_ms", stat(dt)))
    }
    return out
  }

  private suspend fun imuStill(): JSONObject {
    needSession()?.let { return it }
    if (L.motionNow() == null) L.setMotion(true)
    if (!waitFor(10_000) { L.counters.value["dat_motion"]?.let { it > 0 } == true }) return res("fail", JSONObject().put("motion", L.states.value["motion"]), "no motion samples: ${L.states.value["motion error"] ?: L.states.value["motion"]}")
    countdown(2, "Keep your head and wrist completely still")
    prompt("Hold still…", speak = false)
    val ss = collect(5000) { s, _ -> s == "dat_motion" }
    val out = JSONObject()
    ss.groupBy { it.second.optString("src") }.forEach { (src, list) ->
      val o = list.map { it.second }
      val amag = o.filter { it.has("ax") }.map { sqrt(it.optDouble("ax").let { x -> x * x } + it.optDouble("ay").let { y -> y * y } + it.optDouble("az").let { z -> z * z }) }
      val g = JSONObject(); for (k in listOf("gx", "gy", "gz", "ax", "ay", "az", "mx", "my", "mz")) { val v = o.filter { it.has(k) }.map { it.optDouble(k) }; if (v.isNotEmpty()) g.put(k, stat(v)) }
      out.put(src, JSONObject().put("accel_mag", stat(amag)).put("axes", g).put("n", o.size))
    }
    val gl = out.optJSONObject("GLASSES")?.optJSONObject("accel_mag")?.optDouble("mean") ?: Double.NaN
    val units = when { gl.isNaN() -> "?"; abs(gl - 9.81) < 1.5 -> "m/s²"; abs(gl - 1.0) < 0.2 -> "g"; else -> "unknown" }
    out.put("accel_units_guess", units)
    return res(if (ss.isNotEmpty()) "pass" else "fail", out, "sources ${ss.map { it.second.optString("src") }.toSet()} · |a|=${if (gl.isNaN()) "?" else r3(gl)} ($units)")
  }

  private suspend fun motionRates(): JSONObject {
    needSession()?.let { return it }
    val keep = L.wanted.motionRate
    val out = JSONObject()
    var anyOk = false; var worst = 1.0
    try {
      for (hz in listOf(5, 10, 15, 24, 30, 60)) {
        check()
        prompt("Motion at $hz Hz — move your head and wrist gently", speak = false)
        L.setMotion(true, hz)
        waitFor(6000) { L.states.value["motion"]?.startsWith("STARTED") == true || L.states.value["motion"]?.contains("ACTIVE") == true }
        delay(1200)
        val ss = collect(4000) { s, o -> s == "dat_motion" && o.optInt("hz") == hz }
        val bs = motionBySource(ss, 4.0)
        bs.put("state", L.states.value["motion"])
        out.put("$hz", bs)
        bs.optJSONObject("GLASSES")?.optDouble("rate_hz")?.let { if (it > 0) { anyOk = true; worst = minOf(worst, it / hz) } }
      }
    } finally { L.setMotion(true, keep) }
    return res(when { !anyOk -> "fail"; worst >= 0.8 -> "pass"; else -> "warn" }, out, "worst achieved/requested ${r3(worst)}")
  }

  private suspend fun axes(): JSONObject {
    needSession()?.let { return it }
    if (L.motionNow() == null) L.setMotion(true)
    val moves = listOf(
        "nod" to "Nod your head up and down", "shake" to "Shake your head left and right", "tilt" to "Tilt your head ear to shoulder",
        "wrist_roll" to "Rotate your wrist (Neural Band) back and forth", "wrist_flex" to "Flap your hand up and down at the wrist",
        "arm_lift" to "Raise and lower your Neural Band arm")
    val out = JSONObject()
    for ((k, text) in moves) {
      check()
      countdown(2, text)
      prompt("$text — now", speak = false)
      val ss = collect(4000) { s, _ -> s == "dat_motion" }
      val r = JSONObject()
      ss.groupBy { it.second.optString("src") }.forEach { (src, list) ->
        val o = list.map { it.second }
        fun rms(f: String) = o.filter { it.has(f) }.map { it.optDouble(f) }.let { v -> if (v.isEmpty()) 0.0 else sqrt(v.sumOf { x -> x * x } / v.size) }
        val gr = mapOf("x" to rms("gx"), "y" to rms("gy"), "z" to rms("gz"))
        val dom = gr.maxByOrNull { it.value }
        r.put(src, JSONObject().put("gyro_rms", JSONObject(gr.mapValues { r3(it.value) } as Map<*, *>)).put("dominant", dom?.key).put("n", o.size))
      }
      out.put(k, r)
    }
    prompt("Axis discovery done")
    val nb = moves.drop(3).any { out.optJSONObject(it.first)?.has("NEURAL_BAND") == true }
    val gl = moves.take(3).all { out.optJSONObject(it.first)?.has("GLASSES") == true }
    return res(if (gl && nb) "pass" else if (gl || nb) "warn" else "fail", out,
        "head ${moves.take(3).joinToString(",") { m -> "${m.first}=${out.optJSONObject(m.first)?.optJSONObject("GLASSES")?.optString("dominant") ?: "-"}" }} · band ${if (nb) "seen" else "not seen"}")
  }

  private suspend fun inputsPrompted(): JSONObject {
    needSession()?.let { return it }
    if (L.states.value["inputs"] == null || L.states.value["inputs"]?.contains("user") == true) L.setInputs(true)
    val steps = listOf(
        // No touchpad single tap: during a DAT session it pauses the session (tap-and-hold stops it).
        "touch_swipe" to "Swipe forward then back on the glasses touchpad",
        "capture" to "Press the capture button (short, then long)",
        "action" to "Press the action button",
        "nb_swipe" to "Neural Band: thumb swipe left, right, up, down",
        "nb_select" to "Neural Band: index pinch (select)",
        "nb_back" to "Neural Band: middle pinch (back)",
        "nb_drag" to "Neural Band: pinch and hold, then drag",
        "nb_display" to "Neural Band: swipe to Mark on the glasses and pinch it",
    )
    val out = JSONObject(); val seenSources = HashSet<String>(); var hits = 0
    for ((k, text) in steps) {
      check()
      prompt(text)
      val t0 = System.nanoTime()
      // dat_display_click = a pinch/tap routed by the glasses to a button on our display card
      val ev = collect(7000) { s, _ -> s == "dat_input" || s == "dat_display_click" }
      val list = ev.map { it.second.let { o -> if (o.optString("s") == "dat_display_click") JSONObject(o.toString()).put("src", "DISPLAY").put("type", "click/" + o.optString("id")) else o } }
      list.forEach { seenSources.add(it.optString("src")) }
      if (list.isNotEmpty()) hits++
      val kinds = list.groupBy { "${it.optString("src")}:${it.optString("type")}${it.optString("dir").let { d -> if (d.isNotEmpty()) "/$d" else "" }}${it.optString("press").let { d -> if (d.isNotEmpty()) "/$d" else "" }}${it.optString("button").let { d -> if (d.isNotEmpty()) "/$d" else "" }}" }.mapValues { it.value.size }
      out.put(k, JSONObject().put("events", list.size).put("kinds", JSONObject(kinds as Map<*, *>))
          .put("first_ms", ev.firstOrNull()?.let { r3((it.first - t0) / 1e6) })
          .put("drag_moves", list.count { it.optString("type") == "drag" }))
    }
    prompt("Input test done")
    out.put("sources_seen", JSONArray(seenSources.toList()))
    return res(when { hits == steps.size -> "pass"; hits > 0 -> "warn"; else -> "fail" }, out, "$hits/${steps.size} prompts produced events · ${seenSources.joinToString()}")
  }

  private suspend fun speechTest(): JSONObject {
    needSession()?.let { return it }
    val was = L.wanted.speech
    if (!was || L.states.value["speech"]?.contains("user") == true) L.setSpeech(true)
    waitFor(8000) { L.states.value["speech"]?.let { it.contains("START") || it.contains("LISTEN") || it.contains("ACTIVE") } == true }
    val phrase = "the quick brown fox jumps over the lazy dog"
    prompt("Say: $phrase", speak = false)
    val t0 = System.nanoTime()
    val tx = collect(10_000) { s, _ -> s == "dat_speech" }
    if (!was) L.setSpeech(false)
    val finals = tx.filter { it.second.optBoolean("final") }.map { it.second.optString("text") }
    val heard = (finals.ifEmpty { tx.map { it.second.optString("text") }.takeLast(1) }).joinToString(" ").lowercase()
    val want = phrase.split(" ").toSet()
    val got = heard.split(Regex("\\W+")).toSet()
    val acc = want.count { it in got }.toDouble() / want.size
    val m = JSONObject().put("partials", tx.count { !it.second.optBoolean("final") }).put("finals", finals.size).put("text", heard)
        .put("word_recall", r3(acc)).put("first_result_ms", tx.firstOrNull()?.let { r3((it.first - t0) / 1e6) })
        .put("state", L.states.value["speech"]).put("locale", L.states.value["speech.locale"])
    return res(when { tx.isEmpty() -> "fail"; acc >= 0.7 -> "pass"; else -> "warn" }, m, if (tx.isEmpty()) "no transcriptions: ${L.states.value["speech error"] ?: ""}" else "“$heard” · recall ${r3(acc)}")
  }

  private suspend fun latency(): JSONObject {
    if (!L.uplink.isOpen()) return res("fail", notes = "uplink to PC not open")
    val rtts = ArrayList<Double>(); val offs = ArrayList<Double>()
    repeat(30) {
      check()
      val d = CompletableDeferred<Pair<Double, Double>>()
      L.uplink.ping { r, o -> d.complete(r to o) }
      withTimeoutOrNull(3000) { d.await() }?.let { rtts.add(it.first); offs.add(it.second) }
      delay(100)
    }
    if (rtts.isEmpty()) return res("fail", notes = "no pongs")
    val s = stat(rtts)
    return res(if (s.optDouble("p50") < 150) "pass" else "warn", JSONObject().put("rtt_ms", s).put("clock_offset_ms", stat(offs)).put("lost", 30 - rtts.size),
        "rtt p50 ${s.optDouble("p50")} ms · p95 ${s.optDouble("p95")} ms")
  }

  private suspend fun throughput(): JSONObject {
    if (!L.uplink.isOpen()) return res("fail", notes = "uplink to PC not open")
    val id = "dat" + System.nanoTime()
    val n = 48; val size = 64 * 1024
    val d = CompletableDeferred<JSONObject>()
    L.uplink.tputListener = { m -> if (m.optString("id") == id) d.complete(m) }
    try {
      L.uplink.sendJson(JSONObject().put("t", "tput_begin").put("id", id).put("n", n))
      val blob = ByteArray(size).also { java.util.Random().nextBytes(it) }
      var sent = 0
      for (i in 0 until n) {
        check()
        var tries = 0
        while (!L.uplink.sendBinary(Uplink.KIND_TPUT, JSONObject().put("id", id).put("i", i), blob)) { delay(20); if (++tries > 500) break }
        sent++
      }
      val r = withTimeoutOrNull(30_000) { d.await() } ?: return res("fail", JSONObject().put("sent", sent), "no tput_result from server")
      val mbps = r.optDouble("mbps")
      return res(if (mbps >= 2) "pass" else "warn", JSONObject().put("mbps", r3(mbps)).put("bytes", r.optLong("bytes")).put("ms", r3(r.optDouble("ms"))).put("frames", n),
          "${r3(mbps)} Mbit/s up (video at MEDIUM needs ~1–3)")
    } finally { L.uplink.tputListener = null }
  }
}
