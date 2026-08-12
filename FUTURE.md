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

## Windows 11 (x86-64)

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
- Windows 11's own extra requirements on top of that (TPM/Secure Boot
  checks, which are normally bypassable for VM installs, and generally
  heavier resource expectations).

This is realistically a multi-month project on its own, done by someone
comfortable with x86-64 architecture internals — not a bug-hunting loop like
the 8.1/10 work. Worth treating as a separate effort with its own design
pass, not something to bolt onto this fork incrementally.
