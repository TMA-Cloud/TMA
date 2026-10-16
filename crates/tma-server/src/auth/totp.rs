//! TOTP (RFC 6238, SHA-1, 6 digits, 30 s) compatible with authenticator apps
//! and with secrets enrolled by earlier releases (base32, 20 bytes).

use data_encoding::BASE32_NOPAD;
use ring::hmac;

const PERIOD: i64 = 30;
/// RFC 4226 recommends a 160-bit shared secret.
const SECRET_BYTES: usize = 20;
pub const ISSUER: &str = "Cloud Storage";

pub fn generate_secret() -> String {
    BASE32_NOPAD.encode(&crate::crypto::random_bytes::<SECRET_BYTES>())
}

fn decode_secret(secret: &str) -> Option<Vec<u8>> {
    let cleaned: String =
        secret.chars().filter(|c| !c.is_whitespace() && *c != '=').collect::<String>().to_ascii_uppercase();
    BASE32_NOPAD.decode(cleaned.as_bytes()).ok()
}

fn code_at(key: &[u8], step: i64) -> u32 {
    let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, key), &step.to_be_bytes());
    let digest = tag.as_ref();
    let offset = (digest[19] & 0x0f) as usize;
    let bin = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | digest[offset + 3] as u32;
    bin % 1_000_000
}

pub fn current_step() -> i64 {
    chrono::Utc::now().timestamp().div_euclid(PERIOD)
}

/// The time step `token` matches, accepting the current and the previous step
/// only (RFC 6238 §5.2) and never a step at or before `after_step`.
pub fn verify(secret: &str, token: &str, after_step: Option<i64>) -> Option<i64> {
    if token.len() != 6 || !token.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let key = decode_secret(secret)?;
    let wanted: u32 = token.parse().ok()?;
    let now = current_step();
    // A floor ahead of now (the clock moved back) would lock the user out; drop it.
    let floor = after_step.filter(|f| *f <= now);
    [now, now - 1].into_iter().find(|step| floor.is_none_or(|f| *step > f) && code_at(&key, *step) == wanted)
}

/// The otpauth:// URI authenticator apps scan.
pub fn provisioning_uri(secret: &str, label: &str) -> String {
    let enc = crate::util::encode_component;
    format!(
        "otpauth://totp/{}:{}?secret={secret}&period=30&digits=6&algorithm=SHA1&issuer={}",
        enc(ISSUER),
        enc(label),
        enc(ISSUER)
    )
}

/// A PNG data URL of the QR code for `text`.
pub fn qr_data_url(text: &str) -> anyhow::Result<String> {
    use base64::Engine as _;
    let code = qrcode::QrCode::new(text.as_bytes())?;
    let img = code.render::<image::Luma<u8>>().min_dimensions(200, 200).quiet_zone(true).build();
    let mut png = Vec::new();
    image::DynamicImage::ImageLuma8(img).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_sha1_vector() {
        // RFC 6238 Appendix B, SHA-1 key "12345678901234567890", T = 59s -> 94287082 (8 digits) -> 287082.
        assert_eq!(code_at(b"12345678901234567890", 59 / 30), 287_082);
    }

    #[test]
    fn verify_current_code() {
        let secret = generate_secret();
        let key = decode_secret(&secret).unwrap();
        let token = format!("{:06}", code_at(&key, current_step()));
        let step = verify(&secret, &token, None).unwrap();
        assert!(verify(&secret, &token, Some(step)).is_none());
        assert!(verify(&secret, "12345", None).is_none());
    }
}
