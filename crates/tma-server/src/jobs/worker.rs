//! The worker: one claim loop per queue, woken by NOTIFY (with a short poll as
//! the fallback), plus housekeeping that fires cron schedules, requeues jobs a
//! dead worker left active and purges finished rows.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sqlx::postgres::PgListener;
use tokio::sync::{Notify, Semaphore, watch};

use super::{JobQueue, NOTIFY_CHANNEL, handlers, policy, queues, schedule};
use crate::state::AppState;

const POLL: Duration = Duration::from_secs(2);
/// The longest an idle queue sleeps: NOTIFY wakes it for new work, so this only
/// covers a notification lost while the listener reconnected.
const IDLE_POLL: Duration = Duration::from_secs(30);
const HOUSEKEEPING: Duration = Duration::from_secs(20);
const PURGE_EVERY: u32 = 30;
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

type Wakers = Arc<HashMap<&'static str, Arc<Notify>>>;

/// Run until `shutdown` flips, then let running jobs finish (bounded).
pub async fn run(state: AppState, mut shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
    schedule::register_maintenance(&state.jobs).await?;
    let wakers: Wakers = Arc::new(queues::ALL.iter().map(|q| (*q, Arc::new(Notify::new()))).collect());
    tokio::spawn(listen(state.pool.clone(), wakers.clone(), shutdown.clone()));
    tokio::spawn(housekeeping(state.clone(), shutdown.clone()));

    let mut loops = Vec::new();
    for queue in queues::ALL {
        let slots = policy(queue).concurrency.min(state.config.worker_concurrency.max(1));
        let semaphore = Arc::new(Semaphore::new(slots));
        let waker = wakers.get(queue).cloned().unwrap_or_default();
        loops.push((
            semaphore.clone(),
            slots,
            tokio::spawn(claim_loop(state.clone(), queue, semaphore, waker, shutdown.clone())),
        ));
    }
    tracing::info!(queues = queues::ALL.len(), "Background worker started");
    let _ = shutdown.wait_for(|stop| *stop).await;

    tracing::info!("Worker stopping; waiting for running jobs");
    let drain = async {
        for (semaphore, slots, handle) in loops {
            let _ = handle.await;
            let _ = semaphore.acquire_many(slots as u32).await;
        }
    };
    if tokio::time::timeout(DRAIN_TIMEOUT, drain).await.is_err() {
        tracing::warn!("Some jobs were still running at shutdown; they will be retried after expiry");
    }
    Ok(())
}

async fn claim_loop(
    state: AppState,
    queue: &'static str,
    semaphore: Arc<Semaphore>,
    waker: Arc<Notify>,
    mut shutdown: watch::Receiver<bool>,
) {
    let expire = Duration::from_secs(policy(queue).expire_seconds.max(1) as u64);
    while !*shutdown.borrow() {
        let free = semaphore.available_permits();
        let claimed = if free > 0 {
            state.jobs.claim(queue, free as i64).await.unwrap_or_else(|err| {
                tracing::warn!(queue, error = %err, "Failed to claim jobs");
                Vec::new()
            })
        } else {
            Vec::new()
        };
        let got_work = !claimed.is_empty();
        for job in claimed {
            let Ok(permit) = semaphore.clone().acquire_owned().await else { return };
            let (state, waker) = (state.clone(), waker.clone());
            tokio::spawn(async move {
                let outcome = tokio::time::timeout(expire, handlers::run(&state, &job)).await;
                let result = match outcome {
                    Ok(Ok(output)) => state.jobs.complete(job.id, Some(output)).await,
                    Ok(Err(err)) => {
                        tracing::error!(queue = %job.queue, job_id = %job.id, attempt = job.retry_count + 1, error = %format!("{err:#}"), "Job failed");
                        state.jobs.fail(job.id, &format!("{err:#}")).await
                    }
                    Err(_) => {
                        tracing::error!(queue = %job.queue, job_id = %job.id, "Job timed out");
                        state.jobs.fail(job.id, "job expired").await
                    }
                };
                if let Err(err) = result {
                    tracing::error!(job_id = %job.id, error = %err, "Failed to record job result");
                }
                drop(permit);
                // A finished keyed job may unblock the next one for the same account.
                waker.notify_one();
            });
        }
        if got_work && semaphore.available_permits() > 0 {
            continue;
        }
        // Busy: check back soon. Idle: sleep until the next delayed job instead of polling.
        let wait = if got_work || free == 0 { POLL } else { idle_wait(&state, queue).await };
        tokio::select! {
            _ = waker.notified() => {}
            _ = tokio::time::sleep(wait) => {}
            _ = shutdown.changed() => {}
        }
    }
}

/// How long an idle queue can sleep: until its next delayed job, at most `IDLE_POLL`.
async fn idle_wait(state: &AppState, queue: &str) -> Duration {
    match state.jobs.next_due(queue).await {
        Ok(Some(due)) => (due - chrono::Utc::now()).to_std().unwrap_or(Duration::ZERO).min(IDLE_POLL),
        Ok(None) => IDLE_POLL,
        Err(err) => {
            tracing::warn!(queue, error = %err, "Failed to read the next job time");
            POLL
        }
    }
}

/// Forward `NOTIFY tma_jobs, '<queue>'` to that queue's loop; reconnect on loss.
async fn listen(pool: sqlx::PgPool, wakers: Wakers, mut shutdown: watch::Receiver<bool>) {
    while !*shutdown.borrow() {
        let mut listener = match PgListener::connect_with(&pool).await {
            Ok(l) => l,
            Err(err) => {
                tracing::warn!(error = %err, "Job listener could not connect; polling until it can");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        if let Err(err) = listener.listen(NOTIFY_CHANNEL).await {
            tracing::warn!(error = %err, "Job listener could not LISTEN");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }
        loop {
            tokio::select! {
                message = listener.recv() => match message {
                    Ok(note) => {
                        if let Some(waker) = wakers.get(note.payload()) {
                            waker.notify_one();
                        }
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "Job listener lost its connection");
                        break;
                    }
                },
                _ = shutdown.changed() => return,
            }
        }
    }
}

async fn housekeeping(state: AppState, mut shutdown: watch::Receiver<bool>) {
    let mut ticks = 0u32;
    while !*shutdown.borrow() {
        match schedule::fire_due(&state.pool, &state.jobs).await {
            Ok(n) if n > 0 => tracing::debug!(fired = n, "Fired scheduled jobs"),
            Ok(_) => {}
            Err(err) => tracing::warn!(error = %err, "Failed to fire schedules"),
        }
        match state.jobs.expire_stale().await {
            Ok(n) if n > 0 => tracing::warn!(requeued = n, "Requeued jobs left active past their expiry"),
            Ok(_) => {}
            Err(err) => tracing::warn!(error = %err, "Failed to expire stale jobs"),
        }
        if ticks.is_multiple_of(PURGE_EVERY)
            && let Err(err) = state.jobs.purge_finished().await
        {
            tracing::warn!(error = %err, "Failed to purge finished jobs");
        }
        ticks = ticks.wrapping_add(1);
        tokio::select! {
            _ = tokio::time::sleep(HOUSEKEEPING) => {}
            _ = shutdown.changed() => {}
        }
    }
}

/// Keep the queue-depth gauges current; the process serving `/metrics` runs this.
pub fn spawn_depth_updater(jobs: JobQueue, metrics: crate::services::metrics::Metrics) {
    tokio::spawn(async move {
        loop {
            match jobs.depths().await {
                Ok(rows) => {
                    for queue in queues::ALL {
                        for st in ["created", "failed"] {
                            let depth = rows.iter().find(|(q, s, _)| q == queue && s == st).map(|r| r.2).unwrap_or(0);
                            metrics.set_queue_depth(queue, st, depth);
                        }
                    }
                }
                Err(err) => tracing::debug!(error = %err, "Failed to read queue depths"),
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}
