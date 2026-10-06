//! Infrastructure: I/O adapters. No HTTP types, no business orchestration.

pub mod caddy;
pub mod db;
pub mod docker;
pub mod fs;
pub mod geoip;
pub mod hostctl;
pub mod notify;
pub mod s3;
pub mod ssh;
pub mod system;
