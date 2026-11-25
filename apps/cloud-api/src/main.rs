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
    let trust_proxy_headers = std::env::var("TRUST_PROXY_HEADERS").is_ok_and(|value| value == "1");
    let state = CloudState::new(pool)
        .with_bootstrap_secret(bootstrap_secret)
        .with_trusted_proxy_headers(trust_proxy_headers);
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("cloud API failed");
}
