# Optional macOS system Ruby 2.6/Xcode SDK compatibility for project-local Bundler.
# No system files are changed. Modern Ruby users should not load this helper.
require 'rbconfig'
if RUBY_VERSION.start_with?('2.6.') && ENV['AGENTPET_RUBY_ARCH_HEADERS']
  headers = ENV.fetch('AGENTPET_RUBY_ARCH_HEADERS')
  abort 'Ruby SDK headers missing' unless File.file?(File.join(headers, 'ruby/config.h'))
  RbConfig::CONFIG['rubyarchhdrdir'] = headers
  RbConfig::MAKEFILE_CONFIG['rubyarchhdrdir'] = headers
end
