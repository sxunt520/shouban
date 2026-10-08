package com.yuzhou.provisioning

import android.Manifest
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothDevice
import android.bluetooth.le.ScanResult
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.espressif.provisioning.DeviceConnectionEvent
import com.espressif.provisioning.ESPConstants
import com.espressif.provisioning.ESPDevice
import com.espressif.provisioning.ESPProvisionManager
import com.espressif.provisioning.WiFiAccessPoint
import com.espressif.provisioning.listeners.BleScanListener
import com.espressif.provisioning.listeners.ProvisionListener
import com.espressif.provisioning.listeners.ResponseListener
import com.espressif.provisioning.listeners.WiFiScanListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.greenrobot.eventbus.EventBus
import org.greenrobot.eventbus.Subscribe
import org.greenrobot.eventbus.ThreadMode
import java.util.concurrent.ConcurrentHashMap

class YuzhouProvisioningModule : Module() {
  private data class BleCandidate(
    val device: BluetoothDevice,
    val serviceUuid: String,
    val name: String,
    val rssi: Int,
  )

  private val mainHandler = Handler(Looper.getMainLooper())
  private val candidates = ConcurrentHashMap<String, BleCandidate>()
  private var manager: ESPProvisionManager? = null
  private var activeDevice: ESPDevice? = null
  private var connectPromise: Promise? = null
  private var connectTimeout: Runnable? = null

  override fun definition() = ModuleDefinition {
    Name("YuzhouProvisioning")

    OnCreate {
      val context = appContext.reactContext
        ?: throw IllegalStateException("React context is unavailable")
      manager = ESPProvisionManager.getInstance(context.applicationContext)
      if (!EventBus.getDefault().isRegistered(this@YuzhouProvisioningModule)) {
        EventBus.getDefault().register(this@YuzhouProvisioningModule)
      }
    }

    OnDestroy {
      connectTimeout?.let(mainHandler::removeCallbacks)
      connectTimeout = null
      connectPromise?.reject("E_CANCELLED", "配网连接已关闭", null)
      connectPromise = null
      activeDevice?.disconnectDevice()
      activeDevice = null
      manager?.stopBleScan()
      if (EventBus.getDefault().isRegistered(this@YuzhouProvisioningModule)) {
        EventBus.getDefault().unregister(this@YuzhouProvisioningModule)
      }
    }

    AsyncFunction("getEnvironmentStatus") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_NOT_READY", "手机环境检测模块尚未初始化", null)
        return@AsyncFunction
      }

      try {
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val networkConnected: Boolean
        val networkType: String
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          val capabilities = connectivity.activeNetwork?.let(connectivity::getNetworkCapabilities)
          networkConnected = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
          networkType = when {
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "wifi"
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "cellular"
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "ethernet"
            networkConnected -> "other"
            else -> "none"
          }
        } else {
          @Suppress("DEPRECATION")
          val info = connectivity.activeNetworkInfo
          @Suppress("DEPRECATION")
          networkConnected = info?.isConnected == true
          @Suppress("DEPRECATION")
          networkType = when (info?.type) {
            ConnectivityManager.TYPE_WIFI -> "wifi"
            ConnectivityManager.TYPE_MOBILE -> "cellular"
            ConnectivityManager.TYPE_ETHERNET -> "ethernet"
            else -> if (networkConnected) "other" else "none"
          }
        }

        val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val bluetoothPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
          true
        }
        val bluetoothEnabled = try {
          bluetoothManager.adapter?.isEnabled == true
        } catch (_: SecurityException) {
          false
        }

        val locationRequired = Build.VERSION.SDK_INT <= Build.VERSION_CODES.R
        val locationPermission = !locationRequired ||
          context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as android.location.LocationManager
        val locationEnabled = if (!locationRequired) {
          true
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          locationManager.isLocationEnabled
        } else {
          @Suppress("DEPRECATION")
          locationManager.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) ||
            locationManager.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER)
        }
        val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

        promise.resolve(
          mapOf(
            "networkConnected" to networkConnected,
            "networkType" to networkType,
            "wifiEnabled" to wifiManager.isWifiEnabled,
            "bluetoothEnabled" to bluetoothEnabled,
            "bluetoothPermission" to bluetoothPermission,
            "locationRequired" to locationRequired,
            "locationEnabled" to locationEnabled,
            "locationPermission" to locationPermission,
          ),
        )
      } catch (error: Exception) {
        promise.reject("E_ENVIRONMENT_CHECK", error.message ?: "无法检测手机连接环境", error)
      }
    }

    AsyncFunction("openSystemSettings") { section: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("E_NOT_READY", "手机设置暂时无法打开", null)
        return@AsyncFunction
      }
      try {
        val intent = when (section) {
          "network" -> Intent(Settings.ACTION_WIFI_SETTINGS)
          "bluetooth" -> Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
          "location" -> Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
          else -> Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${context.packageName}"),
          )
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("E_OPEN_SETTINGS", "无法打开系统设置", error)
      }
    }

    AsyncFunction("scanDevices") { prefix: String, promise: Promise ->
      val provisionManager = manager
      if (provisionManager == null) {
        promise.reject("E_NOT_READY", "蓝牙配网模块尚未初始化", null)
        return@AsyncFunction
      }

      candidates.clear()
      try {
        provisionManager.searchBleEspDevices(prefix, object : BleScanListener {
          override fun scanStartFailed() {
            promise.reject("E_BLUETOOTH_OFF", "请先开启手机蓝牙", null)
          }

          override fun onPeripheralFound(device: BluetoothDevice, scanResult: ScanResult) {
            val record = scanResult.scanRecord ?: return
            val serviceUuid = record.serviceUuids?.firstOrNull()?.toString() ?: return
            val name = record.deviceName ?: device.name ?: "屿宙智能底座"
            candidates[device.address] = BleCandidate(device, serviceUuid, name, scanResult.rssi)
          }

          override fun scanCompleted() {
            val result = candidates.map { (id, candidate) ->
              mapOf(
                "id" to id,
                "name" to candidate.name,
                "rssi" to candidate.rssi,
                "serviceUuid" to candidate.serviceUuid,
              )
            }.sortedByDescending { (it["rssi"] as? Int) ?: -127 }
            promise.resolve(result)
          }

          override fun onFailure(error: Exception) {
            promise.reject("E_SCAN_FAILED", error.message ?: "搜索智能底座失败", error)
          }
        })
      } catch (error: Exception) {
        promise.reject("E_SCAN_FAILED", error.message ?: "搜索智能底座失败", error)
      }
    }

    AsyncFunction("stopScan") {
      manager?.stopBleScan()
    }

    AsyncFunction("connect") { deviceId: String, pop: String, security: Int, promise: Promise ->
      val candidate = candidates[deviceId]
      val provisionManager = manager
      if (candidate == null || provisionManager == null) {
        promise.reject("E_DEVICE_NOT_FOUND", "底座已离开，请重新搜索", null)
        return@AsyncFunction
      }
      if (connectPromise != null) {
        promise.reject("E_CONNECTING", "正在连接另一台底座", null)
        return@AsyncFunction
      }

      val securityType = when (security) {
        0 -> ESPConstants.SecurityType.SECURITY_0
        2 -> ESPConstants.SecurityType.SECURITY_2
        else -> ESPConstants.SecurityType.SECURITY_1
      }
      val device = provisionManager.createESPDevice(
        ESPConstants.TransportType.TRANSPORT_BLE,
        securityType,
      )
      device.setProofOfPossession(pop)
      activeDevice = device
      connectPromise = promise

      val timeout = Runnable {
        connectPromise?.reject("E_CONNECT_TIMEOUT", "连接底座超时，请确认屏幕显示 SETUP", null)
        connectPromise = null
        activeDevice?.disconnectDevice()
      }
      connectTimeout = timeout
      mainHandler.postDelayed(timeout, 20_000)

      try {
        device.connectBLEDevice(candidate.device, candidate.serviceUuid)
      } catch (error: Exception) {
        mainHandler.removeCallbacks(timeout)
        connectTimeout = null
        connectPromise = null
        promise.reject("E_CONNECT_FAILED", error.message ?: "连接智能底座失败", error)
      }
    }

    AsyncFunction("scanWifiNetworks") { promise: Promise ->
      val device = activeDevice
      if (device == null) {
        promise.reject("E_NOT_CONNECTED", "请先连接智能底座", null)
        return@AsyncFunction
      }
      device.scanNetworks(object : WiFiScanListener {
        override fun onWifiListReceived(wifiList: ArrayList<WiFiAccessPoint>) {
          val result = wifiList
            .distinctBy { it.wifiName }
            .map {
              mapOf(
                "ssid" to it.wifiName,
                "rssi" to it.rssi,
                "security" to it.security,
              )
            }
            .sortedByDescending { (it["rssi"] as? Int) ?: -127 }
          promise.resolve(result)
        }

        override fun onWiFiScanFailed(error: Exception) {
          promise.reject("E_WIFI_SCAN_FAILED", error.message ?: "底座扫描 Wi-Fi 失败", error)
        }
      })
    }

    AsyncFunction("provision") { ssid: String, password: String, apiBaseUrl: String, promise: Promise ->
      val device = activeDevice
      if (device == null) {
        promise.reject("E_NOT_CONNECTED", "请先连接智能底座", null)
        return@AsyncFunction
      }
      if (apiBaseUrl.isBlank()) {
        promise.reject("E_BACKEND_ADDRESS", "请先设置后端服务地址", null)
        return@AsyncFunction
      }
      device.sendDataToCustomEndPoint(
        "yuzhou-config",
        apiBaseUrl.toByteArray(Charsets.UTF_8),
        object : ResponseListener {
          override fun onSuccess(returnData: ByteArray) {
            val response = returnData.toString(Charsets.UTF_8).trim { it <= ' ' || it == '\u0000' }
            if (response != "SUCCESS") {
              promise.reject("E_BACKEND_ADDRESS", "底座未接受后端服务地址", null)
              return
            }
            provisionWifi(device, ssid, password, promise)
          }

          override fun onFailure(error: Exception) {
            promise.reject(
              "E_BACKEND_ADDRESS",
              "发送后端服务地址失败，请确认底座固件已更新",
              error,
            )
          }
        },
      )
    }

    AsyncFunction("disconnect") {
      activeDevice?.disconnectDevice()
      activeDevice = null
      Unit
    }
  }

  private fun provisionWifi(device: ESPDevice, ssid: String, password: String, promise: Promise) {
    device.provision(ssid, password, object : ProvisionListener {
        override fun createSessionFailed(error: Exception) =
          rejectProvision(promise, "E_SESSION_FAILED", "安全会话建立失败，请核对底座二维码", error)

        override fun wifiConfigSent() = Unit

        override fun wifiConfigFailed(error: Exception) =
          rejectProvision(promise, "E_SEND_FAILED", "发送 Wi-Fi 信息失败", error)

        override fun wifiConfigApplied() = Unit

        override fun wifiConfigApplyFailed(error: Exception) =
          rejectProvision(promise, "E_APPLY_FAILED", "底座无法应用 Wi-Fi 信息", error)

        override fun provisioningFailedFromDevice(reason: ESPConstants.ProvisionFailureReason) {
          val message = when (reason) {
            ESPConstants.ProvisionFailureReason.AUTH_FAILED -> "Wi-Fi 密码错误"
            ESPConstants.ProvisionFailureReason.NETWORK_NOT_FOUND -> "底座找不到该 Wi-Fi，请确认是 2.4GHz"
            ESPConstants.ProvisionFailureReason.DEVICE_DISCONNECTED -> "底座蓝牙连接已断开"
            else -> "底座联网失败"
          }
          rejectProvision(promise, "E_PROVISION_FAILED", message, null)
        }

        override fun deviceProvisioningSuccess() {
          promise.resolve(mapOf("success" to true, "ssid" to ssid))
        }

        override fun onProvisioningFailed(error: Exception) =
          rejectProvision(promise, "E_PROVISION_FAILED", error.message ?: "底座联网失败", error)
      })
  }

  @Subscribe(threadMode = ThreadMode.MAIN)
  fun onDeviceConnectionEvent(event: DeviceConnectionEvent) {
    val promise = connectPromise ?: return
    when (event.eventType) {
      ESPConstants.EVENT_DEVICE_CONNECTED -> {
        connectTimeout?.let(mainHandler::removeCallbacks)
        connectTimeout = null
        connectPromise = null
        promise.resolve(mapOf("connected" to true))
      }
      ESPConstants.EVENT_DEVICE_CONNECTION_FAILED -> {
        connectTimeout?.let(mainHandler::removeCallbacks)
        connectTimeout = null
        connectPromise = null
        promise.reject("E_CONNECT_FAILED", "无法连接智能底座，请重新搜索", null)
      }
      ESPConstants.EVENT_DEVICE_DISCONNECTED -> {
        connectTimeout?.let(mainHandler::removeCallbacks)
        connectTimeout = null
        connectPromise = null
        promise.reject("E_DISCONNECTED", "底座蓝牙连接已断开", null)
      }
    }
  }

  private fun rejectProvision(promise: Promise, code: String, message: String, error: Throwable?) {
    promise.reject(code, message, error)
  }
}
