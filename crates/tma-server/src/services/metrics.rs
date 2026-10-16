//! Prometheus metrics for `/metrics`: process figures, HTTP status classes,
//! audit throughput and job queue depth.

use prometheus::{
    Encoder, Histogram, HistogramOpts, IntCounter, IntCounterVec, IntGauge, IntGaugeVec, Opts, Registry, TextEncoder,
};

#[derive(Clone)]
pub struct Metrics {
    registry: Registry,
    http_requests: IntCounterVec,
    audit_processed: IntCounter,
    audit_failed: IntCounterVec,
    audit_duration: Histogram,
    audit_last: IntGauge,
    queue_depth: IntGaugeVec,
}

impl Metrics {
    pub fn new() -> anyhow::Result<Self> {
        let registry = Registry::new();
        #[cfg(target_os = "linux")]
        registry.register(Box::new(prometheus::process_collector::ProcessCollector::for_self()))?;
        let http_requests =
            IntCounterVec::new(Opts::new("http_requests_total", "HTTP responses by status class"), &["class"])?;
        let audit_processed = IntCounter::new("audit_events_processed_total", "Audit events written to the database")?;
        let audit_failed =
            IntCounterVec::new(Opts::new("audit_events_failed_total", "Audit events that failed"), &["reason"])?;
        let audit_duration = Histogram::with_opts(
            HistogramOpts::new("audit_processing_duration_seconds", "Time to write one audit batch")
                .buckets(vec![0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]),
        )?;
        let audit_last = IntGauge::new("audit_last_processed_timestamp", "Unix time of the last audit write")?;
        let queue_depth = IntGaugeVec::new(
            Opts::new("job_queue_depth", "Jobs waiting or failed, by queue and state"),
            &["queue", "state"],
        )?;
        for c in [
            Box::new(http_requests.clone()) as Box<dyn prometheus::core::Collector>,
            Box::new(audit_processed.clone()),
            Box::new(audit_failed.clone()),
            Box::new(audit_duration.clone()),
            Box::new(audit_last.clone()),
            Box::new(queue_depth.clone()),
        ] {
            registry.register(c)?;
        }
        Ok(Self { registry, http_requests, audit_processed, audit_failed, audit_duration, audit_last, queue_depth })
    }

    pub fn http_request(&self, status: u16) {
        let class = match status {
            100..=199 => "1xx",
            200..=299 => "2xx",
            300..=399 => "3xx",
            400..=499 => "4xx",
            _ => "5xx",
        };
        self.http_requests.with_label_values(&[class]).inc();
    }

    pub fn audit_processed(&self, count: usize, seconds: f64) {
        self.audit_processed.inc_by(count as u64);
        self.audit_duration.observe(seconds);
        self.audit_last.set(chrono::Utc::now().timestamp());
    }

    pub fn audit_failed(&self, count: usize, reason: &str) {
        self.audit_failed.with_label_values(&[reason]).inc_by(count as u64);
    }

    pub fn set_queue_depth(&self, queue: &str, state: &str, depth: i64) {
        self.queue_depth.with_label_values(&[queue, state]).set(depth);
    }

    pub fn render(&self) -> String {
        let mut buf = Vec::new();
        let _ = TextEncoder::new().encode(&self.registry.gather(), &mut buf);
        String::from_utf8(buf).unwrap_or_default()
    }
}
