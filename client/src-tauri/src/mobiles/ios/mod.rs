pub mod badge;

/// 触发IOS选择震动反馈
#[tauri::command]
#[cfg(target_os = "ios")]
pub fn trigger_haptic_feedback() -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_ui_kit::UISelectionFeedbackGenerator;

    if let Some(mtm) = MainThreadMarker::new() {
        let generator = UISelectionFeedbackGenerator::new(mtm);
        generator.prepare();
        generator.selectionChanged();
    };
    Ok(())
}
