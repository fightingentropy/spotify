require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AudioEngine'
  s.version        = package['version'] || '1.0.0'
  s.summary        = 'Native dual-deck AVPlayer crossfade engine'
  s.description    = 'Native dual-deck AVPlayer crossfade engine with lock-screen Now Playing + background audio'
  s.license        = 'MIT'
  s.author         = ''
  s.homepage       = 'https://github.com/local/audio-engine'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
