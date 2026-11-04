package io.github.anoted.mgt

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Single-screen control panel. Light theme, serif type (matches the PC dashboard). */
class MainActivity : ComponentActivity() {
  private val ink = Color.parseColor("#1D1D1B")
  private val muted = Color.parseColor("#6B6B66")
  private val paper = Color.parseColor("#FBFAF7")
  private val rule = Color.parseColor("#DCD9D0")
  private val accent = Color.parseColor("#2A5DB0")
  private val serif = Typeface.create("serif", Typeface.NORMAL)
  private val serifB = Typeface.create("serif", Typeface.BOLD)
  private val mono = Typeface.MONOSPACE

  private lateinit var root: LinearLayout
  private lateinit var tUplink: TextView
  private lateinit var tReg: TextView
  private lateinit var tStates: TextView
  private lateinit var tDevice: TextView
  private lateinit var tRates: TextView
  private lateinit var tPrompt: TextView
  private lateinit var tTests: TextView
  private lateinit var tLog: TextView
  private lateinit var bSession: Button
  private lateinit var bTests: Button
  private lateinit var eServer: EditText
  private lateinit var eKey: EditText
  private var ready = false

  private val btLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
    if (r[Manifest.permission.BLUETOOTH_CONNECT] == true) bringUp() else toast("Bluetooth permission is required for the glasses link")
  }

  private val datPermLauncher = registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
    result.onSuccess { st ->
      toast("Permission: $st")
      if (st == PermissionStatus.Granted && GlassLink.sessionActive()) GlassLink.setCamera(GlassLink.wanted.camera)
    }.onFailure { e, _ -> toast("Permission failed: ${e.description}") }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    buildUi()
    val need = mutableListOf(Manifest.permission.BLUETOOTH_CONNECT)
    if (Build.VERSION.SDK_INT >= 33) need += Manifest.permission.POST_NOTIFICATIONS
    if (need.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) bringUp() else btLauncher.launch(need.toTypedArray())
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (ready) handleLink(intent)
  }

  private fun bringUp() {
    GlassLink.init(this)
    ready = true
    val (s, k) = GlassLink.config()
    eServer.setText(s); eKey.setText(k)
    handleLink(intent)
    lifecycleScope.launch { refreshLoop() }
  }

  /** metaglasstest://config?server=…&key=… (from the dashboard QR code), otherwise a DAT registration callback. */
  private fun handleLink(i: Intent?) {
    val u: Uri = i?.data ?: return
    if (u.host == "config") {
      val s = u.getQueryParameter("server") ?: return
      val k = u.getQueryParameter("key") ?: ""
      GlassLink.saveConfig(s, k)
      eServer.setText(s); eKey.setText(k)
      toast("Recorder set to $s")
    } else {
      Wearables.handleIntent(i) { req -> req.continueRegistration(this) }
          .onFailure { e, _ -> GlassLink.log("registration callback: $e") }
    }
    i.data = null
  }

  // --------------------------------------------------------------------- UI
  private fun buildUi() {
    window.statusBarColor = paper
    window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
    root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(20), dp(16), dp(32)) }
    val scroll = ScrollView(this).apply { setBackgroundColor(paper); addView(root) }
    setContentView(scroll)

    root.addView(text("Glass Sensor Link", 26f, serifB))
    root.addView(text("Meta Ray-Ban Display + Neural Band · DAT SDK companion · v${GlassLink.VERSION}", 13f, serif, muted))

    section("Recorder PC")
    eServer = edit("https://your-pc.tailnet.ts.net:8765", InputType.TYPE_TEXT_VARIATION_URI)
    eKey = edit("key", InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
    root.addView(eServer); root.addView(eKey)
    root.addView(row(button("Save & connect") { GlassLink.saveConfig(eServer.text.toString(), eKey.text.toString()); toast("Connecting…") },
        button("Reconnect") { GlassLink.uplink.reconnect() }))
    tUplink = mono(); root.addView(tUplink)

    section("Meta AI registration & permissions")
    tReg = text("", 15f, serif); root.addView(tReg)
    root.addView(row(button("Register") { Wearables.startRegistration(this) }, button("Unregister") { Wearables.startUnregistration(this) }))
    root.addView(row(button("Camera permission") { datPermLauncher.launch(Permission.CAMERA) },
        button("Mic permission") { datPermLauncher.launch(Permission.MICROPHONE) }))

    section("Session & streams")
    bSession = button("Start session") { if (GlassLink.sessionActive() || GlassLink.states.value["session"] in setOf("STARTING", "CREATED")) GlassLink.stopSession() else GlassLink.startSession() }
    root.addView(row(bSession, button("Photo") { GlassLink.scope.launch { val (_, info) = GlassLink.capturePhoto(); runOnUiThread { toast(info) } } }))
    val w = GlassLink.wanted
    root.addView(switch("Camera video", w.camera) { GlassLink.setCamera(it) })
    root.addView(switch("Microphone audio (with camera)", w.audio) { w.audio = it; if (w.camera && GlassLink.sessionActive()) { GlassLink.setCamera(false); GlassLink.setCamera(true) } })
    root.addView(spinner("Video quality", listOf("LOW", "MEDIUM", "HIGH"), w.quality) { w.quality = it; if (w.camera && GlassLink.sessionActive()) { GlassLink.setCamera(false); GlassLink.setCamera(true) } })
    root.addView(spinner("Video fps", listOf("2", "7", "15", "24", "30"), w.fps.toString()) { w.fps = it.toInt(); if (w.camera && GlassLink.sessionActive()) { GlassLink.setCamera(false); GlassLink.setCamera(true) } })
    root.addView(switch("Motion (glasses + Neural Band IMU)", w.motion) { GlassLink.setMotion(it) })
    root.addView(spinner("Motion rate (Hz)", listOf("5", "10", "15", "24", "30", "60"), w.motionRate.toString()) { GlassLink.setMotion(w.motion, it.toInt()) })
    root.addView(switch("Inputs (touchpad, buttons, Neural Band)", w.inputs) { GlassLink.setInputs(it) })
    root.addView(switch("Speech recognition", w.speech) { GlassLink.setSpeech(it) })

    section("Phone-side test suite")
    tPrompt = text("", 20f, serifB, accent).apply { gravity = Gravity.CENTER_HORIZONTAL; setPadding(0, dp(6), 0, dp(6)) }
    root.addView(tPrompt)
    bTests = button("Run all DAT tests") { if (DatTests.running.value) DatTests.stop() else DatTests.run() }
    root.addView(row(bTests, button("Marker") { GlassLink.log("marker: phone"); GlassLink.item("marker", org.json.JSONObject().put("label", "phone")) }))
    tTests = text("", 14f, serif); root.addView(tTests)

    section("Live state")
    tStates = mono(); root.addView(tStates)
    section("Device")
    tDevice = mono(); root.addView(tDevice)
    section("Items per second")
    tRates = mono(); root.addView(tRates)
    section("Log")
    tLog = mono().apply { textSize = 11f }; root.addView(tLog)
  }

  private suspend fun refreshLoop() {
    while (true) {
      val u = GlassLink.uplink
      tUplink.text = "link ${u.state.value} · rtt ${u.rttMs.value?.let { "%.0f ms".format(it) } ?: "–"} · offset ${u.offsetMs?.let { "%.0f ms".format(it) } ?: "–"}\n" +
          "queue ${u.queueLength()} · dropped ${u.dropped.get()} · sent ${"%.1f".format(u.sentBytes.get() / 1e6)} MB"
      val reg = Wearables.registrationState.value
      tReg.text = "Registration: ${reg.name}" + if (reg != RegistrationState.REGISTERED) "  — open Meta AI → Developer Mode, then Register" else ""
      val st = GlassLink.states.value
      tStates.text = st.entries.sortedBy { it.key }.joinToString("\n") { "${it.key.padEnd(16)} ${it.value}" }.ifEmpty { "–" }
      tDevice.text = GlassLink.device.value.entries.joinToString("\n") { "${it.key.padEnd(9)} ${it.value}" }.ifEmpty { "no device yet" }
      tRates.text = GlassLink.counters.value.entries.sortedBy { it.key }.joinToString("\n") { "${it.key.padEnd(18)} ${it.value}/s" }.ifEmpty { "–" }
      tLog.text = GlassLink.logLines.value.take(40).joinToString("\n")
      bSession.text = if (GlassLink.sessionActive()) "Stop session" else "Start session (${st["session"] ?: "idle"})"
      tPrompt.text = GlassLink.prompt.value
      tPrompt.visibility = if (GlassLink.prompt.value.isEmpty()) View.GONE else View.VISIBLE
      bTests.text = if (DatTests.running.value) "Stop tests" else "Run all DAT tests"
      val res = DatTests.results.value
      tTests.text = (listOf(DatTests.current.value) + res.map { r ->
        val g = mapOf("pass" to "✓", "fail" to "✗", "warn" to "!", "skip" to "·", "unsupported" to "–")[r.optString("status")] ?: "?"
        "$g ${r.optString("title")} · ${r.optString("notes")}"
      }).filter { it.isNotEmpty() }.joinToString("\n")
      delay(500)
    }
  }

  // ---------------------------------------------------------------- widgets
  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
  private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

  private fun text(s: String, size: Float, tf: Typeface, color: Int = ink) = TextView(this).apply {
    text = s; textSize = size; typeface = tf; setTextColor(color); setLineSpacing(0f, 1.15f)
  }

  private fun mono() = TextView(this).apply { typeface = mono; textSize = 12f; setTextColor(ink); setTextIsSelectable(true) }

  private fun section(title: String) {
    root.addView(View(this).apply { setBackgroundColor(rule) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply { topMargin = dp(18); bottomMargin = dp(8) })
    root.addView(text(title, 18f, serifB))
  }

  private fun edit(hint: String, type: Int) = EditText(this).apply {
    this.hint = hint; inputType = InputType.TYPE_CLASS_TEXT or type; typeface = serif; setTextColor(ink); setSingleLine()
  }

  private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
    text = label; isAllCaps = false; typeface = serif; setTextColor(ink)
    background = GradientDrawable().apply { setColor(Color.WHITE); setStroke(dp(1), rule); cornerRadius = dp(6).toFloat() }
    setOnClickListener { onClick() }
  }

  private fun row(vararg v: View) = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    v.forEachIndexed { i, x -> addView(x, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (i > 0) leftMargin = dp(8); topMargin = dp(6) }) }
  }

  @Suppress("DEPRECATION")
  private fun switch(label: String, on: Boolean, cb: (Boolean) -> Unit) = Switch(this).apply {
    text = label; typeface = serif; textSize = 15f; setTextColor(ink); isChecked = on; setPadding(0, dp(6), 0, dp(6))
    setOnCheckedChangeListener { _: CompoundButton, c: Boolean -> cb(c) }
  }

  private fun spinner(label: String, items: List<String>, sel: String, cb: (String) -> Unit): View {
    val sp = Spinner(this)
    sp.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, items)
    sp.setSelection(items.indexOf(sel).coerceAtLeast(0), false)
    var first = true
    sp.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
      override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) { if (first) { first = false; return }; cb(items[pos]) }
      override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
    }
    return LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      addView(text(label, 15f, serif), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(sp)
    }
  }
}
