# The routes ship without a security layer of their own

The Host's routes carry no loopback check, CSRF tripwire, proxy token or body
cap. The web profile binds `127.0.0.1` by default
(`dsh-web-app/cordis.patch.yml`: `ctx.webStartup.host ?? '127.0.0.1'`), and a
LAN-exposed port requires someone to deliberately reconfigure the deployment.
Defending each route against a configuration nobody made is code for an
imagined threat, and every plugin judging its own exposure is the wrong
layer: the fix for an exposed port belongs to the bind address.

## Considered Options

Copying the reference plugin's defences (loopback check, CSRF tripwire, proxy
token, body cap) — rejected: that plugin ships to every DSH user and must
assume hostile deployments; this bundle runs on the author's own machine for
their own campaign.

## Consequences

If the deployment ever leaves loopback, tighten the bind address or add
protection at the platform level — do not sprinkle per-route checks. The one
load-bearing correctness requirement that remains is not a security one:
`webServer.register()`'s disposer must be handed to `ctx.effect()`, or a hot
reload fails to remount the routes outright.
