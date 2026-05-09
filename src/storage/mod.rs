pub mod local;
pub mod s3;

use std::pin::Pin;

use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;

use crate::error::AppError;

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

#[derive(Debug, Clone, Default)]
pub struct GetOptions {
    pub range: Option<String>,
}

pub struct StorageResponse {
    pub body: ByteStream,
    pub content_length: Option<u64>,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_range: Option<String>,
    pub is_partial: bool,
}

#[derive(Debug, Clone)]
pub struct FileMeta {
    pub path: String,
    pub size: u64,
    pub etag: Option<String>,
    pub content_type: Option<String>,
    pub last_modified: Option<String>,
    pub is_dir: bool,
}

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub key: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ListResult {
    pub entries: Vec<FileEntry>,
    pub next_token: Option<String>,
}

#[async_trait]
pub trait StorageBackend: Send + Sync {
    async fn get_file(&self, path: &str, opts: GetOptions) -> Result<StorageResponse, AppError>;
    async fn list_files(
        &self,
        prefix: &str,
        token: Option<String>,
    ) -> Result<ListResult, AppError>;
    async fn stat(&self, path: &str) -> Result<FileMeta, AppError>;
}
