// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if let Some(code) = revqora_lib::update::run_worker() {
        std::process::exit(code);
    }
    if std::env::args_os().len() == 2 && std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--mcp")) {
        if let Err(error) = revqora_lib::mcp::stdio() {
            eprintln!("Revqora MCP: {error}");
            std::process::exit(1);
        }
        return;
    }
    // Started by git / ssh as the credential prompt helper: answer and exit without a window.
    if let Some(code) = revqora_lib::askpass::run_helper_if_requested() {
        std::process::exit(code);
    }
    revqora_lib::portable::automation_startup("process-enter");
    revqora_lib::update::launch();
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = revqora_lib::error_log::record("desktop", "panic", &info.to_string());
        previous_hook(info);
    }));
    revqora_lib::portable::automation_startup("portable-environment-start");
    revqora_lib::portable::configure_environment().expect("Cannot write Revqora data beside the executable");
    revqora_lib::portable::automation_startup("portable-environment-ready");
    revqora_lib::update::wait_for_previous_instance();
    revqora_lib::run()
}
