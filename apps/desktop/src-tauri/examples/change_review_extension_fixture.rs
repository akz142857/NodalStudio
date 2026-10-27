//! Opt-in synthetic extensions of the isolated native acceptance store. No database connections.
use chrono::Utc;
use snapshot_store::{LocalSnapshotStore, change_review::ReviewRequest};
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("NODAL_REVIEW_ACCEPTANCE").as_deref() != Ok("1") {
        return Err("Explicit acceptance opt-in required".into());
    }
    let path = std::env::args().nth(1).ok_or("Pass isolated store path")?;
    if !path.contains("com.claycosmos.nodalstudio.change-review-p0/") {
        return Err("Refusing non-acceptance store".into());
    }
    let store = LocalSnapshotStore::open_path(path).await?;
    for id in [
        "94cf1fa6-d075-4e5c-9bd8-567064ab3101",
        "94cf1fa6-d075-4e5c-9bd8-567064ab3102",
    ] {
        let source = Uuid::parse_str(id)?;
        let mut snapshot = store
            .latest_snapshot(source)
            .await?
            .ok_or("Seed the original fixture first")?;
        let table = snapshot
            .schemas
            .iter_mut()
            .flat_map(|s| &mut s.tables)
            .find(|t| t.key.name == "orders")
            .ok_or("Missing fixture table")?;
        if table
            .columns
            .iter()
            .any(|c| c.name.starts_with("p0_batch_"))
        {
            return Err("Extension fixture already seeded".into());
        }
        let template = table
            .columns
            .iter()
            .find(|c| c.name == "review_note")
            .ok_or("Missing original acceptance field")?
            .clone();
        for index in 0..125 {
            let mut column = template.clone();
            column.name = format!("p0_batch_{index:03}");
            column.ordinal_position = 100 + index;
            table.columns.push(column);
        }
        snapshot.id = Uuid::new_v4();
        snapshot.captured_at = Utc::now();
        snapshot.canonicalize()?;
        // This is an explicit synthetic UI fixture, not a fresh database capture receipt.
        store.save_snapshot(&snapshot).await?;
        let mut w = store.change_review(source).await?;
        if id.ends_with("3101") {
            for index in 0..58 {
                let item = w
                    .items
                    .iter()
                    .find(|i| i.kind == "annotation")
                    .ok_or("Expected pending statement")?;
                w = store
                    .apply_change_review(&ReviewRequest {
                        source_id: source,
                        revision: w.revision.clone(),
                        prepared_at: Utc::now().to_rfc3339(),
                        operation_id: Uuid::new_v4(),
                        action: "defer".into(),
                        item_key: Some(item.key.clone()),
                        item_keys: vec![],
                        text: Some(format!("Synthetic history pagination fixture {index:02}")),
                    })
                    .await?;
            }
        }
        println!(
            "source={source} structure={} events={}",
            w.items.iter().filter(|i| i.kind == "structure").count(),
            w.events.len()
        );
    }
    store.close().await;
    Ok(())
}
