//! A small seeded generator (splitmix64): enough randomness for picking files
//! and sizes, without a dependency for a test tool.

use std::time::{SystemTime, UNIX_EPOCH};

pub struct Rng(u64);

impl Rng {
    /// Seeded from the clock and `salt`, so each app thread draws differently.
    pub fn new(salt: u64) -> Self {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
        Self(now ^ salt.wrapping_mul(0x9E37_79B9_7F4A_7C15))
    }

    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in `lo..hi` (`lo` when the range is empty).
    pub fn range(&mut self, lo: usize, hi: usize) -> usize {
        if hi <= lo { lo } else { lo + (self.next() % (hi - lo) as u64) as usize }
    }

    /// A float in `0..1`.
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() { None } else { items.get(self.range(0, items.len())) }
    }

    /// Up to `n` distinct items.
    pub fn sample<T: Clone>(&mut self, items: &[T], n: usize) -> Vec<T> {
        let mut order: Vec<usize> = (0..items.len()).collect();
        let take = n.min(order.len());
        for i in 0..take {
            let j = self.range(i, order.len());
            order.swap(i, j);
        }
        order[..take].iter().map(|&i| items[i].clone()).collect()
    }

    /// Bytes of production's size mix: 48% under 100 KB, 38% up to 1 MB, the rest
    /// larger, capped at `cap`. Only the first 4 KiB are random, which is enough.
    pub fn body(&mut self, cap: usize) -> Vec<u8> {
        let roll = self.unit();
        let size = if roll < 0.48 {
            self.range(1_000, 100_000)
        } else if roll < 0.86 {
            self.range(100_000, 1_000_000)
        } else {
            self.range(1_000_000, 4_000_000)
        }
        .min(cap);
        let mut bytes = vec![0u8; size];
        for chunk in bytes[..size.min(4096)].chunks_mut(8) {
            let word = self.next().to_le_bytes();
            chunk.copy_from_slice(&word[..chunk.len()]);
        }
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_stay_in_range_and_samples_are_distinct() {
        let mut rng = Rng::new(7);
        assert!((0..1000).all(|_| (10..20).contains(&rng.range(10, 20))));
        assert_eq!(rng.range(5, 5), 5);
        let mut picked = rng.sample(&(0..100).collect::<Vec<_>>(), 30);
        picked.sort_unstable();
        picked.dedup();
        assert_eq!(picked.len(), 30);
        assert!(rng.body(2_000).len() <= 2_000);
    }
}
