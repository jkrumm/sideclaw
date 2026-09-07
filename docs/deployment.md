# Deployment — LaunchAgent, BTM denial, log discipline

Full forensic story behind why sideclaw runs the way it does. CLAUDE.md and
`.claude/rules/deployment.md` keep only the invariants (never start standalone,
use the tracked plist, logs live in `~/Library/Logs`); this is the "why", read
on demand before touching `com.jkrumm.sideclaw-server.plist` or
`scripts/sideclaw-start.sh` — the same story is also inline as comments in
both those files, since an editor there may never open this doc.

## Logs must live in `~/Library/Logs`, never `/tmp`

A KeepAlive agent opens its stdio exactly once, at spawn. macOS's periodic
cleanup sweeps `/tmp` files untouched for 3+ days, so after a sweep the
process keeps writing into an unlinked inode: `lsof` still shows the fd, `ls`
says the file is gone, and every line written since is unrecoverable — which
is how sideclaw ended up with no post-mortem at all (measured on this machine
2026-07-31: `lsof -p 895` showed `/private/tmp/sideclaw.log` and `.err` held
open while `ls /tmp/sideclaw.log` returned "No such file"). The paths live in
`com.jkrumm.sideclaw-server.plist`, and `make install-agent` copies that file
verbatim over the live one, so changing the live plist by hand is silently
reverted on the next install. Change the tracked file.

## The BTM denial — why the label and the wrapper script are load-bearing

The label is `com.jkrumm.sideclaw-server` and the program is a wrapper script
— both are Background Task Management workarounds, not style. macOS computes
an *effective* disposition for every launch item, and on this host two
separate denials applied: `/opt/homebrew/bin/bun` as an executable, and the
identifier `8.com.jkrumm.sideclaw`. Either one alone is enough to make
launchd skip the `RunAtLoad` spawn — which is what "sideclaw doesn't come up
after a power cut" actually was, reproduced across three reboots on
2026-08-06 (one no-start, two starting ~3 minutes late, against ~18s for
every allowed agent on the machine).

Measured, not inferred: a throwaway agent running only `bun --version` under
a never-seen label registered `[enabled, allowed]` and BTM immediately
resolved it to `[enabled, disallowed]`; the same probe through a shell script
resolved to `[enabled, allowed]`. The identifier half is stickier than it
looks — deleting the plist, re-adding it, and re-adding it under a different
*filename* all came back disallowed, so only a new **Label** clears it. Hence
`scripts/sideclaw-start.sh` (dodges the bun denial) plus the `-server` label
(dodges the identifier denial). Reverting either brings the boot failure
back. It also makes the entry legible as `sideclaw-start.sh` rather than an
anonymous `bun` in System Settings → Login Items, which is how it plausibly
got denied in the first place.

Verify after any change to the plist:

```bash
log show --last 2m --info | grep -A3 sideclaw-server.plist | grep effectiveItemDisposition
# want: result=[enabled, allowed, ...]
```
