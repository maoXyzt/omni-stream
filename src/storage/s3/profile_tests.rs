// Run credential resolution in child processes so AWS environment overrides
// never race with other tests or consult the developer's real profile files.
use super::*;
use std::path::Path;

fn isolated_profiles(test: &str, verify: impl FnOnce(&Path)) {
  const CHILD: &str = "OMNI_PROFILE_TEST_CHILD";
  if let Some(root) = std::env::var_os(CHILD) {
    verify(Path::new(&root));
    return;
  }

  let root = std::env::temp_dir().join(format!(
    "omni-profile-test-{}-{}",
    std::process::id(),
    test.rsplit("::").next().unwrap()
  ));
  std::fs::create_dir_all(&root).unwrap();
  std::fs::write(
    root.join("config"),
    "[profile one]\nregion = us-west-2\n[profile two]\nregion = ap-southeast-1\n[profile no-region]\n",
  )
  .unwrap();
  std::fs::write(
    root.join("credentials"),
    "[one]\naws_access_key_id = TEST_PROFILE_ONE\naws_secret_access_key = fake-secret-one\n[two]\naws_access_key_id = TEST_PROFILE_TWO\naws_secret_access_key = fake-secret-two\n[no-region]\naws_access_key_id = TEST_NO_REGION\naws_secret_access_key = fake-secret-no-region\n",
  )
  .unwrap();
  let output = std::process::Command::new(std::env::current_exe().unwrap())
    .args(["--exact", test, "--include-ignored", "--nocapture"])
    .env(CHILD, &root)
    .env("AWS_CONFIG_FILE", root.join("config"))
    .env("AWS_SHARED_CREDENTIALS_FILE", root.join("credentials"))
    .env("AWS_PROFILE", "nonexistent-default")
    .env("AWS_REGION", "eu-north-1")
    .env("AWS_DEFAULT_REGION", "eu-north-1")
    .env("AWS_ACCESS_KEY_ID", "IGNORED_ENV_KEY")
    .env("AWS_SECRET_ACCESS_KEY", "ignored-env-secret")
    .env("AWS_SESSION_TOKEN", "ignored-env-token")
    .env("AWS_EC2_METADATA_DISABLED", "true")
    .output()
    .unwrap();
  std::fs::remove_dir_all(&root).unwrap();
  assert!(
    output.status.success(),
    "isolated profile test failed:\n{}\n{}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
}

fn profile(name: &str) -> S3Config {
  S3Config {
    bucket: Some("test-bucket".into()),
    credentials: Some(S3Credentials::AwsProfile {
      profile_name: name.into(),
    }),
    // Both environment and old configuration deliberately conflict.
    access_key: Some("IGNORED_LEGACY_KEY".into()),
    secret_key: Some("ignored-legacy-secret".into()),
    ..Default::default()
  }
}

#[test]
fn sdk_resolves_profiles_per_storage() {
  use aws_sdk_s3::primitives::SdkBody;
  use aws_smithy_http_client::test_util::{ReplayEvent, StaticReplayClient};

  fn mock_http(backend: &mut S3Backend, count: usize) -> StaticReplayClient {
    let replay = StaticReplayClient::new(
      (0..count)
        .map(|_| {
          ReplayEvent::new(
            http::Request::builder().body(SdkBody::empty()).unwrap(),
            http::Response::builder()
              .status(200)
              .header("content-length", "0")
              .body(SdkBody::empty())
              .unwrap(),
          )
        })
        .collect(),
    );
    backend.client = Client::from_conf(
      backend
        .client
        .config()
        .to_builder()
        .http_client(replay.clone())
        .build(),
    );
    replay
  }

  isolated_profiles(
    "storage::s3::profile_tests::sdk_resolves_profiles_per_storage",
    |_| {
      tokio::runtime::Runtime::new().unwrap().block_on(async {
        let cfg_one = profile("one");
        let cfg_two = profile("two");
        let (one, two) = tokio::join!(S3Backend::new(&cfg_one), S3Backend::new(&cfg_two));
        let mut one = one.unwrap();
        let mut two = two.unwrap();
        let replay_one = mock_http(&mut one, 2);
        let replay_two = mock_http(&mut two, 1);
        // Real SDK signing, with only HTTP replaced. Revisit the first client
        // after using the second to catch identity leaking between storages.
        for backend in [&one, &two, &one] {
          backend
            .client
            .head_object()
            .bucket("test-bucket")
            .key("test")
            .send()
            .await
            .unwrap();
        }
        for (replay, key, region, count) in [
          (&replay_one, "TEST_PROFILE_ONE", "us-west-2", 2),
          (&replay_two, "TEST_PROFILE_TWO", "ap-southeast-1", 1),
        ] {
          let requests: Vec<_> = replay.actual_requests().collect();
          assert_eq!(requests.len(), count);
          for request in requests {
            let auth = request.headers().get("authorization").unwrap();
            assert!(auth.contains(&format!("Credential={key}/")), "{auth}");
            assert!(
              auth.contains(&format!("/{region}/s3/aws4_request")),
              "{auth}"
            );
            assert!(!auth.contains("IGNORED_"), "{auth}");
          }
        }
        let mut missing = S3Backend::new(&profile("missing")).await.unwrap();
        let replay_missing = mock_http(&mut missing, 0);
        assert!(
          missing
            .client
            .head_object()
            .bucket("test-bucket")
            .key("test")
            .send()
            .await
            .is_err(),
          "missing profile must not fall back to environment or legacy keys"
        );
        assert_eq!(replay_missing.actual_requests().count(), 0);
      });
    },
  );
}

#[test]
fn sdk_profile_region_override_and_fallback() {
  isolated_profiles(
    "storage::s3::profile_tests::sdk_profile_region_override_and_fallback",
    |_| {
      tokio::runtime::Runtime::new().unwrap().block_on(async {
        for (name, configured, expected) in [
          ("one", Some("eu-west-1"), "eu-west-1"),
          ("no-region", None, "us-east-1"),
        ] {
          let mut cfg = profile(name);
          cfg.region = configured.map(str::to_owned);
          let backend = S3Backend::new(&cfg).await.unwrap();
          assert_eq!(backend.client.config().region().unwrap().as_ref(), expected);
        }
        let backend = S3Backend::new(&S3Config::default()).await.unwrap();
        assert_eq!(
          backend.client.config().region().unwrap().as_ref(),
          "us-east-1"
        );
      });
    },
  );
}

#[cfg(feature = "duckdb")]
#[test]
#[ignore = "requires cached DuckDB httpfs/aws extensions or extension download access"]
fn duckdb_resolves_profiles_per_storage() {
  use crate::config::SqlConfig;
  use crate::sql::{SqlTarget, session::setup_statements};

  isolated_profiles(
    "storage::s3::profile_tests::duckdb_resolves_profiles_per_storage",
    |root| {
      let runtime = tokio::runtime::Runtime::new().unwrap();
      let mut connections = Vec::new();
      for (name, key, secret, configured, region) in [
        (
          "one",
          "TEST_PROFILE_ONE",
          "fake-secret-one",
          None,
          "us-west-2",
        ),
        (
          "two",
          "TEST_PROFILE_TWO",
          "fake-secret-two",
          None,
          "ap-southeast-1",
        ),
        (
          "one",
          "TEST_PROFILE_ONE",
          "fake-secret-one",
          Some("eu-west-1"),
          "eu-west-1",
        ),
        (
          "no-region",
          "TEST_NO_REGION",
          "fake-secret-no-region",
          None,
          "us-east-1",
        ),
      ] {
        let config = duckdb::Config::default()
          .with("allow_unredacted_secrets", "true")
          .unwrap();
        let connection = duckdb::Connection::open_in_memory_with_flags(config).unwrap();
        let mut cfg = profile(name);
        cfg.region = configured.map(str::to_owned);
        let setup = runtime
          .block_on(setup_statements(
            &SqlConfig::default(),
            &SqlTarget::S3(cfg),
            root,
          ))
          .unwrap();
        // Execute the production setup, including CREATE SECRET and sandbox.
        connection.execute_batch(&setup).unwrap();
        connections.push((connection, key, secret, region));
      }
      for (connection, key, secret, region) in &connections {
        let resolved: String = connection
          .query_row(
            "SELECT secret_string FROM duckdb_secrets(redact := false) WHERE name = 'omni_query'",
            [],
            |row| row.get(0),
          )
          .unwrap();
        assert!(resolved.contains(key), "{resolved}");
        assert!(resolved.contains(secret), "{resolved}");
        assert!(resolved.contains(&format!("region={region}")), "{resolved}");
        assert!(!resolved.contains("IGNORED_"), "{resolved}");
      }
      let missing = duckdb::Connection::open_in_memory().unwrap();
      let setup = runtime
        .block_on(setup_statements(
          &SqlConfig::default(),
          &SqlTarget::S3(profile("missing")),
          root,
        ))
        .unwrap();
      assert!(missing.execute_batch(&setup).is_err());
    },
  );
}
