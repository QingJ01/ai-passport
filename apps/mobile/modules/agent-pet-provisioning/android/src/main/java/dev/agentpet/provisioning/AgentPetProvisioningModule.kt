package dev.agentpet.provisioning

import android.bluetooth.BluetoothDevice
import android.bluetooth.le.ScanResult
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import com.espressif.provisioning.*
import com.espressif.provisioning.listeners.*
import org.greenrobot.eventbus.EventBus
import org.greenrobot.eventbus.Subscribe
import org.greenrobot.eventbus.ThreadMode
import org.json.JSONObject

class AgentPetProvisioningModule : Module() {
  private var device: ESPDevice? = null
  private var pending: Promise? = null
  private var manager: ESPProvisionManager? = null
  private var generation = 0
  private var connecting = false
  override fun definition() = ModuleDefinition {
    Name("AgentPetProvisioning")
    AsyncFunction("request") { url: String, method: String, token: String, body: String?, pin: String?, promise: Promise ->
      RelayRequest.send(url, method, token, body, pin, promise)
    }
    // Best effort: Android reports the SSID only with location permission granted and location services on.
    AsyncFunction("currentWifiName") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      val wifi = context.applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
        ?: return@AsyncFunction null
      @Suppress("DEPRECATION")
      val raw = try { wifi.connectionInfo?.ssid } catch (e: SecurityException) { null }
      val name = raw?.removeSurrounding("\"")
      if (name.isNullOrEmpty() || name == "<unknown ssid>" || name.toByteArray().size > 32) null else name
    }
    AsyncFunction("connectSecure") { name: String, pop: String, serviceUuid: String, promise: Promise ->
      close()
      val current = generation
      val context = appContext.reactContext ?: throw IllegalStateException("No activity")
      // AGP disables R8 optimizations for debuggable variants. Never expose PoP to the SDK there.
      if ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
        promise.reject("RELEASE_REQUIRED", "Install the optimized Android release build for Wi-Fi setup. Debug builds cannot safely run this SDK's credential logging.", null)
        return@AsyncFunction
      }
      manager = ESPProvisionManager.getInstance(context)
      device = manager!!.createESPDevice(ESPConstants.TransportType.TRANSPORT_BLE, ESPConstants.SecurityType.SECURITY_1)
      device!!.proofOfPossession = pop
      pending = promise
      EventBus.getDefault().register(this@AgentPetProvisioningModule)
      manager!!.searchBleEspDevices(name, object : BleScanListener {
        override fun scanStartFailed() { fail("Bluetooth scan could not start") }
        override fun onPeripheralFound(found: BluetoothDevice, result: ScanResult) {
          if (current != generation || found.name != name || pending == null || connecting) return
          connecting = true
          manager?.stopBleScan()
          device?.connectBLEDevice(found, serviceUuid)
        }
        override fun scanCompleted() { /* global JS timeout closes this session */ }
        override fun onFailure(e: Exception) { fail("Bluetooth scan failed") }
      })
    }
    AsyncFunction("exchange") { path: String, payload: String, promise: Promise ->
      if (path != "agentpet-setup" || payload.toByteArray().size > 8192 || device == null) {
        promise.reject("SESSION", "No authenticated setup session", null)
      } else device!!.sendDataToCustomEndPoint(path, payload.toByteArray(Charsets.UTF_8), object : ResponseListener {
        override fun onSuccess(data: ByteArray?) {
          if (data == null || data.size > 8192) promise.reject("ENDPOINT", "Invalid response", null)
          else promise.resolve(String(data, Charsets.UTF_8))
        }
        override fun onFailure(e: Exception) { promise.reject("ENDPOINT", "Firmware endpoint unavailable or rejected request", null) }
      })
    }
    AsyncFunction("provision") { ssid: String, passphrase: String, promise: Promise ->
      val d = device ?: throw IllegalStateException("Setup expired")
      d.provision(ssid, passphrase, object : ProvisionListener {
        override fun createSessionFailed(e: Exception) { promise.reject("AUTH", "Secure session failed", null) }
        override fun wifiConfigSent() {}
        override fun wifiConfigFailed(e: Exception) { promise.reject("WIFI", "Wi-Fi configuration failed", null) }
        override fun wifiConfigApplied() {}
        override fun wifiConfigApplyFailed(e: Exception) { promise.reject("WIFI", "Candidate network rejected", null) }
        override fun provisioningFailedFromDevice(reason: ESPConstants.ProvisionFailureReason) { promise.reject("WIFI", "Check credentials and 2.4 GHz availability", null) }
        override fun deviceProvisioningSuccess() { promise.resolve(null) }
        override fun onProvisioningFailed(e: Exception) { promise.reject("WIFI", "Wi-Fi connection failed", null) }
      })
    }
    AsyncFunction("disconnect") { close() }
    OnDestroy { close() }
  }
  @Subscribe(threadMode = ThreadMode.MAIN)
  fun onConnection(event: DeviceConnectionEvent) {
    if (event.eventType != ESPConstants.EVENT_DEVICE_CONNECTED) {
      if (event.eventType == ESPConstants.EVENT_DEVICE_CONNECTION_FAILED || event.eventType == ESPConstants.EVENT_DEVICE_DISCONNECTED) fail("Device disconnected")
      return
    }
    if (pending == null) return
    val current = generation
    val d = device ?: return
    // Upstream Android negotiates the advertised scheme automatically. Reject downgrade BEFORE initSession.
    val version = try { JSONObject(d.versionInfo).getJSONObject("prov") } catch (e: Exception) { fail("Missing security capabilities"); return }
    if (version.optInt("sec_ver", -1) != 1 || d.deviceCapabilities.contains("no_pop")) { fail("Security1 proof of possession required"); return }
    d.initSession(object : ResponseListener {
      override fun onSuccess(data: ByteArray?) { if (current == generation) { pending?.resolve(null); pending = null } }
      override fun onFailure(e: Exception) { if (current == generation) fail("Proof of possession failed. Scan a fresh code.") }
    })
  }
  private fun fail(message: String) { pending?.reject("BLE_AUTH", message, null); pending = null; close() }
  private fun close() {
    generation++
    connecting = false
    if (EventBus.getDefault().isRegistered(this)) EventBus.getDefault().unregister(this)
    manager?.stopBleScan()
    val old = device; device = null
    pending?.reject("CANCELLED", "Setup closed", null); pending = null
    old?.disconnectDevice()
  }
}
