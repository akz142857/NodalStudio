use nodalstudio_cloud_api::{CloudState, router};
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let bind = std::env::var("BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .expect("cloud PostgreSQL connection failed");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("cloud migrations failed");
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .expect("cloud API bind failed");
    let bootstrap_secret = std::env::var("BOOTSTRAP_SECRET").ok();
    axum::serve(
        listener,
        router(CloudState::new(pool).with_bootstrap_secret(bootstrap_secret)),
    )
    .await
    .expect("cloud API failed");
}
