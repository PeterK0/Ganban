fn main() {
    // The maintainer's built-in bank formats compile in only where their folder is
    // (kept out of the public tree): see `src/finance/import/profiles/mod.rs`.
    println!("cargo:rustc-check-cfg=cfg(finance_pack)");
    println!("cargo:rerun-if-changed=src/finance/import");
    if std::path::Path::new("src/finance/import/pack/mod.rs").exists() {
        println!("cargo:rustc-cfg=finance_pack");
    }
}
