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

## x86-64 (long mode) — needed for Windows 11

This is a different category of problem, not an extension of the 8.1/10
work. Windows 11 has no 32-bit edition — there's no fallback ISO to reach
for — so the CPU has to actually support long mode.

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
  vs. 2 GB for 10, so a v86 VM needs to be provisioned accordingly. TPM 2.0
  and Secure Boot are a separate category: platform *gating* checks rather
  than resource requirements, and normally bypassable for VM installs
  (registry edits during setup, or images pre-modified to skip them) — worth
  tracking as a compatibility item, but not the thing that makes 11 need
  more from the emulator itself.

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
