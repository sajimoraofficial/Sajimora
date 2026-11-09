//! provider.rs — which backend provider lane extracts a module.
//!
//! The Java extractor reads `.java`; the NestJS extractor reads `.ts`. A module
//! that carries Java sources is always Spring, whatever else it contains, so a
//! polyglot repository keeps the lane it had before this dispatch existed. A
//! module with no Java sources is NestJS only when a `*.controller.ts` is
//! present (detection from a revision listing) or a file imports
//! `@nestjs/common` and declares `@Controller` (detection on disk). Anything
//! else keeps the legacy Spring default, which produces an empty, explicitly
//! incomplete artifact rather than silently claiming a provider.

use crate::express_routes::looks_like_express_root;
use crate::nestjs_routes::{is_controller_ts_path, looks_like_nestjs_root};
use crate::revision::BackendScope;
use anyhow::{bail, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// Directories a provider walk never descends into. They hold build output,
/// dependencies, or other checkouts, none of which are this module's source.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "build",
    "out",
    "dist",
    "coverage",
    ".next",
    ".gradle",
    ".idea",
];

/// How many directory entries a provider walk may inspect before it stops
/// looking. Detection only needs to find one Java source; a module that keeps
/// its first `.java` beyond this many entries is not a shape this heuristic was
/// designed for, and the walk failing is not an error.
const DETECT_WALK_BUDGET: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    /// Java / Spring MVC, extracted by `java_routes`.
    Spring,
    /// Java / JAX-RS / Jakarta REST, extracted by `java_routes`.
    JaxRs,
    /// TypeScript / NestJS, extracted by `nestjs_routes`.
    NestJs,
    /// TypeScript / Next.js App Router, extracted by `nextjs_routes`.
    NextJs,
    /// TypeScript / Express, extracted by `express_routes`.
    Express,
    /// TypeScript file-system routers (SvelteKit, Nuxt/Nitro, Remix, Astro),
    /// extracted by `file_system_routes`.
    FileRouter,
}

impl ProviderKind {
    /// The value sealed into `profile.framework_profile`, so an artifact says
    /// which lane produced it.
    pub fn framework_profile(self) -> &'static str {
        match self {
            ProviderKind::Spring => "SPRING_MVC",
            ProviderKind::JaxRs => "JAX_RS",
            ProviderKind::NestJs => "NESTJS",
            ProviderKind::NextJs => "NEXTJS",
            ProviderKind::Express => "EXPRESS",
            ProviderKind::FileRouter => "FILE_ROUTER",
        }
    }

    /// Lower-case name accepted by the CLI.
    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "spring" | "java" => Ok(ProviderKind::Spring),
            "jaxrs" | "jax-rs" | "jakarta" => Ok(ProviderKind::JaxRs),
            "nestjs" | "nest" => Ok(ProviderKind::NestJs),
            "nextjs" | "next" | "next.js" => Ok(ProviderKind::NextJs),
            "express" | "fastify" => Ok(ProviderKind::Express),
            "sveltekit" | "nuxt" | "remix" | "astro" | "file-router" | "file" => {
                Ok(ProviderKind::FileRouter)
            }
            other => bail!(
                "Unknown provider {other:?}; expected auto, spring, jaxrs, nestjs, nextjs, express, sveltekit, nuxt, remix, or astro"
            ),
        }
    }

    /// Detect the lane for a module on disk. Java wins when present; NestJS is
    /// recognised from a controller file that imports `@nestjs/common`.
    pub fn detect_on_disk(root: &Path) -> Self {
        let mut budget = DETECT_WALK_BUDGET;
        if contains_java_source(root, &mut budget) {
            if has_jaxrs_evidence(root) && !has_spring_evidence(root) {
                return ProviderKind::JaxRs;
            }
            return ProviderKind::Spring;
        }
        if crate::nextjs_routes::looks_like_nextjs_root(root)
            || crate::nextjs_routes::looks_like_nextjs_pages_root(root)
        {
            return ProviderKind::NextJs;
        }
        if crate::file_system_routes::looks_like_file_router_root(root) {
            return ProviderKind::FileRouter;
        }
        if looks_like_nestjs_root(root) {
            return ProviderKind::NestJs;
        }
        if looks_like_express_root(root) {
            return ProviderKind::Express;
        }
        ProviderKind::Spring
    }

    /// Detect the lane from a revision listing, so a comparison of two commits
    /// is classified from the commits themselves rather than from whatever the
    /// working tree happens to contain. Paths are repository-relative.
    pub fn detect_in_listing<'a, I>(backend: &BackendScope, paths: I) -> Self
    where
        I: IntoIterator<Item = &'a String>,
    {
        let mut saw_controller = false;
        let mut saw_next_route = false;
        let mut saw_file_router = false;
        for path in paths {
            let Some(scoped) = backend.within(path) else {
                continue;
            };
            if scoped.ends_with(".java") {
                return ProviderKind::Spring;
            }
            if crate::nextjs_routes::is_nextjs_route_file(&scoped) {
                saw_next_route = true;
            }
            if crate::file_system_routes::is_file_router_source_file(&scoped) {
                saw_file_router = true;
            }
            if is_controller_ts_path(&scoped) {
                saw_controller = true;
            }
        }
        if saw_next_route {
            ProviderKind::NextJs
        } else if saw_file_router {
            ProviderKind::FileRouter
        } else if saw_controller {
            ProviderKind::NestJs
        } else {
            ProviderKind::Spring
        }
    }
}

/// TS/JS server frameworks this engine can detect but does not extract.
///
/// Express and Fastify are deliberately absent: both are extracted by the
/// `Express` provider lane, so listing them here would turn a supported
/// backend into an incomplete artifact. A framework that gains a lane must be
/// removed from this list in the same change, or the auto-detect path silently
/// contradicts the explicit `--provider` path.
pub const UNSUPPORTED_TS_FRAMEWORKS: &[(&str, &str)] = &[
    // Hono, Koa, Hapi, Restify, Polka and Elysia are read by the Express lane's
    // router-DSL reader. SvelteKit, Nuxt, Remix and Astro have their own file-system
    // lane. Listing any of them here would contradict the supported path.
    ("h3", "H3"),
    // GraphQL servers expose one operation endpoint, not REST routes. Naming them
    // keeps a GraphQL-only service from sealing as an empty complete REST backend.
    ("@apollo/server", "Apollo Server (GraphQL)"),
    ("apollo-server", "Apollo Server (GraphQL)"),
    ("graphql-yoga", "GraphQL Yoga"),
    ("@graphql-yoga/node", "GraphQL Yoga"),
    // Procedure-style routers expose typed procedures, not REST routes; naming them
    // keeps such a service from sealing as an empty complete REST backend.
    ("@trpc/server", "tRPC"),
    ("@adonisjs/core", "AdonisJS"),
    ("@feathersjs/feathers", "Feathers"),
    ("@loopback/rest", "LoopBack"),
];

/// Detects whether a directory contains evidence of an unsupported TS/JS backend framework
/// (like Express, Fastify, Koa, etc.).
/// Returns `Some((framework_name, matched_file_path))` relative to `root`.
pub fn detect_unsupported_ts_framework(root: &Path) -> Option<(&'static str, String)> {
    let mut candidate_paths = vec![PathBuf::from("package.json")];
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.')
                    || name == "node_modules"
                    || name == "target"
                    || name == "build"
                    || name == "dist"
                {
                    continue;
                }
                let sub_pkg = path.join("package.json");
                if sub_pkg.is_file() {
                    candidate_paths.push(PathBuf::from(&name).join("package.json"));
                }
                // Check 1 level deeper (e.g. apps/api, packages/backend)
                if let Ok(sub_entries) = fs::read_dir(&path) {
                    for sub in sub_entries.flatten() {
                        let sub_path = sub.path();
                        if sub_path.is_dir() {
                            let sub_name = sub.file_name().to_string_lossy().to_string();
                            if !sub_name.starts_with('.')
                                && sub_name != "node_modules"
                                && sub_name != "target"
                                && sub_path.join("package.json").is_file()
                            {
                                candidate_paths.push(
                                    PathBuf::from(&name).join(&sub_name).join("package.json"),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    for rel in &candidate_paths {
        let p = root.join(rel);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if let Ok(content) = fs::read_to_string(&p) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                for (pkg, name) in UNSUPPORTED_TS_FRAMEWORKS {
                    let in_deps = parsed
                        .get("dependencies")
                        .and_then(|d| d.get(*pkg))
                        .is_some();
                    let in_dev = parsed
                        .get("devDependencies")
                        .and_then(|d| d.get(*pkg))
                        .is_some();
                    if in_deps || in_dev {
                        return Some((*name, rel_str));
                    }
                }
            } else {
                for (pkg, name) in UNSUPPORTED_TS_FRAMEWORKS {
                    let needle = format!("\"{}\"", pkg);
                    if content.contains(&needle) {
                        return Some((*name, rel_str));
                    }
                }
            }
        }
    }

    if looks_like_next_pages_router(root) {
        return Some(("Next.js Pages Router", "pages/api".to_string()));
    }

    let mut budget = 512;
    if let Some(found) = scan_source_imports(root, root, &mut budget) {
        return Some(found);
    }

    // A TypeScript/JavaScript backend whose framework this reader does not
    // recognize is still a backend. Returning `None` here would let the Spring
    // lane seal an empty, complete artifact; name the gap instead.
    find_first_ts_source(root).map(|path| ("an unrecognized TypeScript/JavaScript server", path))
}

/// A Next.js Pages Router backend has `pages/api/**` handlers instead of the
/// App Router's `app/**/route.ts`. The extractor only reads the App Router, so
/// the Pages Router must be named as unsupported rather than treated as Spring.
fn looks_like_next_pages_router(root: &Path) -> bool {
    if crate::nextjs_routes::looks_like_nextjs_root(root) {
        return false;
    }
    let package = match fs::read_to_string(root.join("package.json")) {
        Ok(content) => content,
        Err(_) => return false,
    };
    if !package.contains("\"next\"") {
        return false;
    }
    let mut budget = 2048;
    has_pages_api_source(root, &mut budget)
}

fn has_pages_api_source(dir: &Path, budget: &mut usize) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return false;
        }
        *budget -= 1;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != "." && name != ".." {
            continue;
        }
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if has_pages_api_source(&path, budget) {
                return true;
            }
        } else {
            let normalized = path.to_string_lossy().replace('\\', "/");
            let in_pages_api =
                normalized.contains("/pages/api/") || normalized.starts_with("pages/api/");
            if in_pages_api
                && (name.ends_with(".ts")
                    || name.ends_with(".tsx")
                    || name.ends_with(".js")
                    || name.ends_with(".jsx"))
                && !name.ends_with(".d.ts")
            {
                return true;
            }
        }
    }
    false
}

fn find_first_ts_source(root: &Path) -> Option<String> {
    let mut budget = 2048;
    find_first_ts_source_in(root, root, &mut budget)
}

fn find_first_ts_source_in(root: &Path, dir: &Path, budget: &mut usize) -> Option<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    let mut entries: Vec<fs::DirEntry> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if *budget == 0 {
            return None;
        }
        *budget -= 1;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != "." && name != ".." {
            continue;
        }
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if let Some(found) = find_first_ts_source_in(root, &path, budget) {
                return Some(found);
            }
        } else if (name.ends_with(".ts")
            || name.ends_with(".tsx")
            || name.ends_with(".js")
            || name.ends_with(".jsx")
            || name.ends_with(".mts")
            || name.ends_with(".cts")
            || name.ends_with(".mjs")
            || name.ends_with(".cjs"))
            && !name.ends_with(".d.ts")
            && !name.ends_with(".d.mts")
            && !name.ends_with(".d.cts")
        {
            return Some(
                path.strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    None
}

fn scan_source_imports(
    root: &Path,
    dir: &Path,
    budget: &mut usize,
) -> Option<(&'static str, String)> {
    let entries = fs::read_dir(dir).ok()?;
    let mut entries: Vec<fs::DirEntry> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        if *budget == 0 {
            return None;
        }
        *budget -= 1;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != "." && name != ".." {
            continue;
        }
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if let Some(res) = scan_source_imports(root, &path, budget) {
                return Some(res);
            }
        } else if (name.ends_with(".ts")
            || name.ends_with(".js")
            || name.ends_with(".mts")
            || name.ends_with(".cts")
            || name.ends_with(".mjs")
            || name.ends_with(".cjs"))
            && !name.ends_with(".d.ts")
            && !name.ends_with(".d.mts")
            && !name.ends_with(".d.cts")
        {
            if let Ok(content) = fs::read_to_string(&path) {
                for (pkg, name) in UNSUPPORTED_TS_FRAMEWORKS {
                    let import_single = format!("'{}'", pkg);
                    let import_double = format!("\"{}\"", pkg);
                    if content.contains(&import_single) || content.contains(&import_double) {
                        let rel = path
                            .strip_prefix(root)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .replace('\\', "/");
                        return Some((*name, rel));
                    }
                }
            }
        }
    }
    None
}

pub fn has_java_source(dir: &Path) -> bool {
    let mut budget = DETECT_WALK_BUDGET;
    contains_java_source(dir, &mut budget)
}

pub fn contains_java_source(dir: &Path, budget: &mut usize) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut entries: Vec<fs::DirEntry> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if *budget == 0 {
            return false;
        }
        *budget -= 1;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != "." && name != ".." {
            continue;
        }
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if contains_java_source(&path, budget) {
                return true;
            }
        } else if name.ends_with(".java") {
            return true;
        }
    }
    false
}

fn has_jaxrs_evidence(root: &Path) -> bool {
    let mut budget = 256;
    scan_for_needle(
        root,
        &mut budget,
        &["@Path", "jakarta.ws.rs.", "javax.ws.rs."],
    )
}

fn has_spring_evidence(root: &Path) -> bool {
    let mut budget = 256;
    scan_for_needle(
        root,
        &mut budget,
        &[
            "@RestController",
            "@RequestMapping",
            "@Controller",
            "org.springframework.",
        ],
    )
}

fn scan_for_needle(dir: &Path, budget: &mut usize, needles: &[&str]) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return false;
        }
        *budget -= 1;
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if scan_for_needle(&p, budget, needles) {
                return true;
            }
        } else if name.ends_with(".java") {
            if let Ok(content) = fs::read_to_string(&p) {
                for needle in needles {
                    if content.contains(needle) {
                        return true;
                    }
                }
            }
        }
    }
    false
}
