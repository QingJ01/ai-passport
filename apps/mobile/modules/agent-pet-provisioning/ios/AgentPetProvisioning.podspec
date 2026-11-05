Pod::Spec.new do |s|
  s.name = 'AgentPetProvisioning'
  s.version = '0.1.0'
  s.summary = 'Agent Pet secure BLE provisioning bridge'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Agent Pet contributors'
  s.homepage = 'https://github.com/FoloToy/ai-passport'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'ESPProvision', '3.0.3'
  s.source_files = '**/*.swift'
  s.swift_version = '5.9'
end
