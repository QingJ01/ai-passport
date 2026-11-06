import ExpoModulesCore
import ESPProvision
import NetworkExtension

public class AgentPetProvisioningModule: Module {
  private var device: ESPDevice?
  private var generation = 0
  private var searching = false
  public func definition() -> ModuleDefinition {
    Name("AgentPetProvisioning")
    AsyncFunction("request") { (url: String, method: String, token: String, body: String?, pin: String?, promise: Promise) in
      _ = RelayRequest(url: url, method: method, token: token, body: body, pin: pin, promise: promise)
    }
    // Best effort only: iOS returns nil unless the app has the Wi-Fi information entitlement and location access.
    AsyncFunction("currentWifiName") { (promise: Promise) in
      NEHotspotNetwork.fetchCurrent { network in
        let name = network?.ssid
        promise.resolve(name.flatMap { $0.isEmpty || $0.utf8.count > 32 ? nil : $0 })
      }
    }
    AsyncFunction("connectSecure") { (name: String, pop: String, promise: Promise) in
      ESPProvisionManager.shared.enableLogs(false)
      self.generation += 1
      let current = self.generation
      self.device?.disconnect()
      self.searching = true
      ESPProvisionManager.shared.createESPDevice(deviceName: name, transport: .ble, security: .secure, proofOfPossession: pop) { selectedDevice, error in
        self.searching = false
        guard current == self.generation else { promise.reject("CANCELLED", "Setup cancelled"); return }
        guard error == nil, let selected = selectedDevice, selected.name == name else {
          promise.reject("BLE_SCAN", "Device not found. Reopen its setup window and check Bluetooth permission."); return
        }
        self.device = selected
        selected.connect { status in
          guard current == self.generation else { selected.disconnect(); promise.reject("CANCELLED", "Setup cancelled"); return }
          switch status {
          case .connected:
            let prov = selected.versionInfo?["prov"] as? NSDictionary
            guard prov?["sec_ver"] as? Int == 1,
                  !(selected.capabilities ?? []).contains("no_pop"),
                  selected.isSessionEstablished() else {
              selected.disconnect(); self.device = nil
              promise.reject("SECURITY", "Device does not require Security1 proof of possession"); return
            }
            promise.resolve(nil)
          case .failedToConnect:
            selected.disconnect(); self.device = nil
            promise.reject("BLE_AUTH", "Secure session failed. Scan a fresh pairing code.")
          case .disconnected: break
          }
        }
      }
    }.runOnQueue(.main)
    AsyncFunction("exchange") { (path: String, payload: String, promise: Promise) in
      guard path == "agentpet-setup", payload.utf8.count <= 8192, let device = self.device, device.isSessionEstablished() else {
        promise.reject("SESSION", "No authenticated setup session"); return
      }
      device.sendData(path: path, data: Data(payload.utf8)) { data, error in
        guard error == nil, let data = data, data.count <= 8192, let text = String(data: data, encoding: .utf8) else {
          promise.reject("ENDPOINT", "Firmware setup endpoint unavailable or rejected the request"); return
        }
        promise.resolve(text)
      }
    }.runOnQueue(.main)
    AsyncFunction("provision") { (ssid: String, passphrase: String, promise: Promise) in
      guard let device = self.device, device.isSessionEstablished() else { promise.reject("SESSION", "Setup expired"); return }
      device.provision(ssid: ssid, passPhrase: passphrase) { status in
        switch status {
        case .success: promise.resolve(nil)
        case .failure: promise.reject("WIFI", "Wi-Fi failed. Check credentials and 2.4 GHz availability.")
        case .configApplied: break
        }
      }
    }.runOnQueue(.main)
    AsyncFunction("disconnect") {
      self.generation += 1
      self.device?.disconnect()
      self.device = nil
      if self.searching { ESPProvisionManager.shared.stopESPDevicesSearch(); self.searching = false }
    }.runOnQueue(.main)
  }
}
