fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "load_client_backend_settings",
                "save_client_backend_settings",
            ]),
        ),
    )
    .expect("failed to build Tauri application")
}
