Pod::Spec.new do |s|
  s.name           = 'YuzhouProvisioning'
  s.version        = '0.1.0'
  s.summary        = 'Secure BLE provisioning bridge for 屿宙AI手办'
  s.description    = 'Expo native module wrapping Espressif ESP-IDF provisioning.'
  s.author         = '屿宙AI手办'
  s.homepage       = 'https://github.com/espressif/esp-idf-provisioning-ios'
  s.platforms      = { :ios => '13.4' }
  s.swift_version  = '5.4'
  s.source         = { :git => 'https://github.com/espressif/esp-idf-provisioning-ios.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ESPProvision', '3.1.0'

  s.source_files = '**/*.swift'
end
