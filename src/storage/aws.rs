//! Shared AWS configuration resolution for storage clients and SQL sessions.

use aws_config::meta::region::ProvideRegion;
use aws_sdk_s3::config::Region;

use crate::config::{S3Config, S3Credentials};

/// Resolve only the selected storage's profile, keeping explicit overrides
/// and the existing fallback for S3-compatible gateways.
pub(crate) async fn resolve_region(cfg: &S3Config) -> Region {
  match (&cfg.region, &cfg.credentials) {
    (Some(region), _) => Region::new(region.clone()),
    (None, Some(S3Credentials::AwsProfile { profile_name })) => {
      aws_config::profile::ProfileFileRegionProvider::builder()
        .profile_name(profile_name)
        .build()
        .region()
        .await
        .unwrap_or_else(|| Region::new("us-east-1"))
    }
    _ => Region::new("us-east-1"),
  }
}
