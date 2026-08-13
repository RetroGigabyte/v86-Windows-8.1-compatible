# Future work

Notes on what it would take to push this fork further, based on how the
Windows 8.1 fix actually went. Kept here mainly so the next person (or
future me) doesn't have to re-derive the reasoning from scratch.

## Windows 10 (32-bit)

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

Best-supported theory: **v86 emulates a PIIX3/i440FX-class chipset**
(2004-era, Pentium-4-generation PCI/ACPI topology — see `src/pci.js`/
`src/acpi.js`), but the QEMU install used to produce the comparison disk
image was `-machine q35` (ICH9-class, 2008-era, Core-2-generation). Same
SeaBIOS binary in both cases, but a fundamentally different PCI/ACPI
hardware topology described to it — not an apples-to-apples comparison.
Windows 10's kernel/HAL increasingly assumes q35/ICH9-class platform
features (fuller APIC/IOAPIC routing, MSI-capable interrupt delivery,
newer ACPI resource descriptors) that don't exist on PIIX3-class hardware,
regardless of how correct the CPU instruction emulation is. This also
lines up with the historical `copy/v86#86` GitHub issue (Windows XP not
booting years ago because "the APIC implementation is quite incomplete")
— that ceiling was raised since, but apparently not all the way to
q35-class completeness.

**If this theory is right, the fix isn't a targeted patch** — it's adding
a newer virtual chipset (ICH9/q35-class: new PCI topology, MMCONFIG
support, more complete IOAPIC) alongside or instead of the current
PIIX3-class one. That's a substantial feature addition, comparable in
scope to the x86-64 work below, not an instruction-level bug fix. Worth
validating the theory further (e.g., diffing SeaBIOS's actual generated
ACPI tables under v86 vs. under `-machine q35`) before committing to that
scope of work.

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
