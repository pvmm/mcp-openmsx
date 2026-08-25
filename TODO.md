# TODO — mcp-openmsx Improvements

## Checklist

### High Priority

- [x] `debug_memory` `writeBlock` — write a sequence of bytes to consecutive addresses. **DONE**
- [x] `debug_run` `runTo` timeout parameter — prevent infinite block if target address is never reached. Param: `timeoutMs` (optional, default no limit). **DONE**
- [ ] `debug_cpu` `disassemble` structured output — add `format` option (`"text"` | `"structured"`) returning JSON with address, raw bytes, mnemonic, operands.
- [ ] `debug_memory` `readBlock` export to file — add optional `output` parameter to `getBlock` to save hex dump to a file.
- [ ] `debug_memory` `searchBlock` with wildcards — masked byte search (e.g. `3E ?? C3`) using `??` as don't-care.

### Medium Priority

- [ ] `debug_watchpoints` — migrate `create` off the deprecated `debug set_watchpoint` Tcl command to the modern `debug watchpoint create` interface (same pattern as the completed `debug_breakpoints` migration: `-type/-begin/-end` plus optional `-condition`, `-command`, `-once`).

- [ ] `debug_run` `runUntil` condition-based — run until a memory address equals a specific value (e.g. "run until `E073` becomes `02`"). Params: `address`, `value`.
- [ ] `emu_vdp` `getSpriteTable` — read sprite attribute table from VRAM into structured JSON.
- [ ] `emu_vdp` `getNameTable` — read name table from VRAM into structured JSON.
- [ ] `emu_media` disk B: / cartridge slot B support — add `slot` param (`"a"` | `"b"`) to ROM and disk insert/eject commands.
- [ ] `emu_control` `setTrace` — enable/disable execution tracing to file. Params: `enable`, `output` (file path). **BLOCKED: requires openMSX changes**

### Low Priority

- [ ] `emu_keyboard` `sendSequence` — sequential key presses with configurable inter-key delay. Params: `keys` (array), `delayMs`.
- [ ] `emu_info` `getConfiguration` — single call returning machine name, extensions, slot map, I/O map together.
- [ ] `debug_memory` `writeBlock` wrap-around protection — detect and warn if block crosses 0xFFFF boundary.

---

## Full Analysis

### 1. High-Impact Gaps (experienced during reverse engineering)

**`debug_memory` — `writeBlock` missing**
Currently `writeByte` requires individual calls. For patching multiple bytes (e.g., testing code changes), this is painfully slow. A `writeBlock(address, values[])` command would allow bulk memory writes in one call.
**Status**: Done.

**`debug_run` — `runTo` has no timeout**
If the target address is never reached, the command blocks forever. A `timeout` parameter (e.g., `runTo <address> [timeoutMs]`) would prevent hangs.
**Status**: Done.

**`debug_cpu` — `disassemble` returns raw text only**
No structured output (JSON with address, raw bytes, mnemonic, operands). Every consumer must parse the text. A `format` option (`"text"` | `"structured"`) would help.

**`debug_memory` — `readBlock` with offset/length and export**
No way to export a memory block to a file. Useful for ROM/cartridge dumps. Could add an `output` parameter to save to disk.

### 2. Missing Tools for Reverse Engineering

**`debug_memory` — `searchBlock` with wildcards**
Current `searchBytes` finds exact sequences. A wildcard/masked search (e.g., `3E ?? C3`) would help find patterns when bytes vary.

**`debug_run` — `runUntil` condition-based**
Run until a memory address equals a specific value (e.g., "run until address `E073` becomes `02`"). Would save hundreds of breakpoint+continue cycles.

**`emu_vdp` — `getSpriteTable` / `getNameTable`**
No way to read sprite attributes or name tables from VRAM programmatically. Must use raw `readByte` with manual address calculation.

**`emu_media` — disk B: / cartridge slot B support**
Only slot A is supported. Some ROMs use slot B, and disk operations on B: are common.

### 3. Quality-of-Life Enhancements

**`emu_control` — `setTrace`**
Enable/disable execution tracing to file. Essential for debugging without breakpoints.
**Status**: Blocked — requires openMSX changes.

**`emu_keyboard` — `sendSequence` with delays**
`sendKeyCombo` sends keys simultaneously. A sequential key press command with configurable inter-key delay would handle complex input (e.g., BASIC commands, menus).

**`emu_info` — `getConfiguration`**
No single call to get machine name, extensions, slot map, and I/O map together. Currently requires three separate calls.

**`openmsx_tcl_cmd` — structured response parsing**
Currently returns raw text. Could add optional response format hints to auto-parse common output patterns.

### 4. Robustness Issues

**`emu_control` `launch` — no error recovery**
If launch fails (bad machine name, missing ROM), the error is generic. Could provide specific diagnostics.

**`debug_breakpoints` `create` — no validation**
Addresses are not validated before sending to openMSX. Could pre-validate hex format.
**Status**: Done — `create` validates the 4-digit hex address server-side (also covers `remove`'s breakpoint name).
