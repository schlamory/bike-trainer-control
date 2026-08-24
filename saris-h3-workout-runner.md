# Saris H3 Workout Runner

**Build orientation · August 2026**

A declarative way to launch a structured workout on your H3 — from the iPhone in front of you, with no laptop, no dongle, and no native app you have to write. Here is what's actually possible, what the protocol looks like, and where the landmines are.

- **Target:** iPhone → Bluefy → BLE FTMS → Saris H3
- **Fallback:** Mac → ANT+ FE-C

---

## How to read this

| Marker | Meaning |
| --- | --- |
| **[Verified]** | Confirmed against a primary source or two independent implementations. |
| **[Inferred]** | Strongly implied but not documented. Likely right. |
| **[Test it]** | Unknown. Nobody has written this down. Point Claude Code at it. |

---

## The shape of it

### Your setup is unusually well-suited to this

Three facts make the phone-only version work, and they're worth stating up front because each one could easily have gone the other way.

**The H3 speaks standard BLE FTMS natively** **[Verified]**. Not a firmware retrofit, not a proprietary CycleOps protocol with FTMS bolted on — it shipped that way in August 2019. This matters more than it sounds: the H1 (2016) was *proprietary BLE only*, and the H2 (2019) carried both. The H3 is the generation where Saris let the standard carry it. So a plain FTMS client controls it, with no vendor reverse-engineering.

**Bluefy exists and is maintained** **[Verified]**. v3.9.3, updated January 2026, free, 4.77★ across 1,283 ratings. It is a WKWebView browser that injects a `navigator.bluetooth` shim over CoreBluetooth. Your web app needs zero iOS-specific code — you write it as if for Chrome. And launching a URL in it from a Shortcut or a home-screen bookmark is trivial.

**Web Bluetooth means no server at all.** The BLE work happens entirely in the phone's browser. Your app can be a static page on GitHub Pages or Netlify. There is no daemon, no LAN, no mDNS, no certificate management — which also solves the HTTPS-secure-context requirement for free, since a hosted page is already HTTPS.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ Static page  │ → │    Bluefy    │ → │ CoreBluetooth│ → │   Saris H3   │
│ GitHub Pages │   │ WKWebView    │   │ iPhone radio │   │ FTMS 0x1826  │
│ HTTPS, no BE │   │ nav.bluetooth│   │ GATT central │   │ ERG via 0x05 │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

> ### ⚠ The one thing that could sink this
>
> FTMS delivers control-point responses over BLE **indications**, not notifications. Nobody has publicly documented whether Bluefy's shim handles the indicate path — its CCCD value is `0x0002` rather than `0x0001`. If Bluefy silently subscribes notify-only, you will get live power and cadence streaming beautifully and *never see a single control-point response*, which will look like the trainer ignoring you. **[Test it]**
>
> The good news: CoreBluetooth's `setNotifyValue(true:)` handles both cases transparently, so a naive shim most likely works by accident. This is a fifteen-minute check, and it is the first thing to run.

---

## Hardware reality

### What your H3 will and won't do

| Property | Value | Consequence for you |
| --- | --- | --- |
| BLE FTMS control | Yes, native since launch **[Verified]** | Standard client works. No vendor protocol needed. |
| Concurrent BLE connections | Exactly one | Your app must be the sole central. Quit Zwift, the Saris app, anything bridging. |
| ANT+ FE-C | Broadcasts simultaneously with BLE | Unlimited ANT+ listeners. Let a head unit record while your phone controls over BLE. |
| ERG response time | Under 3 seconds | Genuinely good — DC Rainmaker called it the cleanest ERG hold in the business. |
| Advertised BLE name | `Hammer <serial>`, probably **[Inferred]** | Filter on service UUID `0x1826`, never on name. |
| Firmware | 31.064 (Sep 2021) / 31.065 beta | Irrelevant here — FTMS predates all of it. Don't chase an update. |

### The ERG-stick bug is real and you should design around it

TrainerDay logged it across the H1, H2 and H3: in ERG mode the trainer occasionally **ignores a target change and stays at the previous wattage**. Users report it's more likely on large jumps between intervals — exactly the 100W → 300W transition your workout runner will be making. TrainerDay fixed it app-side in January 2022, which tells you the fix belongs in your control loop, not in the trainer.

So: don't fire-and-forget. Write your target, then confirm it landed two ways — the control-point indication carrying a success code, and a `TargetPowerChanged` event on the Fitness Machine Status characteristic. If neither arrives within a second or so, resend. Auuki, which ships this for real, retries writes four times at 500 ms intervals; that's a reasonable number to start from.

> ### Also worth knowing
>
> Saris went through bankruptcy and was bought at auction by C+A Global in October 2022. The Saris Utility app still exists (iOS v2.0.43, last touched *November 2021*) but the company is a shell of itself and there is no community firmware path. Treat the vendor as gone. Nothing in this build depends on them, which is rather the point.
>
> Separately: a documented Zwift failure mode was *intermittent missed ERG changes caused by a Bluetooth bridge* sitting between H3 and Apple TV. Anything interposed on that single BLE link causes trouble. Connect directly.

---

## Protocol crib sheet

### FTMS in one page

This is all you need. FTMS is dramatically simpler than ANT+ FE-C — no channel setup, no network key, no adopter agreement, no interleaved page schedule.

#### Characteristics

| UUID | Name | Props | Why you care |
| --- | --- | --- | --- |
| `0x1826` | Fitness Machine Service | — | Scan filter. The only one you should match on. |
| `0x2AD2` | Indoor Bike Data | notify | Live power, cadence, speed. Your telemetry stream. |
| `0x2AD9` | Fitness Machine Control Point | write, **indicate** | Where you send ERG targets and read back accept/reject. |
| `0x2ACC` | Fitness Machine Feature | read | The trainer declaring which opcodes it supports. |
| `0x2ADA` | Fitness Machine Status | notify | Confirms a target actually changed. Your ERG-stick detector. |

#### The handshake, in order — this order is not optional

Most FTMS bug reports in the wild trace back to skipping a step here. The trainer silently ignores commands until it has granted control.

```js
// 1. subscribe to indications on 0x2AD9   ← before anything else
// 2. write [0x00]                          Request Control
// 3. write [0x01]                          Reset
// 4. write [0x07]                          Start / Resume
// 5. write [0x05, lo, hi]                  Set Target Power, uint16 LE watts

// every response comes back on 0x2AD9 as:
//   [0x80, <requested opcode>, <result>]
//   result 0x01 success · 0x02 opcode not supported
//          0x03 invalid parameter · 0x05 control not permitted
```

Note that target power is **plain watts as a little-endian uint16** — no scaling factor. This is a pleasant contrast with ANT+ FE-C, where the same value is carried in 0.25 W units and grade is unsigned-with-a-−200%-offset.

#### Ask the trainer what it supports

Read `0x2ACC` — eight bytes, two little-endian 32-bit bitfields. The second word is the Target Setting Features mask, and it answers the opcode question definitively rather than by inference:

| Bit | Capability | Opcode | H3 |
| --- | --- | --- | --- |
| 1 | Target Resistance | `0x04` | **[Test it]** |
| 3 | Target Power (ERG) | `0x05` | **[Verified — near-certain]** |
| 12 | Spin Down Control | `0x13` | **[Test it]** |
| 13 | Indoor Bike Simulation | `0x11` | **[Inferred — very likely]** |

For a workout runner you only strictly need `0x05`. Simulation mode (`0x11`) is what you'd add later if you ever want to ride a grade profile rather than a power profile.

---

## The declarative part

### Choosing a workout format

This is the piece you actually care about — the thing GoldenCheetah makes miserable. There are three real options and they're not equally good.

| Format | Model | Verdict |
| --- | --- | --- |
| **.zwo** (Zwift XML) | Typed interval elements: `Warmup`, `SteadyState`, `IntervalsT`, `Ramp`, `FreeRide`. Power is a *fraction of FTP* (0.88 = 88%), duration in seconds. | **Support it for import.** Enormous free library exists. Shallow XML — a competent parser is ~150 lines. Ugly, inconsistent format, but the network effect is real. |
| **.erg / .mrc** (CompuTrainer lineage) | Plain text. Header block, then `<minutes> <value>` breakpoints with linear interpolation between them. `.erg` = watts, `.mrc` = %FTP. | **Use as your internal representation.** The breakpoint list *is* the ERG control loop — interpolate at 1 Hz and you have your setpoint. Two `split()` calls to parse. |
| **Your own YAML** | Whatever you want. | **Write in this.** You're building this because you want declarative authoring. Compile it down to the breakpoint list; emit `.zwo` if you ever want interop. |

The intervals.icu text syntax is worth stealing rather than inventing from scratch — `- 3m 105% 95rpm`, sections with `5x` repeats, `ramp 50%-75%`. It's the most readable grammar anyone has landed on for this, and it already has an ecosystem.

<details>
<summary><strong>.zwo gotchas that will bite a first-pass parser</strong></summary>

- `PowerLow` frequently *exceeds* `PowerHigh`. They mean start and end of a ramp, not min and max. A cooldown descends. Do not sort them.
- `IntervalsT`'s `Repeat` counts on/off *pairs*. `Repeat="5" OnDuration="60" OffDuration="60"` is ten minutes.
- Text cues appear as both `<textevent>` and `<TextEvent>`, with `timeoffset` relative to the enclosing interval, not the workout. Shipped Zwift files contain a misspelled `mssage` attribute.
- Four naming conventions coexist in one format. Float noise like `0.89999998` and `180.00002` is normal.
- There is no official schema. [h4l/zwift-workout-file-reference](https://github.com/h4l/zwift-workout-file-reference) is the de-facto spec, reverse-engineered from every workout Zwift ships.

</details>

---

## The build path

### 01 · Smoke-test Bluefy against the H3 — twenty minutes, before anything else

A single static HTML page. Filter on `0x1826`, connect, subscribe to indications on `0x2AD9`, write `[0x00]`, and log whatever comes back. If you see `80 00 01`, the entire architecture is validated and everything after this is ordinary work. If nothing arrives, Bluefy's shim can't do indications and you fall to step 1b.

While you're there: dump every characteristic and its properties, and read `0x2ACC`. That one page answers most of the **[Test it]** markers above.

### 01b · Only if that failed: BLE Link, then WebBLE

[BLE Link](https://apps.apple.com/us/app/ble-link-web-ble-browser/id6468414672) (free, updated four days before this was written) is the most actively maintained of the Web BLE browsers and explicitly claims background connection maintenance. [WebBLE](https://apps.apple.com/us/app/webble/id1193531073) ($1.99, stale since 2023) is Espruino's recommendation, which means its notification handling is battle-tested — but 2.59★ and three years untouched.

### 02 · Get one wattage onto the trainer

Full handshake, then `[0x05, lo, hi]` for 150 W. Pedal. Confirm resistance changes and that `0x2AD2` reports something near 150. This is the whole product in miniature; everything else is scheduling and UI.

### 03 · Build the control loop, not just the setter

A 1 Hz tick that: computes the current setpoint from the workout's breakpoint list, writes it if changed, re-writes it every few seconds regardless as a keepalive, watches `0x2ADA` for `TargetPowerChanged` (`0x08`) confirmation, and retries on silence. This is where the H3's ERG-stick bug gets handled, and it's the difference between a demo and something you'd actually train on.

### 04 · Add the workout format

YAML or intervals.icu-style text in, breakpoint list out. Resolve %FTP against a single configured FTP value. Add `.zwo` import afterward so you can pull in existing workouts.

### 05 · Survive an hour on a phone

Screen wake lock, reconnect-on-drop, and — the genuinely unknown part — whether the GATT connection holds through screen-off or an incoming call. Nobody has published this test for any Web BLE browser. Call both wake-lock APIs defensively, since Bluefy ships a proprietary one:

```js
try { await navigator.wakeLock?.request('screen'); } catch {}
try { navigator.bluetooth?.setScreenDimEnabled?.(true); } catch {}

// standard wake locks release whenever the page hides —
// re-acquire on visibilitychange or it dies the first time
// you glance at a notification
```

### 06 · Record the ride

Buffer the `0x2AD2` stream and write a `.fit` file at the end for upload. Optional, and the fiddliest part of the whole project — FIT is binary with dynamic fields. Defer it until the training part works.

---

## Prior art

### What to read instead of writing from scratch

Two of these are directly load-bearing; the rest are lookups.

- **[Auuki](https://github.com/dvmarinoff/Auuki)** — a live, maintained AGPL PWA doing exactly your job: Web Bluetooth FTMS, ERG and simulation modes, `.zwo` import, FIT recording. Read `src/ble/ftms/ftms.js` (about 110 lines, includes the write-retry logic you won't think of yourself) and `src/workouts/zwo.js` (a complete `.zwo` parser). Its author explicitly declines to support iOS — you'd be the one adding the Bluefy path.
- **[bullwatt](https://github.com/canssens/bullwatt)** — a much smaller "launch a watt-controlled session" FTMS app. The minimal reference for the control-point sequence.
- **[h4l/zwift-workout-file-reference](https://github.com/h4l/zwift-workout-file-reference)** — the `.zwo` spec that doesn't officially exist.
- **[pycycling](https://github.com/zacharyedwardbull/pycycling)** — Python/bleak, but `fitness_machine_service.py` is the clearest 400-line statement of the FTMS handshake in any language. Useful for the fallback path too.
- **[qdomyos-zwift](https://github.com/cagnulein/qdomyos-zwift)** — enormous and Qt-flavoured, but it's the industry's per-device quirk table. Go here only when a specific behaviour confuses you.

---

## If BLE disappoints

### The fallback you already have working

Your Mac plus the ANT+ dongle is the safety net, and it's a good one — ANT+ is a broadcast topology, so it sidesteps the H3's one-BLE-connection limit entirely and leaves the Bluetooth link free for a watch or a head unit.

The shape: a Python daemon on the Mac holds the FE-C channel and runs the control loop; it serves a small mobile-friendly page; the phone is a thin client over the LAN at `http://yourmac.local:8000`. No Web Bluetooth needed, so the whole iPhone constraint evaporates. [openant](https://github.com/Tigge/openant) (v1.3.4, Aug 2025) has a full FE-C profile with a working `set_target_power()`, and [NiceGUI](https://github.com/zauberzeug/nicegui) gets you a live-updating mobile UI without hand-rolling WebSockets. Wrap the daemon in `caffeinate -dims` so the Mac stays awake.

<details>
<summary><strong>ANT+ FE-C essentials, if you go this way</strong></summary>

Device type `17`, RF frequency `57`, channel period `8192` (4 Hz). Your app is the *slave*; the trainer is the master. You receive broadcasts and send control pages as acknowledged messages on the same channel.

```c
// Page 49 (0x31) — Target Power, i.e. ERG
raw = watts * 4                        // 0.25 W units
[0x31, FF, FF, FF, FF, FF, raw&0xFF, raw>>8]

// Page 51 (0x33) — Track Resistance, i.e. slope
raw = (grade_pct + 200) * 100          // unsigned, −200% offset
[0x33, FF, FF, FF, FF, raw&0xFF, raw>>8, crr/0.00005]
// 0% grade is 20000, NOT 0. Emitting 0 means −200%.
```

Mode is implicit and sticky — the last control page sent wins, and another app on the channel can yank the trainer out of ERG at any time. Request page `71` after each command to confirm it was accepted; the ANT-layer ACK only proves radio delivery. And on Apple Silicon, expect to point pyusb at `/opt/homebrew/lib/libusb-1.0.dylib` explicitly — it does not search there.

</details>

---

## Hand-off

### What to point Claude Code at

In rough order of how much they'd change the plan:

1. **Does Bluefy deliver GATT indications?** Everything hinges on this and nobody has written it down.
2. **What does the H3's `0x2ACC` actually say?** One read replaces four inferences about opcode support.
3. **What name and services does it advertise?** Confirms the `Hammer <serial>` guess and reveals whether a legacy CycleOps proprietary service is still hanging around alongside FTMS.
4. **Does the connection survive screen-off for an hour?** Untested by anyone, publicly, for any Web BLE browser on iOS.
5. **Can you reproduce the ERG-stick bug** with scripted 100W↔300W jumps? Tells you how aggressive the retry logic needs to be.

The first two are a single afternoon and they collapse most of the uncertainty in this document. A `bleak` script on the Mac answers 2, 3 and 5 without involving the phone at all — worth doing first, since it separates "what does the trainer do" from "what does Bluefy do."

---

*Compiled August 2026. Protocol byte layouts cross-checked against openant, GoldenCheetah `src/ANT/`, FortiusANT and Loghorn ant-plus — four independent implementations that agree. Hardware claims sourced from DC Rainmaker's H3 review, Saris documentation, and issue threads in qdomyos-zwift and TrainerDay. iOS browser status from WebKit standards-positions [#570](https://github.com/WebKit/standards-positions/issues/570) and current App Store listings.*
