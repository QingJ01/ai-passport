import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const app = fileURLToPath(new URL('../android/app/', import.meta.url));
const key = join(app, 'debug.keystore');
if (!existsSync(join(app, 'build.gradle'))) {
  throw Error('Run npm run prebuild before building Android.');
}
if (!existsSync(key)) {
  // Public, standard Android development credentials. Never use this key for distribution.
  // The generated private key stays in ignored build inputs, outside source configuration.
  const tool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'keytool') : 'keytool';
  const result = spawnSync(tool, ['-genkeypair', '-noprompt', '-keystore', key,
    '-storetype', 'JKS', '-storepass', 'android', '-alias', 'androiddebugkey',
    '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', 'CN=Android Debug,O=Android,C=US'], {stdio:'inherit'});
  if (result.error || result.status !== 0) throw Error('Development signing key generation failed. Configure JAVA_HOME with JDK 17.');
}
