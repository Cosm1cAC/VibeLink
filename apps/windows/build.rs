use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    // The PNG is the checked-in 512px render of the VibeLink SVG brand mark.
    let source = PathBuf::from("../../public/icons/vibelink-blade-v-512.png");
    let vector_source = PathBuf::from("../../public/icons/vibelink-blade-v.svg");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed={}", vector_source.display());

    let png = fs::read(&source).expect("read VibeLink icon PNG");
    let mut ico = Vec::with_capacity(22 + png.len());
    ico.extend_from_slice(&0u16.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&[0, 0, 0, 0]); // 256x256 PNG icon dimensions and palette fields.
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&32u16.to_le_bytes());
    ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(&png);

    let icon = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("vibelink.ico");
    fs::write(&icon, ico).expect("write VibeLink icon ICO");

    let mut resource = winres::WindowsResource::new();
    resource.set_icon(icon.to_str().expect("icon path is UTF-8"));
    resource
        .compile()
        .expect("compile VibeLink Windows resources");
}
