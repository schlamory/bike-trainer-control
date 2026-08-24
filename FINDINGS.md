# H3 recon results

Measured against the real trainer from the Mac over BLE, 24 August 2026.
Everything below is **[Verified]** by observation unless stated otherwise —
reproduce with `experiments/`.

Device: `Hammer 26216` · Saris · model 321 · serial 21052320 ·
**firmware 31.065** · hardware 4 · software `37.013|009b|0001`

Note the firmware: you are already on the 31.065 beta, not the 31.064 release
the doc assumed.

---

## The doc's handshake is wrong, and it fails silently-ish

The doc gives this order and calls it "not optional":

```
0x00 Request Control → 0x01 Reset → 0x07 Start/Resume → 0x05 Set Target Power
```

**Reset revokes the control grant.** Run that exact sequence and `Start/Resume`
comes back `80 07 05` — *Control Not Permitted* — and every command after it is
refused too. This is spec-correct behaviour (Reset returns the machine to
defaults, which includes dropping control), but it is the opposite of what the
doc claims, and it's the failure mode the doc warns about while prescribing its
cause.

Three variants, tested back to back in one connection (`experiments/handshake_order.py`):

| Sequence | Result |
| --- | --- |
| Request Control → Start | **Success** |
| Reset → Start | `Control Not Permitted` |
| Reset → Request Control → Start | **Success** |
| Request Control twice in a row | **Success** — idempotent |

So: either drop Reset entirely, or re-request control after it. Encoded in
`ftms.handshake_sequence()`. Because Request Control is idempotent, the cheap
robust move is to re-issue it before any retry in the control loop — it costs
one write and it immunises you against a lost grant.

---

## Capabilities, read rather than inferred

`0x2ACC` reads `86 40 00 00 0c e0 00 00`.

Target Setting word = `0x0000e00c`, so **all four opcodes the doc was unsure
about are supported**:

| Opcode | Capability | Doc said | Actually |
| --- | --- | --- | --- |
| `0x04` | Set Target Resistance | [Test it] | **YES** |
| `0x05` | Set Target Power (ERG) | [Verified — near-certain] | **YES** |
| `0x11` | Indoor Bike Simulation | [Inferred — very likely] | **YES** |
| `0x13` | Spin Down Control | [Test it] | **YES** |

Also present and unmentioned by the doc: Wheel Circumference Configuration (`0x12`).

Machine word = `0x00004086`: Cadence, Total Distance, Resistance Level, Power
Measurement. No heart rate, no expended energy, no elapsed/remaining time —
so don't expect the trainer to track workout time for you.

### The doc's feature-bit table has wrong bit numbers

Two of the four are off. Correct per the FTMS spec (and consistent with what
the H3 returns):

| Capability | Doc | Correct bit |
| --- | --- | --- |
| Target Resistance | 1 | **2** |
| Target Power | 3 | 3 ✓ |
| Spin Down Control | 12 | **15** |
| Indoor Bike Simulation | 13 | 13 ✓ |

If you'd coded the doc's table you'd have read the resistance and spin-down
bits off neighbouring capabilities. `ftms.TARGET_FEATURE_BITS` has the full
correct map.

### Power range

`0x2AD8` → **0 to 3000 W, 1 W increments**. Out-of-range is properly rejected:
4000 W returns `80 05 03` *Invalid Parameter*. 0 W is accepted as a valid target.

---

## ERG works, and it tracks tightly

`experiments/erg_targets.py` — every command accepted, and critically:

**`0x2ADA` fires a confirmation for every single target change, within ~10 ms of
the control-point response, and it echoes the value back.** Setting 300 W gives
`08 2c 01` = *Target Power Changed = 300*. That's a much stronger signal than the
doc hoped for — you can verify the trainer took the *exact* number you sent,
not merely that something changed.

Resistance mode (`0x04 05`) and simulation mode (`0x11`, 3% grade) both also
returned Success with matching status events, so the fallback control modes are
real, not just advertised.

### Under load: a 10-minute ride, 24 Aug 2026

`workout.py --steps "75w/60s, 230w/20s" --duration 10m` — 15 intervals,
587 per-second samples, every one under load. Raw data in `data/ride-20260824-132512.csv`.

**15/15 targets confirmed. Zero retries.** Fourteen transitions, seven of them
155 W jumps.

Steady state, excluding the first 5 s of each interval to drop the ramp:

| target | mean | median | error |
| --- | --- | --- | --- |
| 75 W | 74.6 W | 74.0 | **−0.4 W** |
| 230 W | 226.8 W | 224.5 | **−3.2 W** |

Under half a watt off at 75 W, about 1.4% low at 230 W. Total work 66.4 kJ
actual against 66.7 kJ nominal — 99.6% of the prescribed work delivered.
Cadence 81 rpm median (58–96).

### Ramp up is fast; ramp down is not

**Up to 230 W: 2.0 s median to 95% of target**, and strikingly consistent — six
of seven intervals at exactly 2.0 s, one at 1.0 s. Beats the doc's "under 3
seconds" claim.

**Down to 75 W takes 3–4 s** and is visibly asymmetric. A typical drop reads
`213 → 153 → 135 → 83 W`. This is flywheel inertia rather than a control
failure: the trainer can add resistance instantly but can only shed momentum as
fast as you stop feeding it.

Two consequences for the workout runner:

- Short recovery valleys are partly fiction. A 10 s rest step spends a third of
  itself still bleeding down from the previous effort. Design intervals with
  that in mind, or expect the prescribed and delivered work to diverge on
  anything under ~20 s.
- **Any steady-state statistic must exclude the interval head.** The raw 75 W
  mean reads 78.4 W with a 222 W max purely from ramp-down samples bleeding into
  the recovery block; the 5 s exclusion above is what makes the −0.4 W figure
  meaningful.

### The ERG-stick bug remains unreproduced

26 target changes so far, 19 of them large jumps, zero sticks. That is **not**
evidence the bug is absent — it is intermittent by nature and TrainerDay saw it
across all three Hammer generations.

What follows from this is worth being blunt about: the confirm-and-retry path in
`bike_trainer/control.py` has **never actually executed**. It is written but
untested in anger. Do not treat it as proven. The honest way to gain confidence
is fault injection — deliberately suppress the confirmation wait and verify the
retry engages, rather than waiting for the bug to show up on its own.

---

## Advertising and topology

Advertised as **`Hammer 26216`** — the doc's `Hammer <serial>` guess was
right in shape, but note the advertised number (26216) is **not** the serial
number in Device Information (21052320). Filter on service UUID, as the doc
says.

Three services advertised, and the legacy proprietary one **is still there**:

| Service | Contents |
| --- | --- |
| `0x1826` FTMS | The 7 standard characteristics + one vendor char `0d18a170-…` (write/indicate) |
| `0x1818` Cycling Power | Power measurement, feature, sensor location, CP control point, + vendor char `a026e005-…` |
| `c0f4013a-…` CycleOps proprietary | One characteristic `ca31a533-…` (write/indicate) |

You don't need any of the proprietary surface — FTMS covers everything. But its
presence means a legacy Saris/CycleOps client could still be grabbing the single
BLE slot, which is worth knowing when the trainer mysteriously won't connect.

## Data polling: there isn't any — it's push only

Neither power characteristic is readable. `Indoor Bike Data` has only the
`notify` property and returns a protocol error on a read attempt; so does
`Cycling Power Measurement`. You subscribe and the trainer pushes. There is
nothing to poll and no way to ask for a sample on demand.

Measured with `telemetry.py -d 30`:

| Stream | Rate | Interval | Jitter |
| --- | --- | --- | --- |
| Indoor Bike Data (`0x2AD2`, FTMS) | 1.00 Hz | median 990 ms | stdev 55 ms, range 810–1170 ms |
| Cycling Power Measurement (`0x2A63`, CPS) | 1.00 Hz | median 990 ms | stdev 54 ms, range 810–1171 ms |

**1 Hz is a hard ceiling on actual-power resolution.** That is the trainer's
cadence, not a client limit — which conveniently matches the doc's suggested
1 Hz control-loop tick, so there is no benefit to ticking faster.

### Two power streams, and the CPS one is richer

Indoor Bike Data flags come back as `0x0074` — a fixed 13-byte frame:

```
74 00 | speed u16 | cadence u16 | distance u24 | resistance s16 | power s16
       0.01 km/h    0.5 rpm       metres         unitless         watts
```

Bit 0 clear means instantaneous speed IS present (that bit is *More Data* and
is inverted relative to every other flag — the classic FTMS parser bug).

Cycling Power Measurement flags `0x1834` — an 18-byte frame carrying
accumulated torque, **wheel and crank revolution counters**, and accumulated
energy. Feature word `0x0001038e`; sensor location reports "Other".

The crank counters are the reason to care: they let you derive cadence from
event deltas rather than accept FTMS's 0.5 rpm rounding, and they give you
accumulated energy for free. `bike_trainer.cps.cadence_from_crank()` does the
rollover-safe arithmetic.

Readable-but-static characteristics worth knowing: `Training Status` (`0x2AD3`,
read + notify) returned `00 00` throughout. Everything else readable is Device
Information or a capability bitfield.

---

## Still open

Nothing here needed the phone, which is the point — "what does the trainer do"
is now separated from "what does Bluefy do". Remaining, in the doc's priority order:

1. **Does Bluefy deliver GATT indications?** *Still the pivotal unknown.*
   Indications work fine from CoreBluetooth via bleak, which is mildly
   encouraging for the shim-most-likely-works-by-accident theory, but it is not
   evidence about Bluefy. Needs the static test page on the phone.
2. **ERG stick under load** — *partially answered.* 26 target changes under
   load produced zero sticks, so it is at minimum not frequent on firmware
   31.065. The open half is whether the retry logic actually works when it
   fires, which needs fault injection rather than more riding.
3. **Hour-long screen-off survival** — phone-side, untestable from here.

