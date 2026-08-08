//! enclave/SET componentizer.
//!
//! Takes the component `wasm-component-ld` links from a
//! `wasm32-wasip2 -pthread` build against the SET-flavored wasi-libc sysroot
//! and wires in the two canonical builtins no linker can express today:
//!
//!   * `thread.spawn-indirect` over the main module's exported
//!     `__indirect_function_table` (a wasm C function pointer IS a table
//!     index, so the libc passes `&wasi_set_thread_start` straight through);
//!   * `thread.available_parallelism`.
//!
//! The libc calls both through VOLATILE function pointers that initially
//! target in-module stubs returning -1 (see wasi-libc's
//! `musl/src/thread/set-threads/set_spawn.c`). This tool APPENDS — it never
//! rewrites the linked module, so no index inside it moves:
//!
//!   1. aliases of the main instance's `__indirect_function_table`,
//!      `__enclave_set_spawn_slot` and `__enclave_set_ap_slot` exports;
//!   2. a plain `(func (param i32))` core type — the spawn start type (the
//!      enclave engine accepts an unshared spawn type; unshared state is
//!      per-execution-view there, i.e. per-thread);
//!   3. the two canonical builtins;
//!   4. a static FIXUP core module that asks the libc which table slots its
//!      stubs occupy and `table.set`s the canonical builtins into exactly
//!      those slots;
//!   5. an instantiation of the fixup, running its `start` after the main
//!      instance exists and before any component export can be called.
//!
//! Execution views rebuild tables from the module's own element segments, so
//! on a SPAWNED thread the patched slot holds the stub again and a nested
//! pthread_create fails with EAGAIN instead of trapping. Intended.
//!
//! The `[set-spawn-indirect]` / `[set-available-parallelism]` import strings
//! below are also the platform's byte-marker: the publish path stamps
//! `set: true` from their presence, the way coop threads are stamped from
//! `[thread-`.

use anyhow::{bail, Context, Result};
use wasm_encoder::{
    Alias, CanonicalFunctionSection, ComponentAliasSection, ComponentSectionId, CoreTypeSection,
    ExportKind, InstanceSection, ModuleArg, RawSection, ValType,
};
use wasmparser::{
    CanonicalFunction, ComponentAlias, ExternalKind, Instance, Parser, Payload,
};

const SPAWN_SLOT_EXPORT: &str = "__enclave_set_spawn_slot";
const AP_SLOT_EXPORT: &str = "__enclave_set_ap_slot";
const TABLE_EXPORT: &str = "__indirect_function_table";

/// The fixup module. Static — identical bytes for every application. The
/// shared `(shared (func ...))` type matches `thread.available_parallelism`'s
/// spec-shaped (shared) synthesized type; `$ap_wrap` re-exposes it as a plain
/// function so it can live in the main module's plain `funcref` table (a
/// plain function may call a shared one; only the reverse is restricted).
const FIXUP_WAT: &str = r#"
(module
  (type $spawnt (func (param i32 i32) (result i32)))
  (type $apt (shared (func (result i32))))
  (type $slot (func (result i32)))
  (import "enclave:set" "[set-spawn-indirect]" (func $spawn (type $spawnt)))
  (import "enclave:set" "[set-available-parallelism]" (func $ap (type $apt)))
  (import "m" "__indirect_function_table" (table $t 1 funcref))
  (import "m" "__enclave_set_spawn_slot" (func $spawn_slot (type $slot)))
  (import "m" "__enclave_set_ap_slot" (func $ap_slot (type $slot)))
  ;; NB: `(type $slot)` is explicit — `wat`'s implicit-type reuse ignores the
  ;; `shared` flag, so an inferred `(result i32)` here would silently pick up
  ;; $apt (shared) and make $ap_wrap unstorable in the plain funcref table.
  (func $ap_wrap (type $slot) (call $ap))
  (elem declare func $spawn $ap_wrap)
  (func $init
    (table.set $t (call $spawn_slot) (ref.func $spawn))
    (table.set $t (call $ap_slot) (ref.func $ap_wrap)))
  (start $init))
"#;

#[derive(Default, Debug)]
struct TopLevelCounts {
    core_modules: u32,
    core_instances: u32,
    core_types: u32,
    core_funcs: u32,
    core_tables: u32,
}

#[derive(Default, Debug)]
struct MainModule {
    /// Top-level core-module index of the module exporting the SET slots.
    module_index: Option<u32>,
    /// Whether that module also exports the indirect function table.
    exports_table: bool,
    /// Top-level core-instance index instantiating it.
    instance_index: Option<u32>,
}

fn scan(bytes: &[u8]) -> Result<(TopLevelCounts, MainModule)> {
    let mut counts = TopLevelCounts::default();
    let mut main = MainModule::default();

    // Depth 0 = the top-level component's sections. Nested core modules bump
    // the depth; their inner sections must not disturb the top-level counts,
    // but their EXPORT sections are how the main module is identified.
    let mut depth = 0usize;
    // While inside a depth-1 core module: its top-level module index.
    let mut inside_module: Option<u32> = None;
    let mut saw_component_header = false;

    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.context("malformed input")?;
        match payload {
            Payload::Version { encoding, .. } => {
                if depth == 0 {
                    if !matches!(encoding, wasmparser::Encoding::Component) {
                        bail!("input is not a component (core module given?)");
                    }
                    saw_component_header = true;
                }
            }
            Payload::ModuleSection { .. } => {
                if depth == 0 {
                    inside_module = Some(counts.core_modules);
                    counts.core_modules += 1;
                }
                depth += 1;
            }
            Payload::ComponentSection { .. } => {
                depth += 1;
            }
            Payload::End(_) => {
                if depth > 0 {
                    depth -= 1;
                    if depth == 0 {
                        inside_module = None;
                    }
                }
            }
            Payload::ExportSection(reader) => {
                // A core module's exports, one level under the component.
                if depth == 1 {
                    if let Some(m) = inside_module {
                        for export in reader {
                            let export = export?;
                            match (export.name, export.kind) {
                                (SPAWN_SLOT_EXPORT, ExternalKind::Func) => {
                                    if let Some(prev) = main.module_index {
                                        if prev != m {
                                            bail!(
                                                "two core modules export {SPAWN_SLOT_EXPORT} \
                                                 (modules {prev} and {m})"
                                            );
                                        }
                                    }
                                    main.module_index = Some(m);
                                }
                                (TABLE_EXPORT, ExternalKind::Table) => {
                                    if main.module_index == Some(m) || main.module_index.is_none() {
                                        main.exports_table = true;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            Payload::InstanceSection(reader) => {
                if depth == 0 {
                    for instance in reader {
                        match instance? {
                            Instance::Instantiate { module_index, .. } => {
                                if Some(module_index) == main.module_index
                                    && main.instance_index.is_none()
                                {
                                    main.instance_index = Some(counts.core_instances);
                                }
                            }
                            Instance::FromExports(_) => {}
                        }
                        counts.core_instances += 1;
                    }
                }
            }
            Payload::CoreTypeSection(reader) => {
                if depth == 0 {
                    counts.core_types += reader.count();
                }
            }
            Payload::ComponentCanonicalSection(reader) => {
                if depth == 0 {
                    for canon in reader {
                        match canon? {
                            // `canon lift` produces a COMPONENT function;
                            // every other canonical produces a core function.
                            CanonicalFunction::Lift { .. } => {}
                            _ => counts.core_funcs += 1,
                        }
                    }
                }
            }
            Payload::ComponentAliasSection(reader) => {
                if depth == 0 {
                    for alias in reader {
                        match alias? {
                            ComponentAlias::CoreInstanceExport { kind, .. } => match kind {
                                ExternalKind::Func => counts.core_funcs += 1,
                                ExternalKind::Table => counts.core_tables += 1,
                                _ => {}
                            },
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if !saw_component_header {
        bail!("input is empty or not a wasm component");
    }
    Ok((counts, main))
}

fn componentize(bytes: &[u8]) -> Result<Vec<u8>> {
    let (counts, main) = scan(bytes)?;

    let Some(main_module) = main.module_index else {
        bail!(
            "no core module exports `{SPAWN_SLOT_EXPORT}` — was this linked against \
             the SET-flavored wasi-libc sysroot (wasip2 + ENABLE_SET_THREADS)?"
        );
    };
    if !main.exports_table {
        bail!(
            "core module {main_module} exports `{SPAWN_SLOT_EXPORT}` but not \
             `{TABLE_EXPORT}` — relink with -Wl,--export-table"
        );
    }
    let Some(main_instance) = main.instance_index else {
        bail!("core module {main_module} is never instantiated at the top level");
    };

    let fixup_bytes = wat::parse_str(FIXUP_WAT).context("internal fixup module is invalid")?;

    // New indices, all appended past the existing top-level index spaces.
    // The fixup reaches the slot getters through the "m" instance argument,
    // so only the TABLE needs a top-level alias (the canon names it).
    let table_idx = counts.core_tables;
    let start_ty = counts.core_types;
    let spawn_canon_fn = counts.core_funcs;
    let ap_canon_fn = counts.core_funcs + 1;
    let fixup_module = counts.core_modules;
    let canon_exports_inst = counts.core_instances;
    let _fixup_inst = counts.core_instances + 1;

    let mut out = bytes.to_vec();

    let mut aliases = ComponentAliasSection::new();
    aliases.alias(Alias::CoreInstanceExport {
        instance: main_instance,
        kind: ExportKind::Table,
        name: TABLE_EXPORT,
    });
    out_section(&mut out, &aliases);

    let mut core_types = CoreTypeSection::new();
    core_types.ty().core().function([ValType::I32], []);
    out_section(&mut out, &core_types);

    let mut canons = CanonicalFunctionSection::new();
    canons.thread_spawn_indirect(start_ty, table_idx);
    canons.thread_available_parallelism();
    out_section(&mut out, &canons);

    out_section(
        &mut out,
        &RawSection {
            id: ComponentSectionId::CoreModule.into(),
            data: &fixup_bytes,
        },
    );

    let mut instances = InstanceSection::new();
    instances.export_items([
        ("[set-spawn-indirect]", ExportKind::Func, spawn_canon_fn),
        ("[set-available-parallelism]", ExportKind::Func, ap_canon_fn),
    ]);
    instances.instantiate(
        fixup_module,
        [
            ("enclave:set", ModuleArg::Instance(canon_exports_inst)),
            ("m", ModuleArg::Instance(main_instance)),
        ],
    );
    out_section(&mut out, &instances);

    Ok(out)
}

fn out_section(out: &mut Vec<u8>, section: &impl wasm_encoder::ComponentSection) {
    section.append_to_component(out);
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (mut input, mut output) = (None, None);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-o" => output = args.next(),
            "-h" | "--help" => {
                eprintln!("usage: set-componentize <component.wasm> [-o out.wasm]");
                return Ok(());
            }
            _ if input.is_none() => input = Some(a),
            _ => bail!("unexpected argument: {a}"),
        }
    }
    let input = input.context("usage: set-componentize <component.wasm> [-o out.wasm]")?;
    let output = output.unwrap_or_else(|| input.clone());

    let bytes = std::fs::read(&input).with_context(|| format!("reading {input}"))?;
    let out = componentize(&bytes)?;
    std::fs::write(&output, out).with_context(|| format!("writing {output}"))?;
    eprintln!("set-componentize: wired thread.spawn-indirect + thread.available_parallelism ({input} -> {output})");
    Ok(())
}
