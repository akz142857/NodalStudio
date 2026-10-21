//! Uses disposable credentials on Windows; separate processes catch mock backends.
#![cfg(target_os = "windows")]

use std::process::Command;

const SERVICE: &str = "com.claycosmos.nodalstudio.windows-test";
const VALUE: &str = "Disposable Windows credential 密码";

#[test]
fn credentials_persist_across_processes() {
    let account = uuid::Uuid::new_v4().to_string();
    let entry = keyring::Entry::new(SERVICE, &account).unwrap();
    let result = std::panic::catch_unwind(|| {
        for stage in ["write", "read", "delete", "missing"] {
            let status = Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "credential_worker", "--nocapture"])
                .env("NODAL_CREDENTIAL_TEST_ACCOUNT", &account)
                .env("NODAL_CREDENTIAL_TEST_STAGE", stage)
                .status()
                .unwrap();
            assert!(status.success(), "credential stage failed: {stage}");
        }
    });
    let _ = entry.delete_credential();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
#[ignore = "subprocess worker invoked by credentials_persist_across_processes"]
fn credential_worker() {
    let account = std::env::var("NODAL_CREDENTIAL_TEST_ACCOUNT").unwrap();
    let entry = keyring::Entry::new(SERVICE, &account).unwrap();
    match std::env::var("NODAL_CREDENTIAL_TEST_STAGE")
        .unwrap()
        .as_str()
    {
        "write" => entry.set_password(VALUE).unwrap(),
        "read" => assert_eq!(entry.get_password().unwrap(), VALUE),
        "delete" => entry.delete_credential().unwrap(),
        "missing" => assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry))),
        stage => panic!("unknown credential test stage: {stage}"),
    }
}
