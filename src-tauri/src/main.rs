// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by git / ssh as the credential prompt helper: answer and exit without a window.
    if let Some(code) = revqora_lib::askpass::run_helper_if_requested() {
        std::process::exit(code);
    }
    revqora_lib::portable::automation_startup("process-enter");
    revqora_lib::update::launch();
    revqora_lib::portable::automation_startup("portable-environment-start");
    revqora_lib::portable::configure_environment().expect("Cannot write Revqora data beside the executable");
    revqora_lib::portable::automation_startup("portable-environment-ready");
    revqora_lib::update::wait_for_previous_instance();
    revqora_lib::run()
}
