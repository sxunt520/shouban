import ExpoModulesCore
import ESPProvision
import CoreBluetooth
import Network
import UIKit

public class YuzhouProvisioningModule: Module, ESPDeviceConnectionDelegate, CBCentralManagerDelegate {
  private var devices: [String: ESPDevice] = [:]
  private var activeDevice: ESPDevice?
  private var proofOfPossession = ""
  private var environmentBluetoothManager: CBCentralManager?
  private var environmentPathMonitor: NWPathMonitor?

  public func definition() -> ModuleDefinition {
    Name("YuzhouProvisioning")

    AsyncFunction("getEnvironmentStatus") { (promise: Promise) in
      DispatchQueue.main.async {
        if self.environmentBluetoothManager == nil {
          self.environmentBluetoothManager = CBCentralManager(
            delegate: self,
            queue: .main,
            options: [CBCentralManagerOptionShowPowerAlertKey: false]
          )
        }

        self.environmentPathMonitor?.cancel()
        let monitor = NWPathMonitor()
        self.environmentPathMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
          let bluetoothState = self?.environmentBluetoothManager?.state ?? .unknown
          let bluetoothAuthorization = CBCentralManager.authorization
          let networkType: String
          if path.usesInterfaceType(.wifi) {
            networkType = "wifi"
          } else if path.usesInterfaceType(.cellular) {
            networkType = "cellular"
          } else if path.usesInterfaceType(.wiredEthernet) {
            networkType = "ethernet"
          } else {
            networkType = path.status == .satisfied ? "other" : "none"
          }
          promise.resolve([
            "networkConnected": path.status == .satisfied,
            "networkType": networkType,
            "wifiEnabled": path.usesInterfaceType(.wifi),
            "bluetoothEnabled": bluetoothState == .poweredOn,
            "bluetoothPermission": bluetoothAuthorization == .allowedAlways,
            "locationRequired": false,
            "locationEnabled": true,
            "locationPermission": true
          ])
          monitor.cancel()
          self?.environmentPathMonitor = nil
        }
        monitor.start(queue: DispatchQueue.global(qos: .userInitiated))
      }
    }

    AsyncFunction("openSystemSettings") { (_: String, promise: Promise) in
      DispatchQueue.main.async {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
          promise.reject("E_OPEN_SETTINGS", "无法打开系统设置")
          return
        }
        UIApplication.shared.open(url, options: [:]) { opened in
          if opened {
            promise.resolve(nil)
          } else {
            promise.reject("E_OPEN_SETTINGS", "无法打开系统设置")
          }
        }
      }
    }

    AsyncFunction("scanDevices") { (prefix: String, promise: Promise) in
      ESPProvisionManager.shared.searchESPDevices(
        devicePrefix: prefix,
        transport: .ble,
        security: .secure
      ) { [weak self] foundDevices, error in
        guard let self else { return }
        if let error {
          promise.reject("E_SCAN_FAILED", error.localizedDescription)
          return
        }

        self.devices.removeAll()
        let result = (foundDevices ?? []).map { device -> [String: Any] in
          self.devices[device.name] = device
          return [
            "id": device.name,
            "name": device.name,
            "rssi": -50,
            "serviceUuid": ""
          ]
        }
        promise.resolve(result)
      }
    }

    AsyncFunction("stopScan") {
      ESPProvisionManager.shared.stopESPDevicesSearch()
    }

    AsyncFunction("connect") { (deviceId: String, pop: String, security: Int, promise: Promise) in
      guard let device = self.devices[deviceId] else {
        promise.reject("E_DEVICE_NOT_FOUND", "底座已离开，请重新搜索")
        return
      }

      self.proofOfPossession = pop
      device.security = ESPSecurity(rawValue: security)
      self.activeDevice = device
      device.connect(delegate: self) { status in
        switch status {
        case .connected:
          promise.resolve(["connected": true])
        case let .failedToConnect(error):
          promise.reject("E_CONNECT_FAILED", error.localizedDescription)
        case .disconnected:
          promise.reject("E_DISCONNECTED", "底座蓝牙连接已断开")
        default:
          break
        }
      }
    }

    AsyncFunction("scanWifiNetworks") { (promise: Promise) in
      guard let device = self.activeDevice else {
        promise.reject("E_NOT_CONNECTED", "请先连接智能底座")
        return
      }

      device.scanWifiList { networks, error in
        if let error {
          promise.reject("E_WIFI_SCAN_FAILED", error.localizedDescription)
          return
        }
        let result = (networks ?? []).map { network in
          [
            "ssid": network.ssid,
            "rssi": network.rssi,
            "security": Int(network.auth.rawValue)
          ] as [String: Any]
        }
        promise.resolve(result)
      }
    }

    AsyncFunction("provision") { (ssid: String, password: String, apiBaseUrl: String, promise: Promise) in
      guard let device = self.activeDevice else {
        promise.reject("E_NOT_CONNECTED", "请先连接智能底座")
        return
      }
      guard let apiData = apiBaseUrl.data(using: .utf8), !apiBaseUrl.isEmpty else {
        promise.reject("E_BACKEND_ADDRESS", "请先设置后端服务地址")
        return
      }

      device.sendData(path: "yuzhou-config", data: apiData) { response, error in
        if let error {
          promise.reject("E_BACKEND_ADDRESS", "发送后端服务地址失败：\(error.localizedDescription)")
          return
        }
        let responseText = response.flatMap { String(data: $0, encoding: .utf8) }?
          .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\0")))
        guard responseText == "SUCCESS" else {
          promise.reject("E_BACKEND_ADDRESS", "底座未接受后端服务地址")
          return
        }
        device.provision(ssid: ssid, passPhrase: password) { status in
          switch status {
          case .success:
            promise.resolve(["success": true, "ssid": ssid])
          case .configApplied:
            break
          case let .failure(error):
            promise.reject("E_PROVISION_FAILED", error.localizedDescription)
          }
        }
      }
    }

    AsyncFunction("disconnect") {
      self.activeDevice?.disconnect()
      self.activeDevice = nil
    }
  }

  public func getProofOfPossesion(
    forDevice device: ESPDevice,
    completionHandler: @escaping (String) -> Void
  ) {
    completionHandler(proofOfPossession)
  }

  public func getUsername(
    forDevice device: ESPDevice,
    completionHandler: @escaping (String?) -> Void
  ) {
    completionHandler(nil)
  }

  public func centralManagerDidUpdateState(_ central: CBCentralManager) {
    // The environment screen reads the current state on its next refresh.
  }
}
