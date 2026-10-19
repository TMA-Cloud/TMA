//! Latency and failures per operation, reported as percentiles.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
pub struct Stats {
    done: Mutex<BTreeMap<&'static str, Vec<u32>>>,
    failed: Mutex<BTreeMap<&'static str, u64>>,
    reasons: Mutex<BTreeMap<String, u64>>,
}

impl Stats {
    pub fn record(&self, op: &'static str, took: Duration) {
        lock(&self.done).entry(op).or_default().push(took.as_millis() as u32);
    }

    /// Time `f`; a failure is counted for `op` with its reason kept for the summary.
    pub fn time<T, E: ToString>(&self, op: &'static str, f: impl FnOnce() -> Result<T, E>) -> Option<T> {
        let start = Instant::now();
        match f() {
            Ok(value) => {
                self.record(op, start.elapsed());
                Some(value)
            }
            Err(err) => {
                *lock(&self.failed).entry(op).or_default() += 1;
                let reason: String = err.to_string().chars().take(120).collect();
                *lock(&self.reasons).entry(format!("{op}: {reason}")).or_default() += 1;
                None
            }
        }
    }

    pub fn report(&self, elapsed: Duration, events: u64) {
        let done = lock(&self.done);
        let failed = lock(&self.failed);
        let total: usize = done.values().map(Vec::len).sum();
        println!(
            "[{:>5.0}s] {total} ok, {} failed, {:.1} req/s, {events} events",
            elapsed.as_secs_f64(),
            failed.values().sum::<u64>(),
            total as f64 / elapsed.as_secs_f64().max(1.0)
        );
        for (op, samples) in done.iter() {
            let mut s = samples.clone();
            s.sort_unstable();
            let at =
                |q: f64| s.get(((s.len() as f64 * q) as usize).min(s.len().saturating_sub(1))).copied().unwrap_or(0);
            println!(
                "  {op:<12} n={:<7} fail={:<5} p50={:>5}ms p95={:>6}ms p99={:>6}ms max={:>6}ms",
                s.len(),
                failed.get(op).copied().unwrap_or(0),
                at(0.5),
                at(0.95),
                at(0.99),
                s.last().copied().unwrap_or(0)
            );
        }
        for (op, n) in failed.iter().filter(|(op, _)| !done.contains_key(*op)) {
            println!("  {op:<12} n=0       fail={n}");
        }
    }

    /// The most common failure reasons.
    pub fn reasons(&self) {
        let reasons = lock(&self.reasons);
        let mut list: Vec<_> = reasons.iter().collect();
        list.sort_by(|a, b| b.1.cmp(a.1));
        for (reason, n) in list.into_iter().take(15) {
            println!("  {n:>6} × {reason}");
        }
    }
}
