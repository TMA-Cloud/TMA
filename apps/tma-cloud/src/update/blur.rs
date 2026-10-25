//! A soft blur of the window's picture for the update overlay. egui cannot blur what
//! it has drawn, so the picture is shrunk, box-blurred three times (close to a
//! Gaussian) and drawn stretched with linear filtering, which smooths it further.

use egui::ColorImage;

/// How much the picture is shrunk before blurring; the blur reaches this many times further.
const SHRINK: usize = 4;
/// Box radius at the shrunk size.
const RADIUS: usize = 3;

/// Premultiplied RGBA pixels, row by row.
struct Pixels {
    w: usize,
    h: usize,
    px: Vec<[u8; 4]>,
}

pub fn blur(image: &ColorImage) -> ColorImage {
    let mut small = shrink(image, SHRINK);
    for _ in 0..3 {
        small = box_pass(&small, RADIUS, true);
        small = box_pass(&small, RADIUS, false);
    }
    let bytes: Vec<u8> = small.px.iter().flatten().copied().collect();
    ColorImage::from_rgba_premultiplied([small.w, small.h], &bytes)
}

/// Average each `factor` by `factor` block into one pixel.
fn shrink(image: &ColorImage, factor: usize) -> Pixels {
    let [w, h] = image.size;
    let (sw, sh) = (w.div_ceil(factor).max(1), h.div_ceil(factor).max(1));
    let mut px = Vec::with_capacity(sw * sh);
    for sy in 0..sh {
        for sx in 0..sw {
            let mut sum = [0u32; 4];
            let mut count = 0;
            for y in sy * factor..((sy + 1) * factor).min(h) {
                for x in sx * factor..((sx + 1) * factor).min(w) {
                    add(&mut sum, image.pixels[y * w + x].to_array());
                    count += 1;
                }
            }
            px.push(average(sum, count));
        }
    }
    Pixels { w: sw, h: sh, px }
}

/// One box blur along rows (`horizontal`) or columns, clamping at the edges.
fn box_pass(image: &Pixels, radius: usize, horizontal: bool) -> Pixels {
    let (w, h) = (image.w, image.h);
    let (lines, len) = if horizontal { (h, w) } else { (w, h) };
    let at = |line: usize, i: usize| if horizontal { line * w + i } else { i * w + line };
    let mut px = image.px.clone();
    for line in 0..lines {
        for i in 0..len {
            let mut sum = [0u32; 4];
            let (from, to) = (i.saturating_sub(radius), (i + radius).min(len - 1));
            for j in from..=to {
                add(&mut sum, image.px[at(line, j)]);
            }
            px[at(line, i)] = average(sum, (to - from + 1) as u32);
        }
    }
    Pixels { w, h, px }
}

fn add(sum: &mut [u32; 4], pixel: [u8; 4]) {
    for (s, v) in sum.iter_mut().zip(pixel) {
        *s += u32::from(v);
    }
}

fn average(sum: [u32; 4], count: u32) -> [u8; 4] {
    sum.map(|s| (s / count.max(1)) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(w: usize, h: usize, at: impl Fn(usize, usize) -> u8) -> ColorImage {
        let bytes: Vec<u8> = (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .flat_map(|(x, y)| [at(x, y); 3].into_iter().chain([255]))
            .collect();
        ColorImage::from_rgba_premultiplied([w, h], &bytes)
    }

    #[test]
    fn shrinks_by_the_factor_and_keeps_flat_colour() {
        let flat = blur(&image(100, 37, |_, _| 90));
        assert_eq!(flat.size, [25, 10]);
        assert!(flat.pixels.iter().all(|p| p.to_array() == [90, 90, 90, 255]));
    }

    #[test]
    fn a_hard_edge_turns_into_a_ramp() {
        let edge = blur(&image(120, 8, |x, _| if x < 60 { 0 } else { 255 }));
        let row: Vec<u8> = edge.pixels[..edge.size[0]].iter().map(|p| p.r()).collect();
        assert_eq!(row[0], 0);
        assert_eq!(row[row.len() - 1], 255);
        assert!(row.windows(2).all(|w| w[0] <= w[1]), "the ramp only rises: {row:?}");
        assert!(row.iter().filter(|v| **v > 0 && **v < 255).count() >= 6, "the edge spreads: {row:?}");
    }
}
