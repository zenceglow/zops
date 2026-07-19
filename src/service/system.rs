use std::sync::Arc;

use crate::domain::system::SystemOverview;
use crate::infrastructure::system::SysInfoProvider;

pub struct SystemService {
    sys: Arc<SysInfoProvider>,
}

impl SystemService {
    pub fn new(sys: Arc<SysInfoProvider>) -> Self {
        Self { sys }
    }

    pub fn overview(&self) -> SystemOverview {
        self.sys.overview()
    }
}
