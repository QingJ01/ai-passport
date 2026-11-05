import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Store } from "./security.mjs";
import { key, id } from "./model.mjs";
// Offline operator tool; restart service after changing its credential store.
const [configArg, operation, accountArg, identityArg, outputArg] =
  process.argv.slice(2);
if (!configArg || !operation || !accountArg)
  throw new Error(
    "Usage: node src/admin.mjs CONFIG issue-controller ACCOUNT ID OUTPUT | issue-source ACCOUNT SOURCE OUTPUT | bind-device ACCOUNT DEVICE OUTPUT | revoke-device ACCOUNT DEVICE",
  );
const configPath = resolve(configArg),
  base = dirname(configPath),
  config = JSON.parse(readFileSync(configPath, "utf8")),
  store = new Store(resolve(base, config.store));
const account_id = key(accountArg),
  identity = key(identityArg ?? "controller");
if (operation === "revoke-device") {
  store.revoke({ account_id, role: "controller" }, identity);
  console.log(
    "Device revoked. Restart the stopped service before reconnecting.",
  );
} else {
  const role = {
    "issue-controller": "controller",
    "issue-source": "source",
    "bind-device": "device",
  }[operation];
  if (!role || !outputArg)
    throw new Error("Invalid operation or missing restricted output path");
  let source_id = role === "source" ? identity : null;
  if (role === "device") {
    source_id = "magpie";
    if (store.data.devices.some((d) => d.id === identity))
      throw new Error("Device already exists");
    if (
      !store.data.credentials.some(
        (c) =>
          c.account_id === account_id &&
          c.source_id === source_id &&
          c.role === "source" &&
          !c.revoked,
      )
    )
      throw new Error("Issue source magpie for account first");
    store.data.devices.push({
      id: identity,
      account_id,
      source_id,
      remote_enabled: false,
      view_epoch: id(),
      mode: "private",
      revoked: false,
    });
  }
  const token = store.issue({
    account_id,
    role,
    source_id,
    device_id: role === "device" ? identity : null,
    ttl: 86400 * 30,
  });
  writeFileSync(
    resolve(outputArg),
    JSON.stringify({
      account_id,
      role,
      source_id,
      device_id: role === "device" ? identity : null,
      credential: token,
    }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Credential written to the requested restricted file; restart the stopped service.",
  );
}
