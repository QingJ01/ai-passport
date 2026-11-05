const {
  withAppBuildGradle,
  withProjectBuildGradle,
  withDangerousMod,
  withGradleProperties,
  withAndroidManifest,
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");
module.exports = function (config) {
  config = withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application[0];
    app.$["android:networkSecurityConfig"] =
      "@xml/agentpet_network_security_config";
    app.$["android:allowBackup"] = "false";
    return c;
  });
  config = withGradleProperties(config, (c) => {
    c.modResults = c.modResults.filter(
      (x) => x.key !== "android.minSdkVersion",
    );
    c.modResults.push({
      type: "property",
      key: "android.minSdkVersion",
      value: "26",
    });
    return c;
  });
  config = withProjectBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes("https://jitpack.io"))
      c.modResults.contents = c.modResults.contents.replace(
        "mavenCentral()",
        "mavenCentral()\n        maven { url 'https://jitpack.io' }",
      );
    return c;
  });
  config = withAppBuildGradle(config, (c) => {
    let s = c.modResults.contents;
    // Espressif Android logs PoP at DEBUG. R8 strips release logs; the native bridge rejects debuggable BLE.
    if (
      !s.includes(
        "buildTypes {\n        debug {\n            minifyEnabled true",
      )
    )
      s = s.replace(
        "buildTypes {\n        debug {",
        'buildTypes {\n        debug {\n            minifyEnabled true\n            proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"',
      );
    s = s.replace(
      "minifyEnabled enableMinifyInReleaseBuilds",
      "minifyEnabled true",
    );
    c.modResults.contents = s;
    return c;
  });
  config = withDangerousMod(config, [
    "android",
    async (c) => {
      const p = path.join(
        c.modRequest.platformProjectRoot,
        "app/proguard-rules.pro",
      );
      const xml = path.join(
        c.modRequest.platformProjectRoot,
        "app/src/main/res/xml/agentpet_network_security_config.xml",
      );
      fs.mkdirSync(path.dirname(xml), { recursive: true });
      fs.writeFileSync(
        xml,
        '<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /><certificates src="user" /></trust-anchors></base-config></network-security-config>\n',
      );
      // Metro uses HTTP in debug; the native service transport still refuses HTTP in every variant.
      const debugXml = path.join(
        c.modRequest.platformProjectRoot,
        "app/src/debug/res/xml/agentpet_network_security_config.xml",
      );
      fs.mkdirSync(path.dirname(debugXml), { recursive: true });
      fs.writeFileSync(
        debugXml,
        '<network-security-config><base-config cleartextTrafficPermitted="true"><trust-anchors><certificates src="system" /><certificates src="user" /></trust-anchors></base-config></network-security-config>\n',
      );
      const wrapper = path.join(
        c.modRequest.platformProjectRoot,
        "gradle/wrapper/gradle-wrapper.properties",
      );
      if (fs.existsSync(wrapper)) {
        let props = fs.readFileSync(wrapper, "utf8");
        props = props.replace(/^networkTimeout=.*$/m, "networkTimeout=120000");
        if (
          props.includes("gradle-8.14.3-bin.zip") &&
          !props.includes("distributionSha256Sum=")
        )
          props +=
            "\ndistributionSha256Sum=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531\n";
        fs.writeFileSync(wrapper, props);
      }
      const marker = "-assumenosideeffects class android.util.Log";
      const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      let rules = existing;
      if (!rules.includes(marker))
        rules +=
          "\n" +
          marker +
          " { public static *** d(...); public static *** v(...); public static *** i(...); public static *** w(...); public static *** e(...); }\n";
      if (!rules.includes("org.greenrobot.eventbus.Subscribe"))
        rules +=
          "\n-keepattributes *Annotation*\n-keepclassmembers class * { @org.greenrobot.eventbus.Subscribe <methods>; }\n";
      fs.writeFileSync(p, rules);
      return c;
    },
  ]);
  return config;
};
