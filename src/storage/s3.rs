use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{Credentials, Region};
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::operation::get_object::GetObjectError;
use aws_sdk_s3::operation::head_object::HeadObjectError;
use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Error;
use tokio_util::io::ReaderStream;

use super::{
    FileEntry, FileMeta, GetOptions, ListResult, StorageBackend, StorageResponse,
};
use crate::config::S3Config;
use crate::error::AppError;

const LIST_PAGE_SIZE: i32 = 1000;
const CREDENTIAL_PROVIDER_NAME: &str = "omni-stream-config";

/// Map raw S3 HTTP status / error-code combos to AppError variants.
/// `op` ("get" | "head" | "list") is purely for the diagnostic message.
fn classify_s3_status(
    status: u16,
    code: &str,
    op: &str,
    raw: impl std::fmt::Display,
) -> AppError {
    match (status, code) {
        (404, _) | (_, "NoSuchKey") => AppError::NotFound("S3 key not found".into()),
        (403, _) | (_, "AccessDenied") | (_, "Forbidden") => {
            AppError::Forbidden(format!("S3 {op} denied: {raw}"))
        }
        (416, _) | (_, "InvalidRange") => {
            AppError::InvalidRange(format!("S3 {op} range invalid: {raw}"))
        }
        _ => AppError::Backend(format!("S3 {op} error: {raw}")),
    }
}

pub struct S3Backend {
    client: Client,
    bucket: String,
}

impl S3Backend {
    pub async fn new(cfg: &S3Config) -> Result<Self, AppError> {
        if cfg.bucket.trim().is_empty() {
            return Err(AppError::Backend("S3 bucket is required".into()));
        }

        let mut loader = aws_config::defaults(BehaviorVersion::latest());

        // SigV4 requires a region even against MinIO / LocalStack where the
        // server itself doesn't validate it. Fall back to "us-east-1" so users
        // don't have to set AWS_REGION just to talk to a local S3-compatible
        // endpoint.
        let region = cfg
            .region
            .clone()
            .unwrap_or_else(|| "us-east-1".to_string());
        loader = loader.region(Region::new(region));
        let custom_endpoint = cfg.endpoint.is_some();
        if let Some(endpoint) = cfg.endpoint.clone() {
            loader = loader.endpoint_url(endpoint);
        }
        if let (Some(akid), Some(sak)) =
            (cfg.access_key.clone(), cfg.secret_key.clone())
        {
            let creds =
                Credentials::new(akid, sak, None, None, CREDENTIAL_PROVIDER_NAME);
            loader = loader.credentials_provider(creds);
        }

        let shared = loader.load().await;
        // Use path-style addressing whenever a custom endpoint is supplied
        // (MinIO / LocalStack / Ceph need it); virtual-hosted-style on AWS itself.
        let s3_cfg = aws_sdk_s3::config::Builder::from(&shared)
            .force_path_style(custom_endpoint)
            .build();
        let client = Client::from_conf(s3_cfg);

        Ok(Self {
            client,
            bucket: cfg.bucket.clone(),
        })
    }

    fn map_get_err(err: SdkError<GetObjectError>) -> AppError {
        match err {
            SdkError::ServiceError(svc) => {
                if matches!(svc.err(), GetObjectError::NoSuchKey(_)) {
                    return AppError::NotFound("S3 key not found".into());
                }
                let status = svc.raw().status().as_u16();
                let code = svc.err().code().unwrap_or_default();
                classify_s3_status(status, code, "get", svc.err())
            }
            e => AppError::Backend(format!("S3 get sdk error: {e}")),
        }
    }

    fn map_head_err(err: SdkError<HeadObjectError>) -> AppError {
        match err {
            SdkError::ServiceError(svc) => {
                if matches!(svc.err(), HeadObjectError::NotFound(_)) {
                    return AppError::NotFound("S3 key not found".into());
                }
                let status = svc.raw().status().as_u16();
                let code = svc.err().code().unwrap_or_default();
                classify_s3_status(status, code, "head", svc.err())
            }
            e => AppError::Backend(format!("S3 head sdk error: {e}")),
        }
    }

    fn map_list_err(err: SdkError<ListObjectsV2Error>) -> AppError {
        match err {
            SdkError::ServiceError(svc) => {
                let status = svc.raw().status().as_u16();
                let code = svc.err().code().unwrap_or_default();
                classify_s3_status(status, code, "list", svc.err())
            }
            e => AppError::Backend(format!("S3 list sdk error: {e}")),
        }
    }
}

#[async_trait]
impl StorageBackend for S3Backend {
    async fn get_file(
        &self,
        path: &str,
        opts: GetOptions,
    ) -> Result<StorageResponse, AppError> {
        let mut req = self.client.get_object().bucket(&self.bucket).key(path);
        if let Some(range) = opts.range {
            req = req.range(range);
        }
        let resp = req.send().await.map_err(Self::map_get_err)?;

        let content_length = resp.content_length().map(|v| v.max(0) as u64);
        let content_type = resp.content_type().map(str::to_string);
        let etag = resp.e_tag().map(str::to_string);
        let last_modified = resp.last_modified().map(|t| t.to_string());
        let content_range = resp.content_range().map(str::to_string);
        let is_partial = content_range.is_some();

        let reader = resp.body.into_async_read();
        let stream = ReaderStream::new(reader);

        Ok(StorageResponse {
            body: Box::pin(stream),
            content_length,
            content_type,
            etag,
            last_modified,
            content_range,
            is_partial,
        })
    }

    async fn list_files(
        &self,
        prefix: &str,
        token: Option<String>,
    ) -> Result<ListResult, AppError> {
        let mut req = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .delimiter("/")
            .max_keys(LIST_PAGE_SIZE);

        if !prefix.is_empty() {
            req = req.prefix(prefix);
        }
        if let Some(t) = token {
            req = req.continuation_token(t);
        }

        let resp = req
            .send()
            .await
            .map_err(Self::map_list_err)?;

        let mut entries: Vec<FileEntry> = Vec::new();

        for cp in resp.common_prefixes() {
            if let Some(p) = cp.prefix() {
                entries.push(FileEntry {
                    key: p.to_string(),
                    size: 0,
                    last_modified: None,
                    is_dir: true,
                });
            }
        }

        for obj in resp.contents() {
            let Some(key) = obj.key() else { continue };
            entries.push(FileEntry {
                key: key.to_string(),
                size: obj.size().unwrap_or(0).max(0) as u64,
                last_modified: obj.last_modified().map(|t| t.to_string()),
                is_dir: false,
            });
        }

        let next_token = if resp.is_truncated().unwrap_or(false) {
            resp.next_continuation_token().map(str::to_string)
        } else {
            None
        };

        Ok(ListResult {
            entries,
            next_token,
        })
    }

    async fn stat(&self, path: &str) -> Result<FileMeta, AppError> {
        let resp = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(path)
            .send()
            .await
            .map_err(Self::map_head_err)?;

        Ok(FileMeta {
            path: path.to_string(),
            size: resp.content_length().unwrap_or(0).max(0) as u64,
            etag: resp.e_tag().map(str::to_string),
            content_type: resp.content_type().map(str::to_string),
            last_modified: resp.last_modified().map(|t| t.to_string()),
            is_dir: false,
        })
    }
}
