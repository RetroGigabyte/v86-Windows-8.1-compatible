# Future work

Notes on what it would take to push this fork further, based on how the
Windows 8.1 fix actually went. Kept here mainly so the next person (or
future me) doesn't have to re-derive the reasoning from scratch.

## Windows 10 (32-bit)

> **TL;DR for whoever picks this up next** (the section below is a long,
> chronological investigation log — start here, not there):
>
> - Windows 10 stalls at the boot logo. Root cause: Windows page-faults
>   on a fixed address (`0xF0010000+`) whose page-directory entry is
>   genuinely never populated, then parks the CPU in an infinite
>   `jmp $` with interrupts masked. Confirmed **not** the disk, the OS,
>   the firmware code, or a corrupted install — real QEMU (matched
>   chipset, and separately with v86's *exact* vendored `seabios.bin`)
>   boots the identical disk to desktop. This is a genuine, narrow
>   v86-specific gap.
> - **Real bugs found and fixed along the way** (independently valuable,
>   none of them turned out to be the actual cause): the ACPI PM timer
>   could stall under fast polling (fixed, ported the same fix already
>   used for TSC); the PCI Command register silently dropped 32-bit
>   writes (fixed, narrow consistency fix); v86 silently clamps RAM to
>   ~2047.875MB regardless of configured size — confirmed real, **not**
>   fixed (see "Extended the audit further" below for why it's not a
>   quick patch), and confirmed **not** the Windows 10 cause either
>   (retested with honestly-configured memory, identical stall).
> - **Real breakthrough, not yet finished**: kernel debugging (WinDbg
>   protocol) is now actually reachable. A BCD-patched copy of the disk
>   (`tiny10-windbg.img`, edited via Docker + `ntfs-3g` + `hivexsh` —
>   full recipe below) produces real, confirmed `KD_PACKET` traffic over
>   v86's emulated COM1, bridged to a plain TCP port
>   (`debug-artifacts/v86_serial_bridge.js`) that any real KD client
>   could attach to. A real packet is captured
>   (`debug-artifacts/kd_capture.bin`). Two well-reasoned ACK attempts
>   (including ruling out injection timing as a confound — fixed the
>   bridge to batch-inject instead of one byte per round-trip, retried,
>   same clean negative result) didn't complete the handshake — needs
>   either real WinDbg or a protocol implementation checked against
>   actual documentation, not more guessing. This is the most promising
>   open thread.
> - Dead ends, confirmed closed (not just "didn't get to it"): SSDT/`_CRS`
>   byte-diff against real QEMU (QEMU has deferred to its own `fw_cfg`
>   ACPI generation over loaded firmware for 5+ years, confirmed back to
>   QEMU 5.2 via Docker); swapping SeaBIOS for Bochs BIOS/ROMBIOS (tried
>   twice, including with halfix's actual ACPI-enabled binary); PCI BAR
>   misconfiguration; IOAPIC/APIC interrupt-delivery and EOI logic (read
>   closely, matches spec); PIT/RTC timing code (structurally safe,
>   no analog to the PM-timer bug).

Windows 10 doesn't need a new architecture feature the way 11 does — v86's
32-bit CPU, PAE, and (with this fork) NX bit support already cover the hard
requirements. The blockers are narrower but there are likely several of them:

- **More missing SSSE3/SSE4.1 instructions.** CRC32 (`0F 38 F0`/`F1`) was the
  one Windows 8.1 happened to hit during device enumeration. Windows 10's
  kernel and driver stack lean on this instruction family more heavily, so
  expect to hit `PSHUFB`, `PALIGNR`, `PMULLD`, `PBLENDVB`, or similar — and
  unlike CRC32 (pure GPR/integer math), these operate on XMM registers and
  need real vector semantics, which is more implementation work per
  instruction.
- **No decode infrastructure for the `0F 38`/`0F 3A` opcode maps.**
  `gen/x86_table.js` explicitly skips them (`{ opcode: 0x0F38, skip: 1 }`).
  The CRC32 fix worked around this by hand-decoding inside `instr_0F38`
  itself rather than extending the generator. That approach doesn't scale
  much further — implementing more than a couple more opcodes this way gets
  unwieldy, and at some point it's worth extending the actual table
  generator (`gen/generate_interpreter.js`, `gen/generate_jit.js`,
  `gen/generate_analyzer.js`) to do this properly.
- **A heavier, slower boot path.** WinPE, driver signature checks, more
  ACPI/power-management surface than 8.1 — more places for rare corner
  cases to surface, and slower overall since TCG-style wasm JIT is already
  the bottleneck.
- **32-bit media is no longer officially distributed.** Microsoft dropped
  32-bit installer ISOs around the 20H2/21H1 era, so testing means an older
  or repacked ISO, same as the "Lite" image used for the 8.1 work here.

### Why bother — Windows 10 is already EOL (Oct 2025)

Worth doing anyway, because the point isn't Windows 10 itself, it's what can
still run inside it — Steam, Minecraft, Chrome, etc. But that's eroding too,
worth knowing going in:

- **Steam**: the client itself is still a 32-bit binary, so it should
  install and run — but Valve dropped 32-bit *OS* support on Linux/macOS
  years ago, and an increasing number of individual games require a 64-bit
  OS even where the client doesn't.
- **Chrome**: still ships 32-bit Windows builds, so this one's probably fine
  for a while yet.
- **Minecraft**: Java Edition can run under a 32-bit JVM, but modern
  versions lean on LWJGL/rendering libraries that increasingly assume
  64-bit. Bedrock Edition is UWP and x64-only regardless.

None of this changes the emulator work itself — 32-bit Windows 10 boots or
it doesn't, independent of what runs inside it — but "Steam/Minecraft/Chrome
work great on 32-bit Windows 10" is trending toward "worked, for a while,"
not a stable target. Worth remembering when deciding what success looks
like once it boots.

### Suggested approach

Same loop that found the CRC32 bug:

1. Build the debug wasm (`config::LOG_PAGE_FAULTS = true`, and the
   `unimplemented_sse()` logging added during the 8.1 investigation — see
   `src/rust/cpu/instructions_0f.rs`) and drive it through `debug.html`.
2. In debug builds `dbg_assert!` panics and traps the whole wasm module
   (fatal); the temporary fix each time is to remove the specific
   `dbg_assert!` so the debug build behaves like release (log + `#UD` to the
   guest) and can keep running far enough to reveal the *next* gap.
3. Capture the exact opcode/prefix bytes at the fault site (`*previous_ip`
   plus a handful of `safe_read8` calls — see the `unimplemented_sse`
   instrumentation), then implement just that instruction.
4. Repeat until installation/boot completes, the same way CRC32 was found
   and fixed for 8.1.

Expect this to take several iterations, not one.

### Status: the `sse-work` branch, and what actually happened

The `sse-work` branch has a first batch of SSSE3/SSE4.1 instructions
(`PSHUFB`, `PABSB/W/D`, `PCMPEQQ`, the `PMINS/PMAXS`/`PMINU/PMAXU` family,
`PMULLD`, `PALIGNR` — see `instr_0F38_ssse3_sse41`/`instr_0F3A_palignr` in
`src/rust/cpu/instructions_0f.rs`) implemented and **verified correct
against QEMU's actual reference implementation**
(`target/i386/ops_sse.h`/`target/i386/tcg/emit.c.inc`, fetched live from
`qemu/qemu` and diffed instruction-by-instruction). None of these were the
bug — worth knowing so nobody re-audits them from scratch.

The real story testing against both Tiny10 (NTLite-trimmed) and an official
32-bit Windows 10 ISO turned out to be a livelock, not a missing
instruction:

- Windows would boot into the animated-logo screen and sit there
  indefinitely — CPU genuinely busy (healthy, changing instruction count/
  mIPS the whole time), zero crashes, zero exceptions. Looked "slow" at
  first; took a while to realize it was actually stuck.
- Root cause, found via systematic exception/fault tracing (ruling out SSE
  instructions, task-gate/double-fault handling, and our NX/paging code
  first — all confirmed correct): **port `0x70` (CMOS index / NMI-mask)
  had a write handler but no read handler**, so reads silently fell
  through to a stub that always returns a constant `0xFF`. Windows was
  polling this port in a tight loop, apparently verifying the value it had
  just written — since it could never read back anything but `0xFF`, it
  never made progress. Fixed by adding a real read handler that reflects
  the last-written index/NMI state (`src/rtc.js`).
- A systematic audit of every other `register_write`/`register_read` pair
  across the device files (RTC, PIT, PS2, PCI, VGA, UART, IDE, DMA, ACPI)
  turned up no other instance of this pattern — the other asymmetries that
  exist (PIT `0x43`, VGA index/data pairs, DMA controller ports, the ACPI
  PM timer) all match real hardware's actual write-only/read-only design,
  not bugs.
- After the fix, a full-duration test still sat on the same logo screen
  for 20+ minutes with no repeating faults. Pre-installed Tiny10 via QEMU
  (same approach that confirmed the 8.1 breakthrough — see the top-level
  Readme) to separate "Setup itself is slow" from "an already-installed
  Windows 10 doesn't boot cleanly." **The already-installed disk hit the
  exact same wall**, with no ESD decompression to blame — confirming this
  is a second, real, still-open bug, not just slowness.

### A regression along the way, worth knowing about

The diagnostic tracing used to investigate the second bug (below) itself
caused a real, serious bug at one point: it called `safe_read8()` — a real
memory access with page-walk side effects — from inside
`call_interrupt_vector` on every occurrence of a wide set of exception
vectors, including `#PF` (14), which fires constantly during completely
normal Windows execution (demand paging). This risked triggering a *nested*
fault while already handling one, and was confirmed via regression testing
to crash Windows 8.1 (the previously verified-working baseline) with
`Maximum call stack size exceeded` — recursive
`trigger_pagefault → call_interrupt_vector → do_page_walk →
trigger_pagefault`, instead of reaching the desktop.

Fixed by narrowing that diagnostic back to vector 8 (double fault) only —
rare enough to log safely — and dropping the byte-disassembly that
required the unsafe reads in the first place. **The finding below was
re-verified after this fix**, with the corrupting diagnostic removed: the
second bug still reproduces identically, confirming it's a real, separate
issue and not an artifact of the regression. Worth remembering for next
time: any diagnostic that reads guest memory from inside exception/
interrupt delivery needs to be scoped to exception vectors that are
genuinely rare, not ones that fire during normal execution.

### A second, probably-flaky "regression" - and a methodology lesson

Separate from the HPET/WAET regression above: while extending the
SSSE3/SSE4.1 batch further (PMOVSX/PMOVZX widening family, PMULDQ,
PACKUSDW, PCMPGTQ), a single test run BSOD'd Windows 8.1 with
`BAD_SYSTEM_CONFIG_INFO`. Bisected by disabling/re-enabling each new
instruction individually and rerunning the full regression suite once
per configuration - landed on `PCMPGTQ` as the apparent cause, shipped
the other three, left `PCMPGTQ` unimplemented.

Went back afterward to actually root-cause it (rather than leave an
opaque "probably this one" note) by re-enabling `PCMPGTQ` with
diagnostic logging on every invocation. Result across three separate
reruns: **zero crashes, zero invocations logged at all** - the
instruction was never even executed, let alone with data that could
explain a crash. Widened the check further: checked out the untouched
pre-batch file standalone, rebuilt, and ran the baseline twice more -
also clean both times.

Reading across all of it: one crash in roughly a dozen total runs
(across the original full-batch tests, the per-instruction bisection,
and these follow-up reruns), never reproduced despite deliberately
trying to reproduce it under the exact configuration that "caused" it.
That's a strong signal the original crash was a **rare, one-off flake**
- possibly a genuine pre-existing, timing-sensitive v86 bug unrelated
to any of this SSE work, possibly a Playwright/browser-environment
artifact - rather than a deterministic regression caused by `PCMPGTQ`'s
logic (which reads as correct on repeated review and matches the
already-working `PCMPEQQ` right next to it).

**The methodology lesson**: single-run bisection isn't reliable evidence
on its own when the underlying failure might be nondeterministic - a
one-shot bisection can point at an innocent change that merely happened
to be present when a rare, unrelated bug fired. `PCMPGTQ` stays
unimplemented regardless (a handful of clean reruns doesn't add up to
"confirmed safe" either, just "failed to reproduce"), but the *reason*
matters for how much confidence to put in tonight's other bisections
too - the three shipped instructions (widening family, PMULDQ,
PACKUSDW) each only saw one full-suite pass in isolation before being
combined and shipped. Worth another rerun or two of the shipped build
if this comes up again, just to build more confidence than a single
clean pass provides.

### The second bug: a page that's never mapped, and likely why

Traced via protected-mode fault-class exception logging (with disassembly
at the fault site) plus a full I/O-port trace: disk DMA works flawlessly
(1800+ successful transfers observed) right up until a page fault on a
fixed virtual address in the `0xF0010000+` range — generic kernel code
(`MOV CL, [EDX+EAX]`, nothing SSE/NX-related) reading a page whose page
directory entry is **genuinely, verifiably zero** in guest memory (checked
directly, not a v86 misread). A write-watchpoint on that exact page-table
page confirmed **nothing ever attempts to fix it** — no OS fault-handler
retry, no driver, nothing. All disk activity stops permanently at this
point. Address, code path (`0F 38`/`SSE` instructions ruled out by direct
disassembly), and timing are identical across Tiny10 (fresh install and
pre-installed) and the official Windows 10 32-bit ISO — this is
deterministic, not flaky.

**Confirmed via directly comparing the actual ACPI tables**, not just
theorizing: dumped v86's real guest-memory ACPI tables (via `read_memory`
on the exposed debug `V86` instance — scan `0xE0000`-`0xFFFFF` for the
`RSD PTR` signature, walk the RSDT chain) and QEMU's equivalent (via QMP
`pmemsave` on a bare `-machine q35` instance, no OS needed — SeaBIOS builds
these during POST regardless of whether a bootable OS is found), then
parsed both with the same script. Result:

| Table | v86 | QEMU q35 |
|---|---|---|
| FACP (FADT) | 116 bytes | 244 bytes |
| APIC (MADT) | 110 bytes | 128 bytes |
| SSDT | present | — |
| `HPET` | **missing** | present |
| `MCFG` | **missing** | present |
| `WAET` | **missing** | present |

Traced the *why* by fetching v86's actual vendored SeaBIOS source at its
exact pinned tag (`rel-1.16.2`, via `bios/fetch-and-build-seabios.sh`) —
important because current SeaBIOS `master` has deprecated its own internal
ACPI table builder entirely (`acpi_setup()` is now a 4-line stub: *"ACPI
tables for qemu 1.6 and older are not supported any more"*), while
`rel-1.16.2` (685 lines) still has the full legacy internal builder. That
explains each gap precisely, not just generally:

- **`MCFG`**: SeaBIOS only builds this
  `if (pci->device == PCI_DEVICE_ID_INTEL_ICH9_LPC)` — genuinely q35-only
  by design. Correctly absent on PIIX3-class hardware; **not a bug**.
- **`HPET`**: SeaBIOS calls `build_hpet()` **unconditionally**, but that
  function works by reading real HPET hardware registers
  (`readl(hpet_base + HPET_ID)` at a fixed MMIO address) to fill in the
  table. **v86 doesn't implement an HPET device at all**, so this read
  almost certainly returns garbage/unmapped-memory default, and SeaBIOS
  presumably detects "no device" and skips the table. Concrete, bounded
  fix: add a minimal HPET device model to v86 and this table should start
  being emitted for free by SeaBIOS's existing code.
- **`WAET`**: SeaBIOS `rel-1.16.2` has **no code to build this at all** —
  real QEMU generates it itself and injects it via a `fw_cfg` file
  (SeaBIOS has a loader loop, `romfile_findprefix("acpi/", ...)`, that
  picks up and relocates any `acpi/*` fw_cfg files QEMU provides). v86's
  `fw_cfg` implementation (`src/cpu.js`, search `FW_CFG_FILE_DIR`) doesn't
  expose any ACPI files, only option ROMs. `WAET` is a Windows-specific
  "trust this platform, skip slow legacy timer-calibration workarounds"
  hint table — its absence plausibly explains the ACPI-PM-timer-heavy
  polling loop (`0xB008` reads, alternating with IDE bus-master status)
  observed in the full I/O trace earlier. Concrete, bounded fix: construct
  the ~40-byte WAET table body and expose it via a `fw_cfg` file the same
  way QEMU does.

Both looked like **bounded, addressable engineering tasks** — not a new
chipset. (My earlier framing in this doc — "needs a whole new ICH9/q35
chipset" — was too broad; scrap that.) Here's what actually happened when
both were implemented:

- **`WAET`**: implemented as described (`build_waet_table()` in
  `src/acpi.js`, exposed via a `fw_cfg` file named `acpi/waet` pushed into
  `cpu.option_roms` in `src/cpu.js`). Confirmed via the same ACPI-dump
  comparison that the table now appears (40 bytes, correct checksum,
  matches QEMU's real `WAET`). **Regression-tested clean against Windows
  8.1** — reaches the same "Getting devices ready" progress as the
  pre-change baseline, no crash. Shipped.
- **`HPET`**: implemented as described (full MMIO device model in
  `src/hpet.js`, registered at `0xFED00000`, satisfying SeaBIOS's
  `build_hpet()` validity checks). The ACPI table did start being emitted
  correctly (56 bytes, matching QEMU's real `HPET` table exactly) — the
  theory about *why* the table was missing was correct. **But it caused a
  real regression**: Windows 8.1, which boots cleanly without it, now
  BSODs partway through boot with `STOP 0x0000005C`
  (`HAL_INITIALIZATION_FAILED`). Bisected by toggling `HPET`/`WAET`
  independently and rebuilding between each run — confirmed `HPET` alone
  is the cause (`WAET` alone is clean). Most likely explanation: this
  implementation's timers are stored but never wired to the IOAPIC (see
  the comment in the now-removed `src/hpet.js`), so if the HAL picks HPET
  as a timer source and enables legacy-replacement routing, it hangs
  waiting for an interrupt that will never fire, and eventually gives up.
  Actually wiring timer interrupts through would be a materially bigger
  task than "add a device model" — **reverted, not shipped**. If picking
  this up again, the interrupt routing is the part that needs solving, not
  the register/table plumbing (that part already works).

With `WAET` alone in place, the "second Windows 10 bug" above was
retested (`tiny10.img`). A 4-minute run was inconclusive (CPU speed
stayed active, no visible boot progress); a follow-up **25-minute**
unattended run resolved the ambiguity: CPU speed stayed steady around
700 mIPS for the entire run (no crash, no drop to zero), but the boot
animation never moved past the spinning logo at any point. So `WAET`
changed the *symptom*, not the outcome — before, execution hit the
missing PDE and everything stopped dead (a real halt); now, whatever is
happening keeps the CPU busy indefinitely without making forward
progress (a livelock, either at the same page-fault site looping instead
of halting, or a different stall entirely — not yet determined which).
Still not booting. The original plan to instrument the debug build and
find out *why* that PDE is zero is still the real next step; `WAET` was
worth trying (cheap, and it's a legitimate table gap regardless) but
doesn't replace that investigation.

**Follow-up debug-build run (which of the two it is): confirmed
livelock, not a repeated fault.** Booted `debug.html` (not release) with
`LOG_PAGE_FAULTS = true`, same `tiny10.img`. Two page faults fire, both
at `cr2=0xf00100d4` (inside the same `0xF0010000+` region as before, but
this time a **read** fault from a plain `MOV r8, [mem]`
(`instr_8A_mem`), not the earlier write via `stosd_rep`/`MOV
CL,[EDX+EAX]` — so it's not necessarily the exact same instruction as the
original find, just the same page). SeaBIOS/Windows compiles one more
page (`Finished compiling for page at 216f000`) right after, and then
**the log goes completely silent for the rest of the run** — zero further
`[CPU ]`-tagged lines (no more faults, no task switches, no new page
compiles, nothing) for the remaining ~170 seconds, while the release
build's speed counter simultaneously shows a steady ~700 mIPS the whole
time. Put together, that means real work is happening (hundreds of
millions of instructions/sec) but it's confined entirely to
already-JIT-compiled code that never touches any of the many logged
event types — consistent with a tight polling/spin loop re-executing the
same cached basic block(s) over and over, not a hang and not forward
progress. That two-fault handoff (read fault → one page compiled → total
silence) is the concrete thing to trace next: what code is at
`eip=0x815747fd`/nearby, and what it's spinning on.

**Pinned the exact spin location.** Sampled the live debug panel
(`cpu.get_regs_short()`, exposed by `debug.html`'s auto-refreshing
`#debug_panel`) every 2 seconds for 30 seconds once the stall had set in.
Every single register — including `esp`, `ebp`, `esi`, `edi`, and `eip`
itself — was **bit-for-bit identical across all 15 samples**. Combined
with the release build's steady ~700 mIPS the whole time, the only
explanation that fits both facts is a tight, register-invariant loop
(something like `jmp $`, or a poll loop whose body never changes any
register) executing at full JIT speed — not a stale display and not a
genuine CPU halt. Critically, **`if=0`**: interrupts are disabled the
entire time. This is kernel code (`cpl=0`) spinning with interrupts
masked, waiting on something that can only change via an interrupt it
has itself turned off, or polling a device/memory flag that v86 never
updates.

(Note: the exact `eip` value differs per boot — the guest's kernel-space
layout isn't identical run to run, see below — so treat the specific
address in the earlier draft of this note as an example, not a constant.)

**Disassembled it. It's `EB FE` — a literal `jmp $`.** Used
`cpu.get_real_eip()` and `cpu.translate_address_system_read()` (both
real wasm-exported CPU methods, not hand-rolled page-table walking) to
correctly translate the *live* eip each run and read the actual bytes
there via the existing physical-memory `read_memory` path. Confirmed
stable across a fresh 3-second re-sample in the same run. The two bytes
at `eip` are `eb fe`: an unconditional relative jump to itself — the
canonical x86 "park this CPU forever" idiom. Not a poll loop, not a
wait-for-interrupt — a dead end, reached deliberately.

**Confirmed causally linked to the earlier page fault, not just
correlated.** Dumped the top of the stack at the parked `esp`: one of
the dwords sitting there is `0xf00100d4` — **the exact `cr2` value from
the page fault logged earlier in the same boot.** The physical address
of the parked code (`translate_address_system_read(eip)`) also lands at
`0x216f26a`, matching the debug log's `"Finished compiling for page at
216f000"` line that printed immediately after that fault. Three
independent signals (stack contents, physical code address, log
timing) all point at the same fault. This is definitively the tail end
of whatever handles that fault failing, not an unrelated stall.

**Ruled out PCI BAR misconfiguration as the cause.** `0xf00100d4` sits
in the address range real PCs typically reserve for PCI MMIO/BARs, so
the natural next suspect was "some device's BAR points here but nothing
backs it in v86." Read live PCI config space directly from the guest
(via ports `0xCF8`/`0xCFC`, enumerating all 32 possible device slots on
bus 0) at the stall point. Result: only one memory BAR exists at all —
the Bochs/QEMU-ID VGA device (`0x1234:0x1111`) at `0xE0000000`, sized by
`vga_memory_size` (8 MB by default, `src/vga.js`) — nowhere near
`0xf00100d4` (`0xE0000000 + 8MB = 0xE0800000`, ~250 MB short of the
fault address). No PCI device claims that address. It isn't a broken
BAR; it's an address nothing in v86's PCI/MMIO map owns at all.

**Checked SeaBIOS's own PCI hole declaration.** `0xf00100d4` falls inside
the range SeaBIOS reserves for PCI resources via ACPI
(`BUILD_PCIMEM_START = 0xE0000000` to `BUILD_PCIMEM_END = 0xFEC00000`
— just below the IOAPIC — patched into the SSDT's `_CRS` from
`pcimem_start`/`pcimem_end` in `src/fw/pciinit.c`/`acpi.c`). But this is
identical, stock SeaBIOS behavior — real QEMU declares the exact same
window — so on its own this doesn't explain a v86-specific gap; it just
confirms the address is inside the range Windows has been told is
legitimately PCI-owned, even though nothing currently occupies that
particular spot within it.

**Definitive: booted the identical disk under real QEMU and it works.**
Ran the exact same `tiny10.img`, deliberately matched as closely as
possible to v86's actual emulated hardware rather than a generic
default — `-machine pc` (i440FX/PIIX3, matching the `8086:1237` host
bridge and `8086:7000`/`8086:7010`/`8086:7113` PIIX3/4 functions found
via the live PCI scan above, *not* q35) and `-smp 1` (v86 is
single-core). Took a screendump via QMP a few minutes in — real QEMU
reaches the actual Windows 10 desktop (Recycle Bin, the post-setup
"allow this PC to be discoverable" network prompt) in the time v86 has
been stuck at the boot logo in every test run so far. This is
conclusive: the disk image is fine, Windows 10 itself is fine, the
guest OS's behavior is fine — **this is a v86-specific emulation gap**,
not a quirk of the OS or a corrupted install.

**Closed the one remaining gap in that conclusion.** The test above used
QEMU's own bundled *modern* SeaBIOS, not v86's exact vendored
`bios/seabios.bin` (rel-1.16.2) — so it didn't fully rule out "something
specific to that old firmware binary" as the cause, separate from v86's
own CPU/device emulation. Reran with `-bios bios/seabios.bin` pointed
directly at v86's actual vendored file (same one used for the earlier
Bochs-BIOS-vs-SeaBIOS ACPI comparison), same `tiny10.img`, same matched
i440FX/single-core config. Result: **boots to desktop successfully** —
Recycle Bin, taskbar, clock all rendering normally. This eliminates
firmware as a variable entirely: the exact same SeaBIOS binary v86 uses
works fine under real QEMU, so the bug cannot be a latent issue in that
firmware itself. It's specifically in how v86 emulates the CPU or
devices underneath that firmware — not the firmware, not the OS, not
the disk.

**Correction — that boot success doesn't mean what it first looked
like.** Dumped this exact QEMU instance's own ACPI tables (same
`pmemsave`-based technique as the HPET/WAET work) to properly retry the
`_CRS`/SSDT diff this enables. Result: **still `HPET`/`WAET` present,
still no `SSDT`** — identical to every other modern-QEMU test tonight,
*even with v86's exact SeaBIOS binary loaded via `-bios`*. So modern
QEMU's `fw_cfg` ACPI injection overrides SeaBIOS's internal table
builder regardless of which firmware image is loaded — the boot-success
test above proves the SeaBIOS *code* has no bug, but the guest never
actually ran on the ACPI *tables* v86's older internal builder produces
(SeaBIOS deferred to QEMU's injected ones instead, silently). The
`_CRS`/SSDT diff is therefore still blocked exactly as documented
earlier — needs a genuinely old QEMU build, not just the old firmware
binary loaded into a new QEMU. Worth being precise about the actual
scope of tonight's conclusion: **confirmed** v86-specific CPU/device
emulation gap, firmware code itself ruled out; **not** confirmed
anything about whether v86's specific ACPI table content is fine, since
that was never actually tested against a real reference.

**Where this leaves it.** Checked one more thing before speculating
further: whether v86 might respond differently than real hardware to
an access landing in *unclaimed* space within that PCI hole (real
hardware/QEMU typically returns "no device" style `0xFFFFFFFF` for
that, never a fault, since the physical bus is always "there"). Traced
the actual dispatch path (`src/rust/cpu/memory.rs`'s `in_mapped_range`,
`src/cpu.js`'s `memory_map_read32`) and that theory doesn't fit: the
fault we're seeing is caught at the **guest's own page-table walk**
(`PTE not present`), which happens entirely before any physical/MMIO
access is ever attempted. Windows never got far enough to touch v86's
memory dispatch at all — it never had a valid page-table entry for that
linear address in the first place. So this isn't about how v86 backs
that physical range; it's about *why Windows's own virtual memory
manager never mapped it there* — a guest-internal decision, not
something v86's device/MMIO layer can differ on by definition. (If a
valid PTE *had* existed and the access reached v86's dispatch with
nothing registered at that block, `memory_map_read32` would throw a
hard JS exception rather than silently returning `-1` — worth knowing
as a separate, real gap, but not the one causing this particular
fault.)

That points the remaining investigation back toward ACPI resource
description: Windows 10's PnP/resource-arbiter stack is meaningfully
newer than 8.1's, and if SeaBIOS's `_CRS` description of the PCI host
bridge's resource window (the same `0xE0000000`-`0xFEC00000` range
patched into the SSDT) is technically valid but incomplete in some way
8.1's older PnP manager tolerates and Windows 10's doesn't, that would
explain both "8.1 boots fine" and "10 fails inside precisely this
window" without needing anything else new. That's a real, checkable
hypothesis but needs either (a) real Windows kernel debugging symbols
(a WinDbg session over v86's serial port, if viable — would show
directly which driver/subsystem decided not to map this address) or
(b) a byte-for-byte diff of the actual `_CRS`/SSDT bytes v86 generates
against what real QEMU generates for the identical chipset config.

**Tried (b) tonight; it's a dead end with the tools on hand — and later
confirmed structurally dead, not just blocked by tooling.** The
ACPI-table-comparison technique that found the HPET/WAET gaps relied on
real QEMU using SeaBIOS's own internal ACPI builder, same as v86 — true
at the time that comparison was done. It doesn't hold here: the only
QEMU available (11.0.0, current Homebrew) always generates its own
ACPI tables via `fw_cfg`, completely bypassing SeaBIOS's internal
builder, *regardless of which SeaBIOS binary is loaded* — confirmed by
loading v86's exact vendored `bios/seabios.bin` via `-bios` and seeing
QEMU-native tables anyway (`HPET`/`WAET` present, no `SSDT` at all,
where v86's rel-1.16.2-built tables always include an `SSDT` and, before
tonight, no `HPET`/`WAET`).

Later in the same session, pulled Docker (`debian:bullseye`,
`qemu-system-x86 5.2.0`, a genuinely old build from 2020/2021 — well
before v86's SeaBIOS rel-1.16.2 vendoring) specifically to retry this
with an old QEMU, since the earlier note framed it as blocked only by
not having one on hand. Ran the identical test (v86's exact
`seabios.bin` via `-bios`, headless, `pmemsave`-based ACPI dump): same
result — `HPET`/`WAET` present, no `SSDT`. So this isn't a recent QEMU
behavior that an old-enough build would sidestep; QEMU has deferred to
its own `fw_cfg`/`bios-linker-loader` ACPI generation over loaded
firmware for at least 5+ years. Getting genuinely different behavior
would need a QEMU old enough to predate that mechanism entirely
(pre-2013/2014-ish), which is impractical to obtain or build in a
useful state. This closes the byte-for-byte `_CRS` diff idea for real,
not just for tonight — (a), the WinDbg route, remains the only
structurally viable path to a real comparison. Deliberately **not**
attempting a speculative fix here — there's no verified understanding
yet of what's actually missing,
and shipping a guess would repeat the HPET mistake instead of learning
from it.

**Also tried: swapping SeaBIOS for the old Bochs BIOS entirely.**
[halfix](https://github.com/nepx/halfix) — another portable x86
emulator, README claims it boots Windows 10 to desktop natively (v86's
target, confirmed by the project author with a screenshot of a working
desktop) — uses the classic Bochs BIOS/ROMBIOS, not SeaBIOS. v86
already vendors both (`bios/bochs-bios.bin` alongside `bios/seabios.bin`,
switchable via `?bios=bochs` — see `settings.use_bochs_bios` in
`src/browser/main.js`). Two things worth separating: halfix's own
`src/hardware/acpi.c` is the *runtime* PIIX4 ACPI register interface
(PM1 status/enable/control, SMBus stub, PCI config space) — read
through it fully, and it's essentially equivalent in scope to what
v86's `acpi.js` already implements. There's nothing to "port" at that
level; ACPI *tables* (FADT/DSDT/`_CRS`) are generated by the BIOS, not
this runtime code, in both halfix and v86 alike.

So the real test was: does swapping v86's firmware to Bochs BIOS change
the Windows 10 outcome? Booted `tiny10.img` under `debug.html?bios=bochs`
for 11 minutes. Result: no crash (unlike SeaBIOS's BSOD-then-`jmp $`),
but also **zero visible progress** — frozen at the exact same boot logo
the entire time, indistinguishable by screenshot from a genuine hang.
Whether that's actually a livelock (like the SeaBIOS case, which *did*
show steady non-zero CPU speed even while visually frozen) or a true
halt wasn't checked before concluding — worth 30 seconds of checking the
stats panel before ruling this fully out. Practical conclusion either
way: swapping the whole BIOS trades one failure mode for a different,
less informative one (no crash to analyze, no fault address to chase),
it doesn't get Windows 10 running. Not pursuing further tonight.

**That first Bochs BIOS test was flawed, though — retried properly.**
`strings` on v86's actual vendored `bios/bochs-bios.bin` turns up *zero*
ACPI-related content at all (no `FACP`/`DSDT`/`RSD PTR` strings) — this
specific prebuilt binary has ACPI compiled out entirely, unlike halfix's
own `bios.bin` (`strings` shows `FACP`, `DSDT`, `BXDSDT`, real
table-construction code). So the first test wasn't "does a different
BIOS's ACPI tables work better" — it was "what happens with *no* ACPI at
all," a different and less useful question. Retried by swapping in
halfix's actual `bios.bin`/`vgabios.bin` directly (backed up the
originals first, restored them after). Result: same outcome — 13.5
minutes, no crash, frozen at the identical boot logo the whole time.
So even a real, ACPI-table-generating Bochs BIOS doesn't move the
needle either. This rules out "just needed real ACPI tables from a
different BIOS" more conclusively than the first attempt did. The
underlying SeaBIOS/`_CRS` investigation above remains the most promising
unexplored thread; BIOS-swapping as a shortcut is now tried twice and
closed both times.

**A real, verified platform-timing gap — checked as a possible cause,
turned out weaker than it first looked.** Comparing halfix's ACPI PM
timer (`acpi_get_clock` in `src/hardware/acpi.c`: a direct scale of its
own internal deterministic tick counter, always monotonic) against
v86's (`ACPI.prototype.get_timer` in `src/acpi.js`) surfaced a real
structural difference: v86's PM timer is driven by `v86.microtick()`,
which is wall-clock based (`performance.now()`/`Date.now()`,
`src/main.js`) — a browser-timing-precision constraint halfix (native,
no such limit) doesn't have. To compensate, `get_timer` layers an
"imprecision offset" hack on top that can genuinely **stall** (return a
stale, non-advancing value across many consecutive reads) when polled
faster than wall-clock time actually advances — confirmed live, not
theoretical: booted `tiny10.img` under `debug.html` with full logging
and counted **4,533** `"Overshot pmtimer, waiting"` warnings across a
single boot. Initially looked like a smoking gun — a dense burst of ~35
of them landed in the 80ms immediately before the fatal page fault —
but breaking down the full log by 10ms bucket shows the rate is flat
(30-70 occurrences per bucket) for the *entire* ~8-second window from
first occurrence to the fault, not a spike specific to the fault.
So this is chronic, steady-state behavior throughout this phase of
boot, not a discrete trigger event immediately preceding the crash.
Real, verified, and worth fixing on its own merits (a native
deterministic-tick-driven PM timer, like halfix's, would remove an
entire class of platform-timing inaccuracy v86 currently has) — but
not confirmed as *the* cause of this specific fault. Worth keeping in
mind as a contributing-factor candidate, not oversold as solved.

**A real, unrelated-but-significant PCI gap, found comparing against
halfix's device config space.** Diffed halfix's static PIIX4 ACPI PCI
config bytes (`acpi_configuration_space` in `src/hardware/acpi.c`)
against v86's equivalent (`pci_space` in `src/acpi.js`) byte-for-byte.
Real hardware/halfix reset the Command register (config offset `0x04`)
to `0x0000` — I/O space, memory space, and bus mastering all *disabled*
until the BIOS/OS explicitly enables them, standard PCI behavior. v86's
default is `0x0007` — all three **pre-enabled** before any BIOS/OS
request. Checked whether this matters in practice by reading
`PCI.prototype.pci_write32` in `src/pci.js`: **writes to offset `0x04`
are a deliberate no-op** — logged but never applied (`space[addr >>
2] = written` happens for every other offset's fallthrough case, but
the `addr === 0x04` branch only calls `dbg_log`). This isn't
ACPI-specific; it's generic PCI config-space handling, so it applies to
*every* PCI device v86 emulates. Practical effect: no guest can ever
actually disable or re-enable a device's I/O/memory/bus-master decode
through the standard PCI mechanism — v86 always behaves as if
everything is permanently enabled, regardless of what the guest
believes it just configured.

This is a real, structurally significant, easily-verified gap
(objectively incomplete PCI emulation, independent of whether it's
related to the Windows 10 stall) — Windows's PnP resource manager
routinely disables a device's decode, reprograms its BARs, and
re-enables it as part of normal resource (re)assignment; if v86 always
keeps the device live regardless, the guest's internal bookkeeping
(which assumes the disable succeeded) can diverge from what's actually
happening, exactly the kind of host/guest state mismatch that could
plausibly confuse a resource arbiter.

**Fixed the narrow part; the broader part is still open.** On reflection,
the no-op wasn't actually one indivisible thing — `pci_write8` and
`pci_write16` already write through offset `0x04` correctly (no special
case at all); only `pci_write32` had the no-op. That's a much
lower-risk fix than it first looked: removing the special case just
makes the 32-bit path consistent with the two paths that already work
correctly in production, rather than inventing new behavior. Shipped
that (regression-tested three times against Windows 8.1 — one run hit
the same `pic.rs` flake documented earlier, at the same rate seen all
night independent of code changes; two clean reruns after). What's
**still** unfixed and still a bigger, riskier undertaking: this only
makes the register *persist* what's written to it (so a driver doing
read-after-write verification now sees consistent state) — it does
**not** make v86 actually *behave* differently based on those bits
(I/O/memory/bus-master decode still isn't gated by this register's
value at all). That part still needs wiring dynamic enable/disable
through `io.js` for every device class if it's ever tackled.

**A halfix/v86 IDE divergence that turned out to be halfix, not v86,
being the outlier — checked against QEMU before trusting the flag.**
While broadening the halfix diff to IDE (the device most actively used
right up to the fault, per the very first investigation above — 1800+
successful DMA transfers before everything stops), found that halfix's
`ide_raise_irq` (`src/hardware/ide.c`) sets the bus-master DMA status
register's "Interrupt" bit unconditionally on completion, while v86's
`IDEChannel.prototype.push_irq` (`src/ide.js`) only sets that same bit
inside the NIEN-gated branch that also raises the real IRQ. Initially
flagged this as a possible v86 bug — but rather than trust a two-way
comparison without a stronger reference, checked QEMU's actual IDE
source (`hw/ide/core.c`'s `ide_bus_set_irq`, `hw/ide/pci.c`'s
`bmdma_irq`): QEMU gates `qemu_irq_raise` itself on the NIEN-equivalent
bit (`IDE_CTRL_DISABLE_IRQ`), and since that's what feeds the status-bit
write, **QEMU's status bit is also NIEN-gated** — matching v86, not
halfix. So this was backwards: v86 was already correct, halfix is the
outlier here. No fix needed; corrected before it could mislead a future
attempt into "fixing" already-correct code. Lesson for any further
halfix comparisons: halfix is a useful second opinion, not a ground
truth on its own — cross-check against QEMU (or real hardware docs)
before trusting a flagged divergence, the way this one almost went
the wrong way.

**The big one: every test tonight silently ran with ~2GB of RAM, not
2560MB as configured.** Went further than register-level comparison —
used `iasl` (`brew install acpica`) to actually decompile v86's live
SSDT and DSDT AML bytecode into readable ASL, something not attempted
earlier tonight (the earlier SSDT-diff attempts were about comparing
*byte content* against a reference; this is about reading what v86's
*own* tables actually say). In the DSDT, the PCI0 host bridge's `_CRS`
method reads external globals `P0S`/`P0E` (pcimem_start/pcimem_end) —
defined in the SSDT as `Name (P0S, 0x80000000)`. That's 2GB. Checked
SeaBIOS's actual branch logic for choosing that value
(`src/fw/pciinit.c`): `if (RamSize <= 0x80000000) pcimem_start =
0x80000000; else if (RamSize <= 0xc0000000) pcimem_start =
0xc0000000;`. Our test config used `memory_size=2560` (MB) — 2560MB is
*greater* than 2048MB, so this should have taken the second branch.
It didn't, which meant SeaBIOS's view of `RamSize` had to be wrong.

Checked directly, not inferred: dumped `cpu.memory_size[0]` from a live
v86 instance configured with `memory_size=2560`. Actual value:
`2,147,352,576` bytes — **2047.875 MB**, not 2560MB. Traced to the exact
line: `CPU.prototype.create_memory` in `src/cpu.js`:

```js
else if((size | 0) < 0)
{
    size = Math.pow(2, 31) - MMAP_BLOCK_SIZE;
    dbg_log("Rounding memory size down to " + size, LOG_CPU);
}
```

`size | 0` coerces to a **signed** 32-bit integer. 2560MB
(2,684,354,560 bytes) is above `2^31 - 1`, so it wraps negative,
triggering this clamp — to `2^31 - MMAP_BLOCK_SIZE` =
`2,147,352,576`, matching the observed value exactly. **v86 cannot
actually run with 2GB or more of RAM at all** — any requested size at
or above 2GB silently clamps to ~2047.875MB, with no error, no warning
in the UI, nothing. Every single test run tonight (this investigation
and probably a large fraction of everything logged in this document
before tonight too, given `2560` has been the standard test config
throughout) has been running on ~512MB less RAM than intended.

This is deliberate, handled code — not an oversight in the sense of
an unconsidered case — so whatever originally motivated capping memory
below `2^31` (something downstream that needs sizes/addresses to fit
in a signed 32-bit range without overflow) needs auditing before this
limit can simply be raised; not attempting that blind tonight. But the
immediate, cheap, valuable thing is retesting the Windows 10
investigation with a memory size that's honestly *inside* the actual
supported range (e.g. 1024MB or exactly at the clamp boundary) instead
of unknowingly running at a silently-clamped, non-round value the
whole time — completely untested angle, about to try it now.

**Started that audit, didn't finish it.** Checked the two most directly
relevant downstream consumers of `size` after the clamp: JS-side
storage (`this.memory_size = view(Uint32Array, ...)` — correctly
unsigned, no 2GB issue) and the actual Rust-side allocator
(`allocate_memory(size: u32) -> u32` in `src/rust/cpu/memory.rs`, and
`in_mapped_range(addr: u32)` in the same file — both `u32` throughout,
no inherent 2GB constraint found). Neither of the two places checked
shows a genuine reason for the cap, which suggests it may be more
conservative than strictly necessary — but that's exactly the kind of
partial finding that's dangerous to act on: JS bitwise operators
(`|`, `&`, `^`, `<<`, `>>`) are *always* signed-32-bit regardless of
target type, and there could easily be another comparison or bitwise
op elsewhere in the ~10,000+ line JS layer (or in JIT-generated code
paths) that silently depends on addresses fitting in a signed range,
not yet found. Two clean spots isn't a clean codebase. Not raising the
limit without a real, complete audit — flagging the two checked
call sites so a future attempt doesn't have to re-derive them, but the
audit itself is still open.

**Extended the audit further, and it points at a different, more
complete explanation than "code assumes signed addresses."** Checked
the Rust core's most heavily-used memory-access API —
`safe_read8`/`safe_write32`/etc. throughout `src/rust/cpu/cpu.rs` —
and confirmed they *do* take `addr: i32` (signed) pervasively. Initial
read: "there's the reason." Closer look rules that out as the actual
constraint on `memory_size` specifically: these functions handle
**virtual/linear** addresses, not physical RAM size directly, and this
entire session has exercised virtual addresses well above `0x80000000`
correctly all night without incident (every Windows kernel EIP value
traced tonight — `0x813...` and similar — is itself above 2GB; that's
normal, kernel-space is the upper half of a flat 32-bit address space
regardless of how much RAM is configured). A bit pattern is a bit
pattern; `i32` vs `u32` only matters where code does a signed
*comparison* or *shift*, not for round-tripping the value itself, and
none of the flagged usages here showed that failure mode.

The clamp's actual chosen value — `2^31 - MMAP_BLOCK_SIZE`, suspiciously
close to "2GB minus a hair" — points somewhere more mundane: browser/
wasm-engine memory allocation limits. `wasm32` (not `memory64`) has a
hard 4GB linear-memory ceiling by spec, but individual JS engines have
historically capped a single `WebAssembly.Memory` well below that —
V8 (Chromium/Node, what this project is tested against) has had
various practical ceilings around the 2-4GB range depending on version
and platform. No explicit `--max-memory`-style flag exists in this
repo's `Makefile`, so if that's the real reason, it was chosen
empirically by the original author rather than pinned to a build
setting anywhere greppable — consistent with not finding it in the
two code paths already checked.

If true, this reframes what raising the limit actually requires: not
"fix code that mishandles large signed addresses" (no evidence that's
real) but "verify current V8/browser wasm-memory limits actually
support more than ~2GB reliably, and raise the clamp to whatever that
new safe ceiling is" — a different, more empirical kind of validation
(cross-browser/engine testing) than a code audit, and one this
environment can only partially do (only Chromium via Playwright is
available here, not the full range of browsers/versions v86 users
might run). Still not attempting the fix — the *category* of what's
needed is clearer now, but "clearer" isn't "verified."

**Retested — decisive result, but not the one hoped for.** Booted the
identical `tiny10.img` with `memory_size=2047` (confirmed honored this
time: `cpu.memory_size[0]` = 2,146,435,072 bytes, correctly under the
clamp boundary, no silent rounding). This eliminates the RAM/PCI-hole
overlap entirely — with RAM now genuinely topping out below 2GB,
SeaBIOS's own `pcimem_start = 0x80000000` branch is the *correct* one
to take, not an accidental miscalculation colliding with real memory.
Ran the full 25 minutes past every previous stall point many times
over. Result: **identical outcome** — stuck at the same boot logo, and
the exact same fault (`cr2=0xf00100d4`) still fires. So the memory
clamp bug is real, worth fixing on its own merits (it silently affects
any user who configures 2GB+ RAM, completely independent of Windows
10), but it is conclusively **not** the cause of this specific stall —
removing the RAM/PCI-hole collision it was causing didn't change
anything. Good to have this cleanly separated rather than left
conflated: one confirmed-real, independently-valuable bug fix
candidate, and the original mystery narrowed rather than solved.

**Real breakthrough: WinDbg kernel debugging is now actually
achievable, and confirmed working end-to-end.** The macOS-side blocker
from earlier in this session (no working NTFS write path — `mount_ntfs`
absent, `ntfs-3g` won't build on macOS, macFUSE alone doesn't solve it)
turned out to have a clean solution: Docker. `docker run --privileged`
gives a real Linux container with working loop devices, `kpartx` to
expose partitions, and genuine `ntfs-3g` read-write support (Linux's
native target). Concretely, on a **copy** of `tiny10.img` (never the
original — `cp -c` for a cheap APFS clone):

1. `losetup -fP disk.img`, `kpartx -av /dev/loop0` → exposes
   `/dev/mapper/loop0p1` (boot/BCD partition) and `loop0p2` (Windows).
2. Both partitions come up NTFS-dirty (Windows Fast Startup leaves this
   state even after an apparently clean shutdown) — `ntfs-3g` refuses
   read-write mount until fixed. `ntfsfix /dev/mapper/loop0pN` clears
   it (note: this discards the fast-startup hibernation state, which is
   fine — we don't want to resume it anyway).
3. Used `hivexsh` (from `libhivex-bin`) to edit the BCD hive directly —
   NOT `bcdedit.exe` itself: tried running the real `bcdedit.exe` from
   the mounted image under Wine first, but that fails outright (Wine
   can't satisfy real Windows System32 binaries' dependencies on real
   NT DLLs like `api-ms-win-core-console-l1-2-0.dll` — this only works
   for normal Wine-hosted applications, not system tools tightly
   coupled to real NT internals). `hivexsh -w` (write mode) with `add`
   (create key) / `setval` (write value) / `commit` worked cleanly.
4. Found the default OS loader object via the Boot Manager's
   `{9dea862c-5cdd-4e70-acc1-f32b344d4795}\Elements\23000003` (a single
   GUID value) — landed on `{2486a71f-9773-11f1-9fd8-b7be162b8c63}` for
   this image. Created element `260000a0` (`KernelDebuggerEnabled`)
   there with an 8-byte-aligned `REG_BINARY` value `01` (matching the
   format of existing boolean-ish elements in the same store).
5. First boot with only that change showed **zero** serial activity at
   all — turned out the pre-existing Global Debug Settings object
   (`{4636856e-540f-4170-a130-a84776f4c654}\Elements\15000011`, value
   `4`) was set to `LOCAL` debug type (confirmed indirectly: extracted
   strings from the real `bcdedit.exe` on the image —
   `strings -el bcdedit.exe | grep -i serial` — which lists the CLI's
   own debugtype enum as `SERIAL, 1394, USB, NET, LOCAL`; `LOCAL`
   doesn't touch any physical transport at all, which fits the total
   silence perfectly). Changed that element to `0` (`SERIAL`) instead —
   didn't add explicit debugport/baudrate elements, since `bcdedit`
   defaults to COM1/115200 when unspecified.
6. Rebooted the patched image under v86's debug build with the
   existing `LOG_SERIAL` logging (`src/uart.js`) enabled (checkbox id
   is actually `log_seri`, not `seri` — auto-generated as
   `"log_" + name.toLowerCase()` in `src/browser/main.js`). **Real
   kernel-debugger protocol traffic appeared**: literal readable
   fragments including `"KDTARGET: Refreshing KD connection"` and
   `"\SystemRoot\system32\ntoskrnl.exe"`, repeating — Windows actively
   retrying a KD handshake with no debugger yet listening on the other
   end, exactly the expected behavior.

This is a real, working, reproducible kernel-debug channel — not yet
turned into an actual interactive WinDbg session (that needs something
on the *other* end of v86's emulated COM1 speaking the KD protocol
back, which nothing does yet). The concrete next step is bridging
v86's UART to something a real debugger can attach to — check
`src/uart.js`/`src/browser/serial.js` for whether v86 already exposes
the emulated serial port over a real transport (WebSocket, TCP) that
a host-side tool could connect to, since that's the remaining piece
between "confirmed reachable" and "actually usable."

**Built that bridge; got real protocol bytes; stopped short of a full
handshake rather than guess blind.** v86 doesn't expose serial over a
real transport natively, but the pieces to build one are there: `bus.send("serial0-output-byte", byte)`
fires on every guest-transmitted byte, and `bus.send("serial0-input", byte)`
injects a byte into the guest's receive path (`src/uart.js`). Wrote a
Playwright-driven bridge
(`debug-artifacts/v86_serial_bridge.js`, checked into the repo) that hooks both via
`page.exposeFunction`/`page.evaluate` and relays to a plain TCP server
on `127.0.0.1:7788`. A raw Python client connecting to that port
receives real, live bytes from the guest's COM1 — confirmed by
capturing a clean, structured, repeating ~232-byte block that matches
known `KD_PACKET` framing almost exactly: 4-byte leader `0x30303030`,
then `PacketType`/`ByteCount`/`PacketId`/`Checksum` as little-endian
`u16/u16/u32/u32`, a data payload, and a trailer byte `0xAA` right
where expected. Parsed one live packet: `type=0x7 bytecount=0xf4
packet_id=0x80800800 checksum=0x45c0` — that `PacketId` is suspiciously
close to the documented `INITIAL_PACKET_ID = 0x80800000` constant,
which is a good sign the structural read is roughly right.

Made one well-reasoned attempt at acknowledging it — a `CONTROL_PACKET`
per the same recalled schema (`leader 0x69696969`, `type=4`
`PACKET_TYPE_KD_ACKNOWLEDGE`, `bytecount=0`, the parsed `PacketId`,
`checksum=0`) — sent it over the bridge and watched for the
retransmission to stop. It didn't; the target kept resending the
identical state-change packet unchanged. That's a clean, unambiguous
negative result, not a partial success: either the exact packet format
has a detail wrong (byte order in a subfield, a different leader for
this particular packet type, a required prior RESET exchange this flow
skips past), or genuinely something else in the handshake is missing.

**Ruled out one real alternative explanation before giving up on it.**
The original bridge injected incoming bytes one at a time, each via its
own `page.evaluate()` round-trip (real CDP latency per byte) — a
legitimate concern that the guest's packet reassembly could have some
inter-byte timeout the injection was blowing past, independent of
whether the packet bytes themselves were correct. Fixed the bridge to
batch an entire incoming write into a single `page.evaluate()` call
that loops *inside* the page context (`window.__serialInjectBytes`,
now in the committed `debug-artifacts/v86_serial_bridge.js`) —
effectively instantaneous injection instead of per-byte round-trips.
Restarted the VM fresh, captured a new live packet
(`type=0x7 bytecount=0x112 packet_id=0x80800800` — same type and
`PacketId` as before, different `bytecount`, consistent with a
different KASLR layout on this particular boot, nothing alarming), and
sent the identical ACK format again. Same clean negative result:
retransmission continued unchanged. That rules out injection timing as
the problem — the issue really is the protocol bytes themselves, not
an infrastructure artifact.

With cheap iteration now confirmed (each attempt takes seconds, no VM
reboot needed), tried two more small, well-reasoned variations before
stopping for real: (A) the same leader as data packets (`0x30303030`)
instead of the control-packet leader (`0x69696969`), still matching
`PacketId`; (B) the control leader with `PacketId=0` fixed instead of
echoing the data packet's ID (some KD implementations use a constant
ID for control packets). Both clean negatives, same unchanged
retransmission. Four total variants tried, all negative — this is
where guessing genuinely stops being productive; the remaining
plausible variations (checksum computation, a required prior RESET
exchange, a completely different control-packet structure) aren't
small tweaks anymore, they're different enough that trying them without
a specification is just noise.

Deliberately **stopped here** rather than keep guessing field-by-field
with no way to verify against a real specification — that's a
recipe for burning a lot more time without confidence in the result,
different from the earlier register-comparison work tonight where
QEMU/SeaBIOS source gave something authoritative to check against.

**What's left, concretely, for whoever picks this up:** the bridge
itself (`debug-artifacts/v86_serial_bridge.js`) is real, tested, working infrastructure
— point any real KD-protocol-speaking tool at `127.0.0.1:7788` (while
the bridge process is running against the BCD-patched
`tiny10-windbg.img`) and it should be able to complete the handshake a
correct implementation would need. That could be: (a) real WinDbg,
if run from an actual Windows machine with a way to reach this TCP
port (the bridge binds `127.0.0.1` only right now — trivial to change
to `0.0.0.0` for LAN access, not done here since that widens exposure
and wasn't needed for a same-machine test); or (b) a from-scratch KD
client written against the actual public protocol documentation this
session didn't have access to (Microsoft's `windbgkd.h`/`dbgeng`
headers, or the well-known community reverse-engineering writeups of
the KD wire format) — the packet capture in `debug-artifacts/kd_capture.bin` is a real, live, correctly-captured sample to
validate any such implementation against, which is worth more than it
sounds: most of the effort in a from-scratch protocol client is
usually spent getting *a single real capture* to test against, and
that part's already done.

If picking this up again: the diagnostic infrastructure is still in place
and reusable — protected-mode-only fault-class exception logging with
disassembly at the fault site (`call_interrupt_vector` in
`src/rust/cpu/cpu.rs`), `do_task_switch` tracing, page-directory-entry
write-watchpoints (`memory.rs`), DMA-completion tracing (`src/ide.js`),
and release-build-visible logging for I/O ports, both unhandled
(`IO.prototype.port_read8`/`port_write8` in `src/io.js`) and full-traffic
(`LOG_ALL_IO`) — all `console_log!`-based, not gated by `dbg_log`/`DEBUG`,
so they work in the fast release wasm, not just the slow debug build.

## x86-64 (long mode) — needed for Windows 11

This is a different category of problem, not an extension of the 8.1/10
work. Windows 11 has no 32-bit edition — there's no fallback ISO to reach
for — so the CPU has to actually support long mode.

Put simply, this is v86's emulated CPU generation jumping from roughly
Pentium 4-level (32-bit only, single core, SSE2/SSE3 — the upstream Readme's
own description) to roughly Core 2 Duo-level: Intel's first mainstream
64-bit *and* real dual-core consumer CPU. Both properties matter for
Windows 11 (long mode for the OS to boot at all, a second core because it's
heavily recommended), and neither exists in v86 today.

A smaller, concrete waypoint on the way there: **Intel Core Solo** (Yonah,
2006) — same generation as Core Duo, but single-core and, notably, still
32-bit only (no Intel 64/EM64T; that shipped with Core 2/Merom later that
year alongside SSSE3). So Core Solo sits *between* the Pentium 4 baseline
and Core 2 Duo: still single-core and 32-bit like today's v86, but with
SSE3 rather than stopping at SSE2. Some of the SSSE3/SSE4.1 work in the
"Speeding up the CPU" / Windows 10 sections below already goes past what
Core Solo actually had (SSSE3 didn't exist yet on that chip) — so in
instruction-set terms v86 is arguably already ahead of Core Solo and
heading toward Core 2, just still missing the two properties (64-bit,
multicore) that actually define the Core 2 generation.

v86 has **zero 64-bit support today**: no long mode, no 4-level (or 5-level)
paging, no `R8`-`R15` / 64-bit register file, no 64-bit instruction encoding
(REX prefixes, RIP-relative addressing, etc). This is called out as a known
gap in the upstream Readme, and it isn't something the NX/CRC32 work here
touches at all.

Rough shape of what it would take:
- A 64-bit register file and REX prefix decoding throughout the
  interpreter/JIT/analyzer, not just a few opcodes.
- Long mode paging (4-level, and probably 5-level for future-proofing),
  built on top of the existing PAE page-walk code in
  `src/rust/cpu/cpu.rs::do_page_walk` — same function this fork's NX work
  lives in, but a substantially larger extension.
- 64-bit instruction forms for most of the existing 32-bit instruction set,
  since instructions behave differently under REX (operand size defaults,
  extended registers, RIP-relative memory operands).
- CPUID leaf 0x80000001 already advertises the LM bit as absent-safe
  (nothing claims long mode support), so this also means auditing anywhere
  compatibility-mode / long-mode CPUID inputs are assumed to correlate.
- Windows 11's own extra requirements on top of that. The actual minimum
  *spec* bump over Windows 10 is RAM — Microsoft lists 4 GB minimum for 11
  vs. 2 GB for 10, so a v86 VM needs to be provisioned accordingly. Core
  count is listed on Microsoft's spec sheet too (2+ cores), but it's not
  something Setup hard-enforces the way it does the CPU/RAM/storage floor —
  more a "heavily recommended for it to actually be usable" than a strict
  blocker. Since v86 has no real multicore support today (called out in the
  upstream Readme's gap list too), worth checking early whether Windows 11
  setup even cares whether the reported core count is real vs. just
  something CPUID claims. TPM 2.0 and Secure Boot are a separate category:
  platform *gating* checks rather than resource requirements, and normally
  bypassable for VM installs (registry edits during setup, or images
  pre-modified to skip them) — worth tracking as a compatibility item, but
  not the thing that makes 11 need more from the emulator itself.

This is realistically a multi-month project on its own, done by someone
comfortable with x86-64 architecture internals — not a bug-hunting loop like
the 8.1/10 work. Worth treating as a separate effort with its own design
pass, not something to bolt onto this fork incrementally.

### Validation order: Linux x64 → Windows 10 x64 → Windows 11

Don't point freshly-written long mode support at Windows 11 first. Windows
is the worst possible feedback loop for debugging new CPU architecture
support — heavy boot chain, driver signing, TPM/Secure Boot checks, and (per
the 8.1 investigation) a habit of silently relying on instructions/features
that only reveal themselves as fatal bugchecks deep into setup. Stage it
instead:

1. **A minimal x64 Linux kernel/initramfs first** (e.g. a Buildroot image,
   similar to what upstream v86 already uses for some 32-bit Linux demos).
   Linux is far more forgiving to boot, has verbose serial console output
   instead of opaque bugchecks, and a minimal build touches a much smaller
   slice of the new long-mode code than a full desktop OS does. This is
   where the bulk of "does the register file/paging/decode actually work at
   all" bugs should get caught, with fast, legible iteration — exactly the
   kind of tight loop the CRC32 fix depended on.
2. **Windows 10 x64** next. Same OS family and driver model Windows 11
   uses, but without the TPM/Secure Boot gate, and a lower minimum RAM spec
   (2 GB vs. 11's 4 GB) — lighter to provision and easier to boot in a v86
   VM while long mode support is still being shaken out. This isolates
   "does long mode work under a real Windows kernel" from Windows 11's
   extra platform checks. Also directly useful on its own terms
   (Steam/Chrome/etc. compatibility is much less of a concern on x64 than on
   32-bit, per the section above).
3. **Windows 11** last, once long mode is already proven solid under both
   Linux and Windows 10 x64, and the VM is provisioned with enough RAM
   (4 GB+) to meet its actual minimum spec. At that point the remaining
   work is mostly Windows 11-specific gating (TPM/Secure Boot), not core
   CPU correctness — a much smaller, better-isolated problem than debugging
   long mode and Windows 11 compatibility at the same time.

## Speeding up the CPU

Separate axis from OS compatibility — this is about making whatever already
boots (8.1 today, 10/11 eventually) run faster, which matters more as target
OSes get heavier. Already done as of this fork: `wasm-opt -O2` enabled in
the release build (`WASM_OPT=true` in the Makefile), which shrank
`v86.wasm` by roughly a third. Beyond that, roughly in order of
likely-cheapest-to-try first:

- **Profile before guessing.** The Cargo `profiler` feature
  (`make with-profiler` / `debug-with-profiler` targets, `docs/profiling.md`)
  gives real per-function timing inside the JIT. Worth running against an
  actual Windows 8.1 boot to see where time genuinely goes before assuming
  it's "the JIT" or "the NX checks" — the NX/CRC32 work added real per-access
  overhead (extra TLB bit checks, instruction-fetch vs. data-read
  distinction in `do_page_walk`) that's never been profiled to see if it's
  actually significant or just theoretically slower.
- **JIT coverage.** `stat::RUN_INTERPRETED_*` counters (see `cycle_internal`
  in `src/rust/cpu/cpu.rs`) track how often execution falls back to the
  slow interpreted path instead of compiled code — differing state flags,
  pages near the end of a page, etc. Worth checking what fraction of a
  Windows boot runs interpreted vs. JIT-compiled.
- **Multicore, again.** Beyond being a Windows 11 spec item, real SMP would
  be a straightforward win for anything that's actually parallel (Windows
  installs/updates do use multiple threads), independent of raw per-core
  speed.
- **Browser choice matters today, without any code changes.** V8-based
  browsers (Chrome/Edge) JIT-compile and execute the wasm noticeably faster
  than JavaScriptCore/Safari for this kind of hot, branch-heavy code — worth
  stating explicitly for anyone benchmarking or comparing results.

## The actual end goal: Windows 11 on a Chromebook

All of the above is in service of one target: running Windows 11 inside the
Chrome browser on an actual Chromebook. Worth stating explicitly, because it
reframes the whole roadmap's priority order — "boots" and "usable on a
Chromebook's hardware" are two different bars, and both sections above have
to land for it to be real, not just the compatibility one.

This is a more natural fit than it might sound like at first — v86 is
browser-native, and ChromeOS's entire app model *is* the browser, so this
isn't a weird stretch target, it's arguably the most natural deployment
surface this project has. But performance will be the harder constraint,
more than compatibility:

- Chromebooks skew toward weaker hardware than a typical dev machine —
  low-power Celeron/Pentium-N-class x86 chips, or ARM, and less RAM. Running
  a full Windows 11 install through a software x86-64 JIT on top of that
  makes the "Speeding up the CPU" section above load-bearing, not optional.
- **x86 vs. ARM Chromebooks matter differently than expected.** On x86
  ChromeOS devices, the wasm just runs on real x86 hardware via Chrome's
  JIT — straightforward, same as any other x86 host. On ARM Chromebooks, V8
  still JIT-compiles the wasm to native ARM code transparently, so it works
  either way — but that's an extra translation layer that doesn't exist on
  x86 hosts, worth keeping in mind when comparing performance across
  devices.
